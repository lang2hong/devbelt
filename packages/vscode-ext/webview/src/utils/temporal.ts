/**
 * 日期/时间列的类型判定与「DB 文本 ⇄ 原生输入框」双向转换。
 *
 * 设计取舍：
 *
 * 1. **用原生控件**（`<input type="date|time|datetime-local">`）而不是自绘弹层。
 *    自绘方案需要几十行 CSS 去追 VS Code 主题（且菜单 teleport 到 body 后只能用
 *    全局选择器硬覆盖），而原生控件靠 `color-scheme` 就能跟随明暗主题，
 *    键盘可达性与本地化也由浏览器负责。
 *
 * 2. **解析不了就退化为纯文本输入**。数据库里的时间文本远比原生控件的接受范围宽：
 *    MySQL `TIME` 可以是 `838:59:59` 或 `-01:00:00`，PG `timestamptz` 带时区偏移，
 *    SQLite 的时间列就是任意文本，还有 `0000-00-00` 这种零值。这些一律走文本输入，
 *    原样进原样出，绝不因为控件表达不了就悄悄改写用户数据。
 *
 * 3. **秒必须保留**。原生 `time`/`datetime-local` 默认粒度是分钟，必须配 `step="1"`
 *    才会出现秒位——这正是过去 TIME 列编辑丢秒的原因。
 */

/** 时间类语义分类。`year` 单列出来是因为 MySQL YEAR 更接近数字而非日期。 */
export type TemporalKind = 'date' | 'time' | 'datetime' | 'year';

/** 精确匹配的基础类型名 → 语义分类。 */
const TEMPORAL_TYPES: Record<string, TemporalKind> = {
  // 仅日期
  date: 'date',
  // 仅时间
  time: 'time',
  'time without time zone': 'time',
  'time with time zone': 'time',
  timetz: 'time',
  // 日期 + 时间
  datetime: 'datetime',
  datetime2: 'datetime',
  smalldatetime: 'datetime',
  timestamp: 'datetime',
  timestamptz: 'datetime',
  'timestamp without time zone': 'datetime',
  'timestamp with time zone': 'datetime',
  // 仅年份
  year: 'year',
};

/**
 * 归一化类型名：去掉精度/长度、`unsigned` 之类修饰与首尾空白。
 * `timestamp(3)` → `timestamp`，`TIME WITHOUT TIME ZONE` → `time without time zone`。
 */
function baseTypeName(columnType: string): string {
  return columnType
    .trim()
    .toLowerCase()
    .replace(/\(\s*\d+\s*(,\s*\d+\s*)?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 判定列的时间语义，非时间列返回 null。
 *
 * 用**精确表名匹配**而非子串包含：以前是 `t.includes('time') && !t.includes('date')`
 * 判 time，于是 `timestamp` 会被判成「仅时间」（含 time、不含 date），
 * 只是靠模板里 v-if 的先后顺序侥幸没出错。
 */
export function classifyTemporal(columnType: string | undefined | null): TemporalKind | null {
  if (!columnType) return null;
  const base = baseTypeName(columnType);
  if (TEMPORAL_TYPES[base]) return TEMPORAL_TYPES[base];
  // PG 数组/带修饰的写法（如 `timestamp with time zone[]`）退化到首词判断
  const head = base.split(' ')[0].replace(/\[\]$/, '');
  return TEMPORAL_TYPES[head] ?? null;
}

/** 原生输入框的 type 属性。 */
export function inputTypeFor(kind: TemporalKind): 'date' | 'time' | 'datetime-local' | 'number' {
  switch (kind) {
    case 'date': return 'date';
    case 'time': return 'time';
    case 'datetime': return 'datetime-local';
    case 'year': return 'number';
  }
}

/** 原生输入框的 placeholder / 期望格式，用于提示与文本回退。 */
export function formatHintFor(kind: TemporalKind): string {
  switch (kind) {
    case 'date': return 'yyyy-MM-dd';
    case 'time': return 'HH:mm:ss';
    case 'datetime': return 'yyyy-MM-dd HH:mm:ss';
    case 'year': return 'yyyy';
  }
}

/** 小数秒全为 0 时可安全丢弃（语义等价）；非零则必须保留。 */
function fractionIsDroppable(frac: string | undefined): boolean {
  return !frac || /^\.0*$/.test(frac);
}

/** 零日期（MySQL 的 `0000-00-00`）原生控件表达不了。 */
function isZeroDate(y: string, m: string, d: string): boolean {
  return y === '0000' || m === '00' || d === '00';
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?(.*)$/;

/**
 * DB 文本 → 原生输入框的 value。
 *
 * 返回 null 表示「该值超出原生控件的表达范围」，调用方应改用纯文本输入，
 * 以免时区偏移被抹掉、超范围 TIME 被截断或零日期被改写。
 */
export function toInputValue(kind: TemporalKind, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return '';

  switch (kind) {
    case 'year': {
      return /^\d{1,4}$/.test(text) ? text : null;
    }
    case 'date': {
      const m = DATE_RE.exec(text);
      if (!m) return null;
      const [, y, mo, d] = m;
      if (isZeroDate(y, mo, d)) return null;
      return `${y}-${mo}-${d}`;
    }
    case 'time': {
      const m = TIME_RE.exec(text);
      if (!m) return null;
      const [, h, mi, s, frac] = m;
      // 原生 time 控件只接受 00:00:00–23:59:59；MySQL TIME 的
      // 超范围值（838:59:59）与负值走文本回退
      const hour = Number(h);
      if (!Number.isInteger(hour) || hour > 23) return null;
      if (!fractionIsDroppable(frac)) return null;
      return `${String(hour).padStart(2, '0')}:${mi}:${s ?? '00'}`;
    }
    case 'datetime': {
      const m = DATETIME_RE.exec(text);
      if (!m) return null;
      const [, y, mo, d, h, mi, s, frac, rest] = m;
      if (isZeroDate(y, mo, d)) return null;
      // 带时区偏移（`+08`、`Z`、`-05:30`）时 datetime-local 无法承载，
      // 强行塞进去会让用户以为改了本地时间，实际写回的是另一个时刻
      if (rest && rest.trim() !== '') return null;
      if (!fractionIsDroppable(frac)) return null;
      const hour = Number(h);
      if (!Number.isInteger(hour) || hour > 23) return null;
      return `${y}-${mo}-${d}T${String(hour).padStart(2, '0')}:${mi}:${s ?? '00'}`;
    }
  }
}

/**
 * 原生输入框的 value → 写回 DB 的文本。
 *
 * 浏览器在 `step="1"` 下通常给出带秒的值，但用户只填到分钟时仍可能省略秒，
 * 这里统一补齐 `:00`，避免同一列出现两种精度。
 */
export function toSqlValue(kind: TemporalKind, input: string): string {
  const text = (input ?? '').trim();
  if (text === '') return '';

  switch (kind) {
    case 'year':
    case 'date':
      return text;
    case 'time':
      return /^\d{1,2}:\d{2}$/.test(text) ? `${text}:00` : text;
    case 'datetime': {
      const normalized = text.replace('T', ' ');
      return /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
    }
  }
}

/**
 * 该值能否用原生控件编辑。用于决定「渲染选择器还是纯文本输入」。
 * 空值视为可用——新建行/清空后需要能直接选。
 */
export function canUseNativePicker(kind: TemporalKind, raw: unknown): boolean {
  return toInputValue(kind, raw) !== null;
}

/**
 * 该单元格值是否是二进制数据（BLOB / VARBINARY / 图片 / 加密字节流）。
 *
 * 二进制列**不能内联编辑**。db-core 的 typeCast 会把这些列保持为 Buffer，
 * 经 webview 的 postMessage 序列化后是 `{ type: 'Buffer', data: [...] }`，
 * 而 `String(raw)` 对它得到 `[object Object]` —— 结果网格是"失焦即提交"，
 * 双击进入编辑再点一下别处就把这七个字符写进了 BLOB 列，覆盖掉真实字节。
 * 图片、加密数据、序列化对象一次误触就没了，而且界面上看不出发生了什么。
 *
 * 放在 utils 而不是组件内部，就为了能被测试钉住：组件里的判断没有测试栈覆盖。
 */
export function isBinaryCell(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false;
  const v = raw as { type?: unknown; data?: unknown };
  // Node Buffer 经 JSON 序列化后的形态
  if (v.type === 'Buffer' && Array.isArray(v.data)) return true;
  // 结构化克隆（webview 的 postMessage 在部分宿主下不走 JSON）会保留真实类型
  if (typeof ArrayBuffer !== 'undefined') {
    if (raw instanceof ArrayBuffer) return true;
    if (ArrayBuffer.isView(raw as any)) return true;
  }
  return false;
}
