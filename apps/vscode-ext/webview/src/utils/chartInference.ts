/**
 * Chat 结果图表推断（P9：结果集驱动，AI 零 token 参与）。
 *
 * - `hasChartIntent`：用户消息是否明确要图表（关键词，中英）——路径 A 的触发器
 *   （命中 → 查询完成后自动渲染图表，仍可切回表格）；
 * - `inferCharts`：从结果表（header/rows 字符串单元格）确定性判定可画的图型与序列。
 *   形态不满足 → null（无按钮、不自动画，fail-open 回表格）。
 */

export type ChartType = 'bar' | 'line' | 'pie' | 'area' | 'stackedBar' | 'horizontalBar';

export interface ChartSeries {
  label: string;
  values: number[];
}

export interface ChartSpec {
  /** 形态可用的图型，按推荐序（首个 = 自动渲染默认）。 */
  types: ChartType[];
  xLabel: string;
  xValues: string[];
  /** 数值序列（1..6 条；多序列 = 分组柱/多线）。 */
  series: ChartSeries[];
}

/** 图表意图词（中英，小写匹配；命中任一即视为路径 A）。 */
const CHART_INTENT_WORDS = [
  '图表', '柱状', '柱形', '折线', '趋势', '走势', '曲线', '饼图', '环形', '占比', '比例', '分布',
  '可视化', '画图', '图形', '直方', '面积', '横向', '水平', '条形', '堆叠',
  'chart', 'plot', 'visualize', 'visualise', 'graph', 'area', 'horizontal', 'stacked',
];

export function hasChartIntent(text: string): boolean {
  const lower = String(text ?? '').toLowerCase();
  return CHART_INTENT_WORDS.some((w) => lower.includes(w));
}

/** 用户明确指定的图型；只说“图表/可视化”时返回 null（按数据形态推荐）。 */
export function preferredChartType(text: string): ChartType | null {
  const lower = String(text ?? '').toLowerCase();
  if (/饼图|环形|占比|比例|份额|pie|donut|doughnut/.test(lower)) return 'pie';
  if (/堆叠|stacked/.test(lower)) return 'stackedBar';
  if (/横向|水平|条形|horizontal/.test(lower)) return 'horizontalBar';
  if (/面积|area/.test(lower)) return 'area';
  if (/折线|曲线|趋势|走势|line|trend/.test(lower)) return 'line';
  if (/柱状|柱形|直方|bar|column|histogram/.test(lower)) return 'bar';
  return null;
}

/** 从可用图型中选中用户偏好；偏好不可用时回退推荐序第一项。 */
export function chooseChartType(types: readonly ChartType[], preferred?: ChartType | null): ChartType | null {
  if (types.length === 0) return null;
  return preferred && types.includes(preferred) ? preferred : types[0]!;
}

/** 解析数值单元格（去千分位逗号/百分号；失败 → undefined）。 */
function parseNumber(cell: string): number | undefined {
  const raw = String(cell ?? '').trim().replace(/,/g, '').replace(/%$/, '');
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 列名或样本单元格是否「时间样」（列名含时间词，或多数单元格可解析为日期）。 */
function isTimeLike(header: string, cells: string[]): boolean {
  if (/date|time|day|month|week|year|周|日|月|年|时/i.test(header)) return true;
  const samples = cells.filter((c) => String(c ?? '').trim() !== '').slice(0, 20);
  if (samples.length === 0) return false;
  const parsed = samples.filter((c) => !Number.isNaN(Date.parse(String(c).trim())));
  return parsed.length / samples.length >= 0.7;
}

/** 数值列：非空单元格 ≥ 70% 可解析为有限数。 */
function isNumericColumn(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => String(c ?? '').trim() !== '');
  if (nonEmpty.length === 0) return false;
  const parsed = nonEmpty.filter((c) => parseNumber(String(c)) !== undefined);
  return parsed.length / nonEmpty.length >= 0.7;
}

/** 指标类列名（数量/金额/比率等）——即使数值很长也视为度量。 */
function metricLikeName(header: string): boolean {
  return /count|total|sum|amount|avg|rate|cnt|qty|score|price|money|fee|数量|金额|合计|总数|计数|均值|比率|次数|分数/.test(header.toLowerCase());
}

/**
 * 「编号/标识」类列：内容即便可解析为数字也**不是度量**（雪花 ID/手机号/单号）。
 * ① 列名是 id/no/code/phone 等（或中文编号/手机号…）；
 * ② 全整数且超出 JS 安全整数范围（≥2^53 的雪花/超长整型）；
 * ③ 全为 ≥11 位整数且列名无指标词（手机号/订单号样）。
 */
function idLikeColumn(header: string, cells: string[]): boolean {
  const h = String(header ?? '').toLowerCase();
  if (/(^|_)(id|no|code|key|uuid|guid|phone|mobile|tel|qq)(_|$)/.test(h)) return true;
  if (/编号|单号|手机号|电话|卡号|身份证|工号|邮编/.test(String(header ?? ''))) return true;
  const nonEmpty = cells.filter((c) => String(c ?? '').trim() !== '');
  const nums = nonEmpty.map((c) => parseNumber(String(c)));
  if (nums.length === 0 || nums.some((v) => v === undefined || !Number.isInteger(v))) return false;
  const values = nums as number[];
  if (values.some((v) => Math.abs(v) > Number.MAX_SAFE_INTEGER)) return true;
  if (metricLikeName(h)) return false;
  return values.every((v) => Math.abs(v) >= 1e10);
}

const MAX_SERIES = 6;
const BAR_MAX_ROWS = 60;
const LINE_MAX_POINTS = 200;
const PIE_MAX_SLICES = 12;

/**
 * 从结果表推断图表规格。判定口径：
 * - x 列 = 首个非数值列（全数值列 → 无类别轴 → 不可画）；
 * - 数值列（去掉 x）按原顺序成序列，最多 6 条（超出忽略）；
 * - 行过滤：至少首个数值列可解析的行才进图；
 * - 资格：柱 ≤ 60 行且数值全非负；线 ≤ 200 点且 x 时间样（**允许负值**：折线按 min/max
 *   域绘制，能正确显示退款等负数）；饼 = 单指标、≤ 12 行、数值全非负且至少一个正数；
 *   柱/饼仍要求全非负（按 0 基线钳制，负值会失真）；
 * - 变体：时间单序列追加面积；多序列追加堆叠柱；分类多/标签长追加横向条形；
 * - 推荐序：时间样 → 线优先；分类小额 → 饼优先；否则柱优先。
 */
export function inferCharts(header: string[], rows: string[][]): ChartSpec | null {
  if (!Array.isArray(header) || header.length < 2 || !Array.isArray(rows) || rows.length === 0) return null;

  const cols = header.map((_, i) => rows.map((r) => String(r?.[i] ?? '')));
  // 数值「度量」列 = 可解析数值 且 不是编号/标识列（雪花 tenant_id/手机号等不算度量）。
  const numericFlags = cols.map((cells, i) => isNumericColumn(cells) && !idLikeColumn(header[i] ?? '', cells));

  const xIdx = header.findIndex((_, i) => !numericFlags[i]);
  if (xIdx < 0) return null; // 全数值：无类别轴

  const numericIdx = header.map((_, i) => i).filter((i) => i !== xIdx && numericFlags[i]);
  if (numericIdx.length === 0) return null;

  // 行过滤 + 组装。
  const kept: { x: string; values: Array<number | undefined> }[] = [];
  for (const row of rows) {
    const x = String(row?.[xIdx] ?? '').trim();
    const first = parseNumber(String(row?.[numericIdx[0]] ?? ''));
    if (x === '' || first === undefined) continue;
    kept.push({ x, values: numericIdx.map((i) => parseNumber(String(row?.[i] ?? ''))) });
  }
  if (kept.length === 0) return null;

  // 序列取值：kept.values 按 numericIdx 的位置存（未解析的次要序列单元格按 0 计——
  // isNumericColumn 允许 30% 空洞，绘图不因个别脏值整列弃用）。
  const spec: ChartSpec = {
    types: [],
    xLabel: header[xIdx] ?? '',
    xValues: kept.map((k) => k.x),
    series: numericIdx.slice(0, MAX_SERIES).map((i) => ({
      label: header[i] ?? `#${i + 1}`,
      values: kept.map((k) => k.values[numericIdx.indexOf(i)] ?? 0),
    })),
  };

  const timeLike = isTimeLike(spec.xLabel, spec.xValues);
  /** 柱/线要求数值全非负（绘图按 0 基线钳制，负值会失真）。 */
  const allNonNegative = spec.series.every((s) => s.values.every((v) => v >= 0));
  const firstValues = spec.series[0]!.values;
  const pieOk = spec.series.length === 1
    && kept.length <= PIE_MAX_SLICES
    && firstValues.every((v) => v >= 0)
    && firstValues.some((v) => v > 0);

  const barOk = allNonNegative && kept.length <= BAR_MAX_ROWS;
  // 折线图按 [min, max] 域绘制（见 LineChart），负值无需钳到 0。
  const lineOk = timeLike && kept.length <= LINE_MAX_POINTS;
  const singleSeries = spec.series.length === 1;
  const horizontalOk = barOk && (kept.length > 8 || spec.xValues.some((v) => v.length > 12));

  // 推荐序：时间样 → 线/面积；分类小额 → 饼；柱/横向/堆叠按形态追加。
  const types: ChartType[] = [];
  if (lineOk) {
    types.push('line');
    // 面积填充以 0 为基线；跨 0 的数据不提供，避免填充区域误导。
    if (singleSeries && allNonNegative) types.push('area');
  }
  if (!timeLike && pieOk) types.push('pie');
  if (barOk) {
    types.push('bar');
    if (horizontalOk) types.push('horizontalBar');
    if (!singleSeries) types.push('stackedBar');
  }
  if (timeLike && pieOk) types.push('pie');
  spec.types = types;
  if (spec.types.length === 0) return null;
  return spec;
}