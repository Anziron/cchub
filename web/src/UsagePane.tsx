import { useEffect, useState } from "react";
import { formatTokens, Quota, resetWhen } from "./Common";
import { Icon } from "./Icon";
import type { Store } from "./store";
import { dailySeries, heatmap, localDate, OTHER, summarize, type UsageDay, type UsageRange } from "./usage";

const RANGES: [UsageRange, string][] = [["7d", "7 天"], ["30d", "30 天"], ["all", "全部"]];
const RANGE_KEY = "cchub.usageRange";
const HEAT_WEEKS = 18;
const WEEKDAYS = ["一", "", "三", "", "五", "", "日"];

const shortDate = (date: string) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;
const seriesColor = (key: string, i: number) => (key === OTHER ? "var(--faint)" : `var(--series-${i + 1})`);

function storedRange(): UsageRange {
  const value = localStorage.getItem(RANGE_KEY);
  return RANGES.some(([r]) => r === value) ? (value as UsageRange) : "30d";
}

function ago(seconds: number): string {
  const minutes = Math.floor((Date.now() / 1000 - seconds) / 60);
  return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

function Heatmap({ days, today }: { days: UsageDay[]; today: string }) {
  const weeks = heatmap(days, today, HEAT_WEEKS);
  return (
    <div className="heat" role="img" aria-label={`最近 ${HEAT_WEEKS} 周每天的回复数`}>
      <div className="heat-days" aria-hidden="true">{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="heat-grid">
        {weeks.map((week, w) => week.map((cell, i) => (
          cell ? <i key={`${w}-${i}`} className={`l${cell.level}`} title={`${cell.date} · ${cell.value} 条回复`} /> : <i key={`${w}-${i}`} className="none" />
        )))}
      </div>
    </div>
  );
}

function Bars({ days, range, today }: { days: UsageDay[]; range: UsageRange; today: string }) {
  const { keys, bars } = dailySeries(days, range, today);
  const max = Math.max(1, ...bars.map((b) => b.total));
  if (!keys.length) return null;
  return (
    <>
      <div className="bars" role="img" aria-label={range === "all" ? "每周 token 用量，按模型堆叠" : "每天 token 用量，按模型堆叠"}>
        <span className="bars-max">{formatTokens(max)}</span>
        {bars.map((bar) => (
          <div
            key={bar.label}
            className="bar"
            title={[`${bar.label}${range === "all" ? " 这周" : ""} · ${formatTokens(bar.total)}`, ...keys.filter((k) => bar.values[k]).map((k) => `${k} ${formatTokens(bar.values[k])}`)].join("\n")}
          >
            <div className="stack" style={{ height: `${(bar.total / max) * 100}%` }}>
              {keys.map((key, i) => (bar.values[key] ? <i key={key} style={{ flexGrow: bar.values[key], background: seriesColor(key, i) }} /> : null))}
            </div>
          </div>
        ))}
      </div>
      <div className="bars-axis"><span>{shortDate(bars[0].label)}</span><span>{range === "all" ? "按周" : "今天"}</span></div>
      <div className="legend">{keys.map((key, i) => <span key={key}><i style={{ background: seriesColor(key, i) }} />{key}</span>)}</div>
    </>
  );
}

function Ranking({ title, rows }: { title: string; rows: { key: string; name: string; share: number; value: string }[] }) {
  if (!rows.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <div className="rank">
        {rows.map((row) => (
          <div key={row.key} className="rank-row" title={row.key || undefined}>
            <span className="rank-name">{row.name}</span>
            <span className="rank-bar"><i style={{ width: `${Math.max(2, row.share * 100)}%` }} /></span>
            <span className="num">{row.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 使用情况：额度，以及服务器上全部会话记录的统计（由 `cchub-usage` 生成）。 */
export function UsagePane({ store }: { store: Store }) {
  const [range, setRangeState] = useState<UsageRange>(storedRange);
  const setRange = (value: UsageRange) => {
    setRangeState(value);
    localStorage.setItem(RANGE_KEY, value);
  };
  useEffect(() => store.requestUsage(), [store]);
  const { stats, error, loading } = store.usage;
  const { fiveHour, sevenDay } = store.limits;
  const today = localDate(new Date());
  const summary = stats ? summarize(stats.days, range, today) : null;
  return (
    <>
      <h4>额度</h4>
      <Quota label="5 小时" window={fiveHour} />
      {fiveHour ? <p className="usage-reset">{resetWhen(fiveHour)}</p> : null}
      <Quota label="本周" window={sevenDay} />
      {sevenDay ? <p className="usage-reset">{resetWhen(sevenDay)}</p> : null}

      <div className="usage-head">
        <div className="seg" role="radiogroup" aria-label="统计范围">
          {RANGES.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={range === value} className={range === value ? "on" : undefined} onClick={() => setRange(value)}>{label}</button>
          ))}
        </div>
        <button type="button" className="icon" aria-label="重新统计" title={stats ? `${ago(stats.generatedAt)}统计，点击重新统计` : "重新统计"} disabled={loading} onClick={() => store.requestUsage()}>
          <Icon name="reset" size={13} className={loading ? "spin" : undefined} />
        </button>
      </div>
      {error ? <p className="usage-error">{error}</p> : null}
      {!stats || !summary ? (
        <p className="empty">{loading ? "正在统计服务器上的会话记录，第一次要几秒…" : error ? "" : "还没有数据"}</p>
      ) : (
        <>
          <div className="usage-sum">
            <div><b>{summary.sessions}</b><span>会话</span></div>
            <div><b>{summary.messages}</b><span>回复</span></div>
            <div title="input + output + 缓存写入，不含缓存读取"><b>{formatTokens(summary.tokens)}</b><span>token</span></div>
            <div><b>{summary.activeDays}</b><span>活跃天数</span></div>
            <div><b>{summary.streak}</b><span>连续天数</span></div>
            <div><b>{summary.peakHour == null ? "—" : `${summary.peakHour}–${summary.peakHour + 1}`}</b><span>高峰时段（点）</span></div>
          </div>
          <h4>{range === "all" ? "每周用量" : "每日用量"}</h4>
          {summary.messages ? <Bars days={stats.days} range={range} today={today} /> : <p className="empty">这段时间没有使用。</p>}
          <h4>活跃</h4>
          <Heatmap days={stats.days} today={today} />
          <Ranking title="常用模型" rows={summary.models.slice(0, 5).map((m) => ({ key: m.key, name: m.name, share: m.share, value: formatTokens(m.tokens) }))} />
          <Ranking title="常用项目" rows={summary.projects.slice(0, 5).map((p) => ({ key: p.key, name: p.name, share: p.share, value: `${p.messages}` }))} />
          <p className="help">统计服务器上所有 Claude Code 会话，包括在终端里直接用的。token 不含缓存读取。</p>
        </>
      )}
    </>
  );
}
