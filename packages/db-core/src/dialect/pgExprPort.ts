/**
 * PG 表达式移植层（P7.1 4B-1）。
 *
 * 目录里默认值/CHECK/索引表达式等只以**文本**形态暴露（`pg_get_expr` 等），
 * 跨 schema 同步必须把这些文本里的源 schema 引用移植到目标 schema。本模块是
 * **唯一入口**（chokepoint）：所有字面量感知的改写/剥离都收敛在这里，便于向量化测试
 * （E-string、美元引用、含 `'`/`"` 的 schema、扩展 protectedNames 等）。
 *
 * 从 `schemaDiffService.ts` 逐行搬移（纯提取，行为不变）；4B-2/4B-3 的结构 diff
 * 元数据化会继续复用本层处理剩余的表达式文本。
 */

/** 解析文本里所有 `nextval('<literal>'::regclass)`，返回**解码后**的 regclass 标识符文本与整体位置。 */
export function iterNextvalRefs(text: string): { start: number; end: number; ref: string }[] {
  const out: { start: number; end: number; ref: string }[] = [];
  const re = /nextval\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    if (text[i] !== "'") continue;
    let j = i + 1;
    let lit = '';
    let closed = false;
    while (j < text.length) {
      if (text[j] === "'") {
        if (text[j + 1] === "'") { lit += "'"; j += 2; continue; }
        closed = true;
        break;
      }
      lit += text[j]; j++;
    }
    if (!closed) continue;
    const tail = text.slice(j + 1, j + 1 + '::regclass)'.length);
    if (tail !== '::regclass)') continue;
    const end = j + 1 + '::regclass)'.length;
    out.push({ start: m.index, end, ref: lit });
    re.lastIndex = end;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 对字符串字面量（`'...'`，含 `''` 转义）**之外**的片段应用 `transform`，
 * 字面量原样保留。美元引用（`$tag$…$tag$`）与 `E'...'` 同样视为字面量。
 */
function rewriteOutsideLiterals(text: string, transform: (segment: string) => string): string {
  let out = '';
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // 美元引用：$tag$ ... $tag$（含 $$）。$1 等参数不匹配，按普通字符处理。
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (m) {
        out += transform(buf);
        buf = '';
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // E'...' / e'...'：反斜杠转义（\' 不结束字面量）。
    if ((ch === 'E' || ch === 'e') && text[i + 1] === "'") {
      out += transform(buf);
      buf = '';
      let lit = text.slice(i, i + 2);
      i += 2;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) { lit += text[i] + text[i + 1]; i += 2; continue; }
        if (text[i] === "'") {
          if (text[i + 1] === "'") { lit += "''"; i += 2; continue; }
          lit += "'"; i++;
          break;
        }
        lit += text[i]; i++;
      }
      out += lit;
      continue;
    }
    if (ch === "'") {
      out += transform(buf);
      buf = '';
      let lit = "'";
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { lit += "''"; i += 2; continue; }
          lit += "'"; i++;
          break;
        }
        lit += text[i]; i++;
      }
      out += lit;
      continue;
    }
    buf += ch; i++;
  }
  return out + transform(buf);
}

/** 字面量内 `schema.seq` / `"schema".seq` / `"schema"."seq"` → 去掉 schema 限定。 */
function stripSchemaInLiteral(lit: string, schemas: readonly (string | undefined)[]): string {
  for (const sc of schemas) {
    if (!sc) continue;
    const q = `"${sc.replace(/"/g, '""')}"`;
    if (lit.startsWith(`${q}.`)) return lit.slice(q.length + 1);
    if (lit.startsWith(`${sc}.`)) return lit.slice(sc.length + 1);
  }
  return lit;
}

/** 只从 `nextval('<schema>.<seq>'::regclass)` 的字面量里剥掉 schema 前缀（不碰其它字面量）。 */
function stripRegclassSchema(text: string, schemas: readonly (string | undefined)[]): string {
  const matches = iterNextvalRefs(text);
  if (!matches.length) return text;
  let out = '';
  let pos = 0;
  for (const m of matches) {
    out += text.slice(pos, m.start) + `nextval(${stripSchemaInLiteral(m.ref, schemas)})`;
    pos = m.end;
  }
  return out + text.slice(pos);
}

/**
 * 去掉**标识符上下文**里的 schema 限定（类型名如 `app.myenum`）：仅在字符串字面量之外，
 * 且前置字符非 `[\w$"']` 时匹配。字面量内的 `app.` 完全不动。
 */
export function stripIdentifierSchema(text: string, schemas: readonly (string | undefined)[]): string {
  const boundary = '(?<![\\w$"\'])';
  const patterns = schemas
    .filter((sc): sc is string => !!sc)
    .flatMap((sc) => [`"${sc.replace(/"/g, '""')}"`, sc])
    .map((p) => new RegExp(`${boundary}${escapeRe(p)}\\.`, 'g'));
  return rewriteOutsideLiterals(text, (seg) => {
    let s = seg;
    for (const re of patterns) s = s.replace(re, '');
    return s;
  });
}

/**
 * 比较归一化用：先剥 `nextval` 字面量里的 schema，再剥标识符上下文的 schema 限定
 * （顺序与 schemaDiffService 原实现一致）。
 */
export function stripPgSchemaRefs(text: string, schemas: readonly (string | undefined)[]): string {
  return stripIdentifierSchema(stripRegclassSchema(text, schemas), schemas);
}

/**
 * 把已知形态里的源 schema 前缀改写为目标 schema：
 * - `nextval('<from>.<seq>'::regclass)` 字面量（带 schema → 改写）；
 * - 字符串字面量之外的标识符上下文类型名限定。
 * 目标 schema 一律以**带引号**形式（`toQ`）拼接，避免注入/大小写漂移。
 *
 * 未限定的 `nextval('seq')` 不再补目标 schema（M1 已用 `SET LOCAL search_path=pg_catalog`
 * 保证目录输出总是限定；共用序列不会被悄悄另起计数器）。
 *
 * `protectedNames`：**扩展所属**对象名（类型/函数）——它们属于扩展而非源 schema，
 * 改写成目标 schema 会指向不存在的对象（如 `public.citext` → `"tgt".citext`），必须原样保留。
 */
export function rewritePgSchemaRefs(text: string, from?: string, to?: string, escape?: (v: string) => string, protectedNames?: ReadonlySet<string>): string {
  if (!text || !from || !to || from === to) return text;
  const fromQ = `"${from.replace(/"/g, '""')}"`;
  const toQ = `"${to.replace(/"/g, '""')}"`;
  // 目标 schema 名可能含 `'`；放进 nextval('…'::regclass) 的**字符串字面量**必须按方言转义
  // （escapeValue 同时处理 `'` 与 scs=off 的反斜杠），否则含 `'` 的 schema 会提前结束字面量形成注入。
  const esc = escape ?? ((v: string) => `'${v.replace(/'/g, "''")}'`);
  const matches = iterNextvalRefs(text);
  if (matches.length) {
    let out = '';
    let pos = 0;
    for (const m of matches) {
      out += text.slice(pos, m.start);
      let ref = m.ref;
      if (ref.startsWith(`${fromQ}.`)) ref = `${toQ}.${ref.slice(fromQ.length + 1)}`;
      else if (ref.startsWith(`${from}.`)) ref = `${toQ}.${ref.slice(from.length + 1)}`;
      out += `nextval(${esc(ref)}::regclass)`;
      pos = m.end;
    }
    text = out + text.slice(pos);
  }
  const boundary = '(?<![\\w$"\'])';
  const fromPats = [fromQ, from].map((p) => new RegExp(`${boundary}${escapeRe(p)}\\.`, 'g'));
  return rewriteOutsideLiterals(text, (seg) => {
    let out = seg;
    for (const re of fromPats) {
      out = out.replace(re, (m, off: number, whole: string) => {
        const id = matchIdentAt(whole.slice(off + m.length));
        if (id && protectedNames?.has(id)) return m;
        return `${toQ}.`;
      });
    }
    return out;
  });
}

/** 读取字符串开头的（可能带引号的）标识符；无则返回 undefined。 */
function matchIdentAt(s: string): string | undefined {
  if (!s) return undefined;
  if (s[0] === '"') {
    let j = 1;
    let out = '';
    while (j < s.length) {
      if (s[j] === '"') {
        if (s[j + 1] === '"') { out += '"'; j += 2; continue; }
        return out;
      }
      out += s[j]; j++;
    }
    return undefined;
  }
  const m = /^[\p{L}\p{N}_$]+/u.exec(s);
  return m?.[0];
}