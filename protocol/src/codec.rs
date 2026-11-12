//! 连接级压缩：多条帧合成一批，用 raw deflate 压缩后作为一条二进制消息发送。
//!
//! 客户端在连接地址里带 [`DEFLATE_QUERY`] 表示能解压；`hubd` 只对这样的连接发二进制批次，
//! 其他连接仍是一帧一条文本消息。整条连接共用一个压缩上下文（每批 `Sync` 刷出），
//! 所以两端都要按收发顺序逐批处理，每条连接各用一个新的编码器和解码器。
//! 帧是 JSON，正文里的换行都已转义，可以直接用 `\n` 分隔。

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// 客户端连接地址里的查询参数。
pub const DEFLATE_QUERY: &str = "z=deflate";

/// 给连接地址加上 [`DEFLATE_QUERY`]；已经带了就原样返回。没有路径时补上 `/`（`ws://h?x` 不是合法地址）。
pub fn with_deflate_query(url: &str) -> String {
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    if query.split('&').any(|part| part == DEFLATE_QUERY) {
        return url.to_string();
    }
    let authority = base.split_once("://").map_or(base, |(_, rest)| rest);
    let slash = if authority.contains('/') { "" } else { "/" };
    if query.is_empty() {
        format!("{base}{slash}?{DEFLATE_QUERY}")
    } else {
        format!("{base}{slash}?{query}&{DEFLATE_QUERY}")
    }
}

/// 请求的查询串里是否要求压缩。
pub fn wants_deflate(query: Option<&str>) -> bool {
    query.is_some_and(|q| q.split('&').any(|part| part == DEFLATE_QUERY))
}

/// 压缩级别。不能用 1：miniz_oxide 的 1 级走快速路径，同步刷新会漏掉一批结尾的数据
/// （真实回放里一批 128KB 少了约 600 字节、没有同步标记，客户端解出半截 JSON；
/// 见测试 `long_mixed_stream_always_flushes_completely`）。实测 8.7MB 回放：3 级压到 1.92MB、
/// 6 级 1.86MB 但耗时近一倍。
const LEVEL: u32 = 3;

pub struct FrameEncoder {
    inner: Compress,
}

impl Default for FrameEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameEncoder {
    pub fn new() -> Self {
        Self {
            inner: Compress::new(Compression::new(LEVEL), false),
        }
    }

    /// 把一批帧编码成一条二进制消息。`frames` 不能为空。
    /// 一直用 `Sync` 调用，直到输入用完且输出缓冲没有写满（zlib 约定的刷新完成条件）。
    pub fn encode<S: AsRef<str>>(&mut self, frames: &[S]) -> Vec<u8> {
        let mut input = Vec::with_capacity(frames.iter().map(|f| f.as_ref().len() + 1).sum());
        for (i, frame) in frames.iter().enumerate() {
            if i > 0 {
                input.push(b'\n');
            }
            input.extend_from_slice(frame.as_ref().as_bytes());
        }
        let mut out = Vec::with_capacity(input.len() / 3 + 64);
        let mut pos = 0;
        loop {
            if out.capacity() - out.len() < 64 {
                out.reserve(out.capacity().max(4096));
            }
            let before = self.inner.total_in();
            self.inner
                .compress_vec(&input[pos..], &mut out, FlushCompress::Sync)
                .expect("压缩内存中的数据不会失败");
            pos += (self.inner.total_in() - before) as usize;
            if pos == input.len() && out.len() < out.capacity() {
                return out;
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct DecodeError;

pub struct FrameDecoder {
    inner: Decompress,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            inner: Decompress::new(false),
        }
    }

    /// 解出一批帧。数据损坏或不是 UTF-8 时返回错误，之后这个解码器不能再用，调用方应断开重连。
    pub fn decode(&mut self, message: &[u8]) -> Result<Vec<String>, DecodeError> {
        let mut out = Vec::with_capacity(message.len() * 4 + 64);
        let mut pos = 0;
        loop {
            if out.capacity() - out.len() < 64 {
                out.reserve(out.capacity().max(4096));
            }
            let before = self.inner.total_in();
            let status = self
                .inner
                .decompress_vec(&message[pos..], &mut out, FlushDecompress::Sync)
                .map_err(|_| DecodeError)?;
            pos += (self.inner.total_in() - before) as usize;
            // 流不会结束（每批只做同步刷新），出现结束标记说明数据不对。
            if status == Status::StreamEnd {
                return Err(DecodeError);
            }
            if pos == message.len() && out.len() < out.capacity() {
                break;
            }
        }
        let text = String::from_utf8(out).map_err(|_| DecodeError)?;
        if text.is_empty() {
            return Err(DecodeError);
        }
        Ok(text.split('\n').map(str::to_string).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(i: usize, body: &str) -> String {
        serde_json::json!({"type": "event", "seq": i, "payload": body}).to_string()
    }

    #[test]
    fn batches_round_trip_in_order_with_shared_context() {
        let mut encoder = FrameEncoder::new();
        let mut decoder = FrameDecoder::new();
        let batches: Vec<Vec<String>> = vec![
            vec![frame(0, "第一条\n带换行")],
            (1..20)
                .map(|i| frame(i, &"重复的内容 ".repeat(i)))
                .collect(),
            vec![frame(20, "")],
        ];
        let mut sizes = Vec::new();
        for batch in &batches {
            let bytes = encoder.encode(batch);
            sizes.push(bytes.len());
            assert_eq!(decoder.decode(&bytes).unwrap(), *batch);
        }
        // 第二批高度重复，压缩后应远小于原文。
        let raw: usize = batches[1].iter().map(String::len).sum();
        assert!(sizes[1] * 4 < raw, "压缩后 {} 字节，原文 {raw}", sizes[1]);
    }

    #[test]
    fn frames_larger_than_the_window_survive() {
        let mut encoder = FrameEncoder::new();
        let mut decoder = FrameDecoder::new();
        // 伪随机内容，压不小，超过 32KB 窗口和 64KB 的内部缓冲。
        let mut x: u32 = 1;
        let noise: String = (0..200_000)
            .map(|_| {
                x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                char::from(b'a' + (x >> 16) as u8 % 26)
            })
            .collect();
        let batch = vec![frame(0, &noise), frame(1, "后面一条")];
        assert_eq!(decoder.decode(&encoder.encode(&batch)).unwrap(), batch);
        let next = vec![frame(2, &noise[..5000])];
        assert_eq!(decoder.decode(&encoder.encode(&next)).unwrap(), next);
    }

    /// 像真实帧那样中等可压缩的内容：从一个随机词表里随机取词。
    fn wordy(len: usize, seed: u32) -> String {
        let mut x = seed;
        let mut next = move || {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            x >> 8
        };
        let vocab: Vec<String> = (0..600)
            .map(|_| {
                (0..3 + next() % 8)
                    .map(|_| char::from(b'a' + (next() % 26) as u8))
                    .collect()
            })
            .collect();
        let mut out = String::with_capacity(len + 16);
        while out.len() < len {
            out.push_str(&vocab[next() as usize % vocab.len()]);
            out.push(' ');
        }
        out
    }

    #[test]
    fn every_batch_ends_with_a_complete_sync_flush() {
        // 曾经的问题：一批压缩后超过 flate2 写入器的 32KB 缓冲时同步刷新不完整，
        // 这一批的结尾要等下一批才到，客户端解出半截 JSON。
        let mut encoder = FrameEncoder::new();
        let mut decoder = FrameDecoder::new();
        for (i, len) in [1_000, 40_000, 130_000, 300_000, 7, 260_000]
            .into_iter()
            .enumerate()
        {
            let batch = vec![frame(i, &wordy(len, i as u32 + 1)), frame(i, "尾")];
            let bytes = encoder.encode(&batch);
            assert!(
                bytes.ends_with(&[0, 0, 0xff, 0xff]),
                "第 {i} 批（{len} 字节）没有完整刷出"
            );
            assert_eq!(decoder.decode(&bytes).unwrap(), batch, "第 {i} 批");
        }
    }

    #[test]
    fn long_mixed_stream_always_flushes_completely() {
        // 见 `LEVEL`：1 级时这个序列的第 56 批刷不完整。批次大小从几十字节到二百多 KB，内容可压缩程度不一。
        let mut encoder = FrameEncoder::new();
        let mut decoder = FrameDecoder::new();
        let mut x: u32 = 7;
        let mut next = move || {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            x >> 8
        };
        for i in 0..80 {
            let count = 1 + next() as usize % 16;
            let batch: Vec<String> = (0..count)
                .map(|j| {
                    let len = match next() % 10 {
                        0 => 30_000 + next() as usize % 200_000,
                        1..=3 => 2_000 + next() as usize % 20_000,
                        _ => 50 + next() as usize % 2_000,
                    };
                    frame(j, &wordy(len, next()))
                })
                .collect();
            let bytes = encoder.encode(&batch);
            assert!(
                bytes.ends_with(&[0, 0, 0xff, 0xff]),
                "第 {i} 批没有完整刷出"
            );
            assert_eq!(decoder.decode(&bytes).unwrap(), batch, "第 {i} 批");
        }
    }

    #[test]
    fn corrupt_data_is_an_error() {
        // 注意：解码器从中间开始解时 miniz 会把缺的历史补零、不报错，所以必须每条连接一个解码器。
        assert_eq!(FrameDecoder::new().decode(b"not deflate"), Err(DecodeError));
        assert_eq!(FrameDecoder::new().decode(&[0xff; 16]), Err(DecodeError));
    }

    #[test]
    fn query_helpers() {
        assert_eq!(
            with_deflate_query("ws://h:7878/ws"),
            "ws://h:7878/ws?z=deflate"
        );
        assert_eq!(
            with_deflate_query("ws://h/ws?a=1"),
            "ws://h/ws?a=1&z=deflate"
        );
        assert_eq!(
            with_deflate_query("ws://h/ws?z=deflate"),
            "ws://h/ws?z=deflate"
        );
        assert_eq!(
            with_deflate_query("ws://127.0.0.1:1"),
            "ws://127.0.0.1:1/?z=deflate"
        );
        assert_eq!(with_deflate_query("ws://h?a=1"), "ws://h/?a=1&z=deflate");
        assert!(wants_deflate(Some("a=1&z=deflate")));
        assert!(!wants_deflate(Some("z=deflatex")));
        assert!(!wants_deflate(None));
    }
}
