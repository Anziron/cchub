import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { formatTokens, Quota, resetWhen } from "./Common";
import { Icon } from "./Icon";
import type { Store } from "./store";
import { addDays, dailySeries, heatmap, hourlySeries, localDate, OTHER, summarize, type Bar, type UsageDay, type UsageMetric, type UsageRange, type UsageSummary } from "./usage";

const RANGES: [UsageRange, string][] = [["today", "今天"], ["7d", "7 天"], ["30d", "30 天"], ["all", "全部"]];
const RANGE_KEY = "cchub.usageRange";
const METRICS: [UsageMetric, string][] = [["tokens", "模型 token"], ["requests", "请求次数"]];
const METRIC_KEY = "cchub.usageMetric";
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

function Heatmap({ days, today }: { days: UsageDay[]; today: string }) {
  const weeks = heatmap(days, today, HEAT_WEEKS);
  const cells = weeks.flat();
  const { tip, handlers } = useTip((i) => {
    const cell = cells[i];
    if (!cell) return null;
    return (
      <>
        <div className="tip-title">{dayTitle(cell.date, today)}</div>
        {cell.value ? <TipRow label="请求" value={`${cell.value} 次`} /> : <div className="tip-empty">没有使用</div>}
      </>
    );
  });
  return (
    <div className="chart">
      <div className="heat" role="img" aria-label={`最近 ${HEAT_WEEKS} 周每天的回复数`} {...handlers}>
        <div className="heat-days" aria-hidden="true">{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
        <div className="heat-grid">
          {cells.map((cell, i) => (cell.future ? <i key={i} className="future" /> : <i key={i} data-i={i} className={`l${cell.level}${cell.date === today ? " today" : ""}`} />))}
        </div>
      </div>
      <ChartTip ref={tip} />
    </div>
  );
}

/**
 * 用量柱状图。“今天”按小时，7 天、30 天按天，“全部”按周；
 * token 按模型堆叠，请求是回复次数。
 */
function Bars({ days, range, today, metric }: { days: UsageDay[]; range: UsageRange; today: string; metric: UsageMetric }) {
  const hourly = range === "today";
  const weekly = range === "all";
  const { keys, bars } = hourly ? hourlySeries(days, today, metric) : dailySeries(days, range, today, metric);
  const max = Math.max(1, ...bars.map((b) => b.total));
  const now = new Date().getHours();
  const value = (n: number) => (metric === "requests" ? `${n} 次` : formatTokens(n));
  const color = (key: string, k: number) => (metric === "requests" ? "var(--series-1)" : seriesColor(key, k));
  const { tip, handlers } = useTip((i) => {
    const bar = bars[i];
    const title = hourly ? `今天 ${i}:00–${i + 1}:00` : weekly ? `${shortDate(bar.label)} 起的一周` : dayTitle(bar.label, today);
    return (
      <>
        <div className="tip-title">{title}</div>
        {metric === "requests" ? (
          <TipRow label="请求" value={value(bar.total)} />
        ) : (
          <>
            <TipRow label="合计" value={`${formatTokens(bar.total)} token`} />
            {keys.map((key, k) => (bar.values[key] ? <TipRow key={key} color={color(key, k)} label={key} value={formatTokens(bar.values[key])} /> : null))}
          </>
        )}
      </>
    );
  });
  if (!keys.length) return <p className="empty">这段时间没有使用。</p>;
  const current = (bar: Bar, i: number) => (hourly ? i === now : bar.label === today);
  return (
    <div className="chart">
      <div className="bars" role="img" aria-label={metric === "requests" ? "请求次数" : "token 用量，按模型堆叠"} {...handlers}>
        <span className="bars-max">{value(max)}</span>
        {bars.map((bar, i) => (
          <div key={bar.label} className={`bar${current(bar, i) ? " today" : ""}${hourly && i > now ? " future" : ""}`} data-i={i}>
            <div className="stack" style={{ height: `${(bar.total / max) * 100}%` }}>
              {keys.map((key, k) => (bar.values[key] ? <i key={key} style={{ flexGrow: bar.values[key], background: color(key, k) }} /> : null))}
            </div>
          </div>
        ))}
      </div>
      {hourly
        ? <div className="bars-axis"><span>0 点</span><span>12 点</span><span>23 点</span></div>
        : <div className="bars-axis"><span>{shortDate(bars[0].label)}</span><span>{weekly ? "按周" : "今天"}</span></div>}
      {metric === "tokens" ? <div className="legend">{keys.map((key, i) => <span key={key}><i style={{ background: seriesColor(key, i) }} />{key}</span>)}</div> : null}
      <ChartTip ref={tip} />
    </div>
  );
}

const VIEWS: [ModelView, string][] = [["tokens", "token"], ["cost", "费用"]];
const VIEW_KEY = "cchub.usageModelView";
type ModelView = "tokens" | "cost";

/** 美元金额：小额多留两位小数。 */
const dollars = (n: number) => `$${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)}`;

/** 常用模型：可切换 token 和按 API 标价折算的费用。 */
function ModelRanking({ models }: { models: UsageSummary["models"] }) {
  const [view, setViewState] = useState<ModelView>(() => (localStorage.getItem(VIEW_KEY) === "cost" ? "cost" : "tokens"));
  const setView = (value: ModelView) => {
    setViewState(value);
    localStorage.setItem(VIEW_KEY, value);
  };
  if (!models.length) return null;
  const totalCost = models.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  // 颜色和柱状图一致：按 token 排名，前 3 个用系列色，其余灰色。切到费用时颜色跟着模型走，不跟名次。
  const color = new Map(models.map((m, i) => [m.key, i < 3 ? `var(--series-${i + 1})` : "var(--faint)"]));
  const rows = view === "tokens"
    ? models.slice(0, 5).map((m) => ({ key: m.key, name: m.name, share: m.share, value: formatTokens(m.tokens) }))
    : [...models].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)).slice(0, 5).map((m) => ({
      key: m.key, name: m.name, share: totalCost && m.cost ? m.cost / totalCost : 0, value: m.cost == null ? "—" : dollars(m.cost),
    }));
  const top = rows[0]?.share || 1;
  return (
    <>
      <h4 className="rank-head">
        常用模型
        {view === "cost" ? <span className="tag" title="按 API 标价折算（缓存写入按 1 小时价），订阅用户实际不按这个付费">合计 {dollars(totalCost)}</span> : null}
        <span className="seg small">
          {VIEWS.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={view === value} className={view === value ? "on" : undefined} onClick={() => setView(value)}>{label}</button>
          ))}
        </span>
      </h4>
      {/* 总占比条：一眼看出谁占大头 */}
      <div className="share-bar" aria-hidden="true">
        {rows.map((row) => (row.share > 0 ? <i key={row.key} style={{ flexGrow: row.share, background: color.get(row.key) }} /> : null))}
      </div>
      <div className="rank">
        {rows.map((row) => (
          <div key={row.key} className="rank-row" title={row.key || undefined}>
            <span className="rank-name"><i style={{ background: color.get(row.key) }} />{row.name}</span>
            {/* 条长相对第一名，看得出差距；百分比是占总量的比例 */}
            <span className="rank-bar"><i style={{ width: `${Math.max(2, (row.share / top) * 100)}%`, background: color.get(row.key) }} /></span>
            <span className="rank-pct">{row.share > 0 ? `${row.share >= 0.995 ? 100 : (row.share * 100).toFixed(row.share < 0.1 ? 1 : 0)}%` : ""}</span>
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
  const [metric, setMetricState] = useState<UsageMetric>(() => (localStorage.getItem(METRIC_KEY) === "requests" ? "requests" : "tokens"));
  const setMetric = (value: UsageMetric) => {
    setMetricState(value);
    localStorage.setItem(METRIC_KEY, value);
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
          <div className="usage-sum parts">
            <div><b>{formatTokens(summary.parts.input)}</b><span>输入</span></div>
            <div><b>{formatTokens(summary.parts.output)}</b><span>输出</span></div>
            <div><b>{formatTokens(summary.parts.cacheWrite)}</b><span>缓存写入</span></div>
            <div><b>{formatTokens(summary.parts.cacheRead)}</b><span>缓存读取</span></div>
          </div>
          <div className="chart-head">
            <div className="seg small" role="radiogroup" aria-label="柱状图显示">
              {METRICS.map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={metric === value} className={metric === value ? "on" : undefined} onClick={() => setMetric(value)}>{label}</button>
              ))}
            </div>
          </div>
          {!summary.messages ? <p className="empty">这段时间没有使用。</p> : <Bars days={stats.days} range={range} today={today} metric={metric} />}
          <h4 className="heat-head">
            活跃
            <span className="tag" title={`${RANGES.find(([r]) => r === range)?.[1]}内有使用的天数`}>活跃 {summary.activeDays} 天</span>
            <span className="tag" title="到今天（今天还没用就到昨天）为止连续有使用的天数">连续 {summary.streak} 天</span>
          </h4>
          <Heatmap days={stats.days} today={today} />
          <ModelRanking models={summary.models} />
        </>
      )}
    </>
  );
}
