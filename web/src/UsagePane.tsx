import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { formatTokens, Quota, resetWhen } from "./Common";
import { Icon } from "./Icon";
import type { Store } from "./store";
import { addDays, dailySeries, dayTokens, heatmap, hourlySeries, localDate, OTHER, summarize, type TokenParts, type UsageDay, type UsageRange } from "./usage";

const RANGES: [UsageRange, string][] = [["today", "今天"], ["7d", "7 天"], ["30d", "30 天"], ["all", "全部"]];
const RANGE_KEY = "cchub.usageRange";
const HEAT_WEEKS = 18;
const WEEKDAYS = ["一", "", "三", "", "五", "", "日"];
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const shortDate = (date: string) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;
const seriesColor = (key: string, i: number) => (key === OTHER ? "var(--faint)" : `var(--series-${i + 1})`);

/** `2026-11-11` → `11月11日 周三`，今天加标记。 */
function dayTitle(date: string, today: string): string {
  const weekday = WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const tag = date === today ? " · 今天" : date === addDays(today, -1) ? " · 昨天" : "";
  return `${+date.slice(5, 7)}月${+date.slice(8, 10)}日 ${weekday}${tag}`;
}

function storedRange(): UsageRange {
  const value = localStorage.getItem(RANGE_KEY);
  return RANGES.some(([r]) => r === value) ? (value as UsageRange) : "30d";
}

function ago(seconds: number): string {
  const minutes = Math.floor((Date.now() / 1000 - seconds) / 60);
  return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

interface TipApi {
  show(target: Element, content: ReactNode): void;
  hide(): void;
}

/**
 * 图表的悬停浮层。图表只在容器上做事件委托，浮层自己持有状态：悬停时只有浮层重画，
 * 几百个格子不跟着重画。默认在格子上方，上方被窗格顶部挡住时放到下方，水平方向不超出容器。
 */
const ChartTip = forwardRef<TipApi>(function ChartTip(_, ref) {
  const [tip, setTip] = useState<{ target: Element; content: ReactNode } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // 同步更新：鼠标移到哪格浮层立刻跟上，不排进 React 的异步调度。只重画浮层本身，代价很小。
  useImperativeHandle(ref, () => ({
    show: (target, content) => flushSync(() => setTip({ target, content })),
    hide: () => flushSync(() => setTip(null)),
  }), []);
  useLayoutEffect(() => {
    const el = box.current;
    const host = el?.parentElement;
    if (!el || !host || !tip) return;
    const h = host.getBoundingClientRect();
    const t = tip.target.getBoundingClientRect();
    const top = el.closest(".pane-body")?.getBoundingClientRect().top ?? 0;
    const left = Math.max(0, Math.min(t.left + t.width / 2 - h.left - el.offsetWidth / 2, h.width - el.offsetWidth));
    const above = t.top - el.offsetHeight - 6 >= top;
    el.style.transform = `translate(${left}px, ${above ? t.top - h.top - el.offsetHeight - 6 : t.bottom - h.top + 6}px)`;
    el.style.visibility = "visible";
  }, [tip]);
  if (!tip) return null;
  return <div ref={box} className="chart-tip" role="tooltip" style={{ visibility: "hidden" }}>{tip.content}</div>;
});

/** 容器上的事件委托：找最近的 `data-i`，交给 `render` 生成浮层内容。 */
function useTip(render: (index: number) => ReactNode) {
  const tip = useRef<TipApi>(null);
  const current = useRef<Element | null>(null);
  const onMouseOver = (event: MouseEvent) => {
    const target = (event.target as Element).closest("[data-i]");
    if (target === current.current) return;
    current.current = target;
    if (target) tip.current?.show(target, render(Number(target.getAttribute("data-i"))));
    else tip.current?.hide();
  };
  const onMouseLeave = () => {
    current.current = null;
    tip.current?.hide();
  };
  return { tip, handlers: { onMouseOver, onMouseLeave } };
}

function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return <div className="tip-row">{color ? <i style={{ background: color }} /> : null}<span>{label}</span><b>{value}</b></div>;
}

/** 四项明细，浮层里用。 */
function PartRows({ parts }: { parts: TokenParts }) {
  return (
    <>
      <TipRow label="输入" value={formatTokens(parts.input)} />
      <TipRow label="输出" value={formatTokens(parts.output)} />
      <TipRow label="缓存写入" value={formatTokens(parts.cacheWrite)} />
      <TipRow label="缓存读取" value={formatTokens(parts.cacheRead)} />
    </>
  );
}

function Heatmap({ days, today }: { days: UsageDay[]; today: string }) {
  const weeks = heatmap(days, today, HEAT_WEEKS);
  const cells = weeks.flat();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const { tip, handlers } = useTip((i) => {
    const cell = cells[i];
    if (!cell) return null;
    const day = byDate.get(cell.date);
    return (
      <>
        <div className="tip-title">{dayTitle(cell.date, today)}</div>
        {cell.value ? (
          <>
            <TipRow label="回复" value={`${cell.value} 条`} />
            {day ? <TipRow label="会话" value={`${day.sessions} 个`} /> : null}
            {day ? <TipRow label="token" value={formatTokens(dayTokens(day))} /> : null}
            {day ? <PartRows parts={day} /> : null}
          </>
        ) : <div className="tip-empty">没有使用</div>}
      </>
    );
  });
  return (
    <div className="chart">
      <div className="heat" role="img" aria-label={`最近 ${HEAT_WEEKS} 周每天的回复数`} {...handlers}>
        <div className="heat-days" aria-hidden="true">{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
        <div className="heat-grid">
          {cells.map((cell, i) => (cell ? <i key={i} data-i={i} className={`l${cell.level}${cell.date === today ? " today" : ""}`} /> : <i key={i} className="none" />))}
        </div>
      </div>
      <ChartTip ref={tip} />
    </div>
  );
}

function Bars({ days, range, today }: { days: UsageDay[]; range: UsageRange; today: string }) {
  const { keys, bars } = dailySeries(days, range, today);
  const max = Math.max(1, ...bars.map((b) => b.total));
  const weekly = range === "all";
  const { tip, handlers } = useTip((i) => {
    const bar = bars[i];
    return (
      <>
        <div className="tip-title">{weekly ? `${shortDate(bar.label)} 起的一周` : dayTitle(bar.label, today)}</div>
        <TipRow label="合计" value={`${formatTokens(bar.total)} token`} />
        <PartRows parts={bar.parts} />
        {keys.map((key, k) => (bar.values[key] ? <TipRow key={key} color={seriesColor(key, k)} label={key} value={formatTokens(bar.values[key])} /> : null))}
      </>
    );
  });
  if (!keys.length) return null;
  return (
    <div className="chart">
      <div className="bars" role="img" aria-label={weekly ? "每周 token 用量，按模型堆叠" : "每天 token 用量，按模型堆叠"} {...handlers}>
        <span className="bars-max">{formatTokens(max)}</span>
        {bars.map((bar, i) => (
          <div key={bar.label} className={`bar${bar.label === today ? " today" : ""}`} data-i={i}>
            <div className="stack" style={{ height: `${(bar.total / max) * 100}%` }}>
              {keys.map((key, k) => (bar.values[key] ? <i key={key} style={{ flexGrow: bar.values[key], background: seriesColor(key, k) }} /> : null))}
            </div>
          </div>
        ))}
      </div>
      <div className="bars-axis"><span>{shortDate(bars[0].label)}</span><span>{weekly ? "按周" : "今天"}</span></div>
      <div className="legend">{keys.map((key, i) => <span key={key}><i style={{ background: seriesColor(key, i) }} />{key}</span>)}</div>
      <ChartTip ref={tip} />
    </div>
  );
}

/** “今天”：每小时的回复数。 */
function HourBars({ days, today }: { days: UsageDay[]; today: string }) {
  const hours = hourlySeries(days, today);
  const max = Math.max(1, ...hours);
  const now = new Date().getHours();
  const { tip, handlers } = useTip((h) => (
    <>
      <div className="tip-title">今天 {h}:00–{h + 1}:00</div>
      <TipRow label="回复" value={`${hours[h]} 条`} />
    </>
  ));
  return (
    <div className="chart">
      <div className="bars" role="img" aria-label="今天每小时的回复数" {...handlers}>
        <span className="bars-max">{max} 条</span>
        {hours.map((value, h) => (
          <div key={h} className={`bar${h === now ? " today" : ""}${h > now ? " future" : ""}`} data-i={h}>
            <div className="stack" style={{ height: `${(value / max) * 100}%` }}>{value ? <i style={{ flexGrow: 1, background: "var(--series-1)" }} /> : null}</div>
          </div>
        ))}
      </div>
      <div className="bars-axis"><span>0 点</span><span>12 点</span><span>23 点</span></div>
      <ChartTip ref={tip} />
    </div>
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
            <div title="输入 + 输出 + 缓存写入 + 缓存读取"><b>{formatTokens(summary.tokens)}</b><span>token</span></div>
            <div><b>{summary.activeDays}</b><span>活跃天数</span></div>
            <div><b>{summary.streak}</b><span>连续天数</span></div>
            <div><b>{summary.peakHour == null ? "—" : `${summary.peakHour}–${summary.peakHour + 1}`}</b><span>高峰时段（点）</span></div>
          </div>
          <div className="usage-sum parts">
            <div><b>{formatTokens(summary.parts.input)}</b><span>输入</span></div>
            <div><b>{formatTokens(summary.parts.output)}</b><span>输出</span></div>
            <div><b>{formatTokens(summary.parts.cacheWrite)}</b><span>缓存写入</span></div>
            <div><b>{formatTokens(summary.parts.cacheRead)}</b><span>缓存读取</span></div>
          </div>
          <h4>{range === "today" ? "今天每小时" : range === "all" ? "每周用量" : "每日用量"}</h4>
          {!summary.messages ? <p className="empty">这段时间没有使用。</p> : range === "today" ? <HourBars days={stats.days} today={today} /> : <Bars days={stats.days} range={range} today={today} />}
          <h4>活跃</h4>
          <Heatmap days={stats.days} today={today} />
          <Ranking title="常用模型" rows={summary.models.slice(0, 5).map((m) => ({ key: m.key, name: m.name, share: m.share, value: formatTokens(m.tokens) }))} />
          <Ranking title="常用项目" rows={summary.projects.slice(0, 5).map((p) => ({ key: p.key, name: p.name, share: p.share, value: `${p.messages}` }))} />
        </>
      )}
    </>
  );
}
