import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { formatTokens, quotaPercent, resetText, resetWhen } from "./Common";
import { Icon } from "./Icon";
import type { Store } from "./store";
import { addDays, dailySeries, heatmap, hourlySeries, localDate, modelLabel, OTHER, previousParts, quotaPace, summarize, type Bar, type TokenParts, type UsageDay, type UsageMetric, type UsageRange, type UsageSummary } from "./usage";

const RANGES: [UsageRange, string][] = [["today", "今天"], ["7d", "7 天"], ["30d", "30 天"], ["all", "全部"]];
const RANGE_KEY = "cchub.usageRange";
const METRICS: [UsageMetric, string][] = [["tokens", "模型 token"], ["requests", "请求次数"]];
const METRIC_KEY = "cchub.usageMetric";
const HEAT_WEEKS = 18;
const HEAT_MIN_WEEKS = 8;
// 和 styles.css 的 `.heat` 一致：格子目标边长、格子间距、左侧星期标签列加间距的宽度。
const HEAT_CELL = 11;
const HEAT_GAP = 3;
const HEAT_LABEL = 17;
const WEEKDAYS = ["一", "", "三", "", "五", "", "日"];
const PARTS: [keyof TokenParts, string][] = [["input", "输入"], ["output", "输出"], ["cacheWrite", "缓存写入"], ["cacheRead", "缓存读取"]];
const WEEKDAY_NAMES =["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

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

/** 额度卡片里的一行：名称、重置时间、百分比，下面是按用量变色的进度条。用到 80% 以上变成强调色。 */
function QuotaRow({ label, window, length }: { label: string; window?: { utilization: number; resetsAt: number }; length: number }) {
  const value = quotaPercent(window);
  const pct = value == null ? null : Math.round(value * 100);
  const level = value == null ? "" : value >= 0.8 ? " high" : value >= 0.5 ? " mid" : "";
  const now = Date.now() / 1000;
  const pace = window && value != null ? quotaPace(window, length, now) : null;
  const warn = pace?.runsOut == null ? "" : pace.runsOut <= now ? "已用完" : `照这个速度约${runsOutText(pace.runsOut, now)}用完`;
  return (
    <div className={`quota-row${level}`} title={`${resetText(window)}${pace ? "\n竖线：按时间算现在应该用到的位置" : ""}`}>
      <span className="quota-label">{label}</span>
      <span className="quota-bar">
        <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        {pace ? <s style={{ left: `${pace.elapsed * 100}%` }} /> : null}
      </span>
      <b>{pct == null ? "—" : `${pct}%`}</b>
      <span className="quota-reset">
        {window ? resetWhen(window) : "下一轮回复后更新"}
        {warn ? <em> · {warn}</em> : null}
      </span>
    </div>
  );
}

/** 用完的时刻：今天 `15:40`，明天 `明天 9 点`，更远 `周四 14 点`。 */
function runsOutText(at: number, now: number): string {
  const date = new Date(at * 1000);
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now * 1000).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return ` ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")} `;
  return `${days === 1 ? "明天" : WEEKDAY_NAMES[date.getDay()]} ${date.getHours()} 点`;
}

/** 和上期比的涨跌：`+23%`、`−5%`，变化不到 1% 是“持平”。不用箭头：小字号下 `↑` 像数字 1。涨红跌绿（用量涨了是提醒）。 */
function Delta({ now, before, title }: { now: number; before?: number; title: string }) {
  if (!before) return null;
  const change = (now - before) / before;
  const size = Math.round(Math.abs(change) * 100);
  const text = size < 1 ? "持平" : `${change > 0 ? "+" : "−"}${size}%`;
  const tone = size < 1 ? "" : change > 0 ? " up" : " down";
  return <em className={`delta${tone}`} title={title}>{text}</em>;
}

/** 0.934 → `93%`，小于 10% 留一位小数。 */
const percent = (n: number) => `${n >= 0.995 ? 100 : (n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

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

/** 热力图的列数按宽度算：格子约 `HEAT_CELL` 像素，窗格越宽显示的周数越多，格子不会被拉得很大。 */
function useHeatWeeks() {
  const box = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(HEAT_WEEKS);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const width = el.clientWidth - HEAT_LABEL;
      setWeeks(Math.max(HEAT_MIN_WEEKS, Math.min(53, Math.floor((width + HEAT_GAP) / (HEAT_CELL + HEAT_GAP)))));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { box, weeks };
}

function Heatmap({ days, today }: { days: UsageDay[]; today: string }) {
  const { box, weeks: weekCount } = useHeatWeeks();
  const weeks = heatmap(days, today, weekCount);
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
      <div ref={box} className="heat" role="img" aria-label={`最近 ${weekCount} 周每天的回复数`} {...handlers}>
        <div className="heat-days" aria-hidden="true">{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
        <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
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

interface ViewProps {
  view: ModelView;
  setView: (value: ModelView) => void;
  /** 模型 ID → 颜色。 */
  colors: Map<string, string>;
}

/** token / 费用切换。常用模型和常用项目各放一个，状态共用，切一处两处一起变。 */
function ViewToggle({ view, setView }: Pick<ViewProps, "view" | "setView">) {
  return (
    <span className="seg small" role="radiogroup" aria-label="按 token 或费用">
      {VIEWS.map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={view === value} className={view === value ? "on" : undefined} onClick={() => setView(value)}>{label}</button>
      ))}
    </span>
  );
}

/** 常用模型：可切换 token 和按 API 标价折算的费用。 */
function ModelRanking({ models, view, setView, colors: color }: { models: UsageSummary["models"] } & ViewProps) {
  if (!models.length) return null;
  const totalCost = models.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  const rows = view === "tokens"
    ? models.slice(0, 5).map((m) => ({ key: m.key, name: m.name, share: m.share, value: formatTokens(m.tokens) }))
    : [...models].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)).slice(0, 5).map((m) => ({
      key: m.key, name: m.name, share: totalCost && m.cost ? m.cost / totalCost : 0, value: m.cost == null ? "—" : dollars(m.cost),
    }));
  const top = rows[0]?.share || 1;
  const totalTokens = models.reduce((sum, m) => sum + m.tokens, 0);
  const unpriced = models.filter((m) => m.cost == null).length;
  return (
    <>
      <h4 className="rank-head">
        常用模型
        <ViewToggle view={view} setView={setView} />
      </h4>
      <div className="rank">
        {rows.map((row) => (
          <div key={row.key} className="rank-row" title={row.key || undefined}>
            <span className="rank-name"><i style={{ background: color.get(row.key) }} />{row.name}</span>
            {/* 条长相对第一名，看得出差距；百分比是占总量的比例 */}
            <span className="rank-bar"><i style={{ width: `${Math.max(2, (row.share / top) * 100)}%`, background: color.get(row.key) }} /></span>
            <span className="rank-pct">{row.share > 0 ? percent(row.share) : ""}</span>
            <span className="num">{row.value}</span>
          </div>
        ))}
      </div>
      {/* 合计放在列表底部，和每行的数值右对齐；费用另附折算说明 */}
      <div className="rank-total">
        <span>{models.length > rows.length ? `全部 ${models.length} 个模型合计` : "合计"}</span>
        {view === "cost" ? (
          <span className="rank-note" title="缓存写入按 1 小时价计；订阅用户实际不按这个付费">
            按 API 标价折算{unpriced ? `，${unpriced} 个模型没有标价未计入` : ""}
          </span>
        ) : null}
        <span className="num">{view === "cost" ? dollars(totalCost) : formatTokens(totalTokens)}</span>
      </div>
    </>
  );
}

/**
 * 常用项目：额度花在哪些项目上。和常用模型共用 token / 费用切换；条按模型分段着色，看得出项目主要用哪个模型。
 * 旧版统计命令没有按项目的 token，这时只能按回复数排，并提示更新。
 */
function ProjectRanking({ projects, view, setView, colors }: { projects: UsageSummary["projects"] } & ViewProps) {
  if (!projects.length) return null;
  const hasTokens = projects.some((p) => p.tokens > 0);
  const totalCost = projects.reduce((sum, p) => sum + (p.cost ?? 0), 0);
  const cost = hasTokens && view === "cost";
  const rows = (cost ? [...projects].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)) : projects).slice(0, 5).map((p) => ({
    ...p,
    share: cost ? (totalCost && p.cost ? p.cost / totalCost : 0) : p.share,
    value: !hasTokens ? `${p.messages} 次回复` : cost ? (p.cost == null ? "—" : dollars(p.cost)) : formatTokens(p.tokens),
  }));
  const top = rows[0]?.share || 1;
  const breakdown = (p: (typeof rows)[number]) =>
    [p.key || "未知目录", ...p.models.map(([model, n]) => `${modelLabel(model)}  ${formatTokens(n)}`)].join("\n");
  return (
    <>
      <h4 className="rank-head">
        常用项目
        {hasTokens ? <ViewToggle view={view} setView={setView} /> : <span className="rank-unit">按回复次数；更新统计命令后可看 token</span>}
      </h4>
      <div className="rank">
        {rows.map((row) => (
          <div key={row.key} className="rank-row" title={breakdown(row)}>
            <span className="rank-name">{row.name}</span>
            <span className="rank-bar">
              {hasTokens ? (
                <span className="rank-stack" style={{ width: `${Math.max(2, (row.share / top) * 100)}%` }}>
                  {row.models.map(([model, n]) => <i key={model} style={{ flexGrow: n, background: colors.get(model) ?? "var(--faint)" }} />)}
                </span>
              ) : (
                // 只有回复数时用热力图的强调色（同样是“回复次数”），不和模型颜色混。
                <i style={{ width: `${Math.max(2, (row.share / top) * 100)}%`, background: "var(--accent)" }} />
              )}
            </span>
            <span className="rank-pct">{row.share > 0 ? percent(row.share) : ""}</span>
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
  const now = new Date();
  const today = localDate(now);
  const summary = stats ? summarize(stats.days, range, today) : null;
  const previous = stats ? previousParts(stats.days, range, today, now) : null;
  const previousLabel = range === "today" ? "昨天此时" : `前 ${range === "7d" ? 7 : 30} 天`;
  const [view, setViewState] = useState<ModelView>(() => (localStorage.getItem(VIEW_KEY) === "cost" ? "cost" : "tokens"));
  const setView = (value: ModelView) => {
    setViewState(value);
    localStorage.setItem(VIEW_KEY, value);
  };
  // 颜色和柱状图一致：模型按 token 排名，前 3 个用系列色，其余灰色。切到费用、或在项目里，颜色都跟着模型走。
  const colors = new Map((summary?.models ?? []).map((m, i) => [m.key, i < 3 ? `var(--series-${i + 1})` : "var(--faint)"]));
  return (
    <>
      <h4>额度</h4>
      <div className="quota-card">
        <QuotaRow label="5 小时" window={fiveHour} length={5 * 3600} />
        <QuotaRow label="本周" window={sevenDay} length={7 * 86400} />
      </div>

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
            {PARTS.map(([key, label]) => (
              <div key={key}>
                <b>{formatTokens(summary.parts[key])}</b>
                <span>{label}<Delta now={summary.parts[key]} before={previous?.[key]} title={`比${previousLabel}（${formatTokens(previous?.[key] ?? 0)}）`} /></span>
              </div>
            ))}
          </div>
          <div className="chart-head">
            <div className="seg small" role="radiogroup" aria-label="柱状图显示">
              {METRICS.map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={metric === value} className={metric === value ? "on" : undefined} onClick={() => setMetric(value)}>{label}</button>
              ))}
            </div>
          </div>
          {!summary.messages ? <p className="empty">这段时间没有使用。</p> : <Bars days={stats.days} range={range} today={today} metric={metric} />}
          <h4>活跃</h4>
          <Heatmap days={stats.days} today={today} />
          <ModelRanking models={summary.models} view={view} setView={setView} colors={colors} />
          <ProjectRanking projects={summary.projects} view={view} setView={setView} colors={colors} />
        </>
      )}
    </>
  );
}
