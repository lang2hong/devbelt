import { describe, expect, it } from 'vitest';
import { iterNextvalRefs, rewritePgSchemaRefs, stripIdentifierSchema, stripPgSchemaRefs } from '../../src/dialect/pgExprPort';

/**
 * 4B-1：表达式移植层向量（行为固化）。
 *
 * 从 schemaDiffService 逐行搬移后，用直接向量钉住字面量感知行为：
 * E-string、美元引用、含 `'`/`"` 的 schema、扩展 protectedNames、字面量内不动。
 */
describe('pgExprPort：nextval 迭代（字面量转义）', () => {
  it('解析 nextval 并解码 \'\' 转义（序列名含单引号）', () => {
    const text = "nextval('a''b.seq'::regclass)";
    expect(iterNextvalRefs(text)).toEqual([{ start: 0, end: text.length, ref: "a'b.seq" }]);
  });

  it('非 regclass / 未闭合字面量不上报', () => {
    expect(iterNextvalRefs("nextval('x')")).toEqual([]);
    expect(iterNextvalRefs("nextval('x")).toEqual([]);
    expect(iterNextvalRefs('nextval(seq)')).toEqual([]);
  });
});

describe('pgExprPort：rewritePgSchemaRefs', () => {
  it('nextval 字面量：带引号/未带引号源 schema 均改写为目标（目标恒带引号）', () => {
    expect(rewritePgSchemaRefs(`nextval('src.seq'::regclass)`, 'src', 'tgt'))
      .toBe(`nextval('"tgt".seq'::regclass)`);
    expect(rewritePgSchemaRefs(`nextval('"src"."seq"'::regclass)`, 'src', 'tgt'))
      .toBe(`nextval('"tgt"."seq"'::regclass)`);
  });

  it('目标 schema 含单引号：按 escape 回调转义，不提前结束字面量', () => {
    const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
    expect(rewritePgSchemaRefs(`nextval('src.seq'::regclass)`, 'src', "t'gt", esc))
      .toBe(`nextval('"t''gt".seq'::regclass)`);
  });

  it('标识符上下文改写目标；字符串字面量内不动', () => {
    expect(rewritePgSchemaRefs('DEFAULT src.myenum', 'src', 'tgt')).toBe('DEFAULT "tgt".myenum');
    expect(rewritePgSchemaRefs(`DEFAULT 'src.x'::src.myenum`, 'src', 'tgt')).toBe(`DEFAULT 'src.x'::"tgt".myenum`);
  });

  it('未限定的 nextval 不补目标 schema（M1 口径）', () => {
    expect(rewritePgSchemaRefs(`nextval('seq'::regclass)`, 'src', 'tgt')).toBe(`nextval('seq'::regclass)`);
  });

  it('protectedNames（扩展所属对象）原样保留', () => {
    expect(rewritePgSchemaRefs('DEFAULT src.citext', 'src', 'tgt', undefined, new Set(['citext'])))
      .toBe('DEFAULT src.citext');
  });

  it('E-string 与美元引用内不改写', () => {
    expect(rewritePgSchemaRefs("DEFAULT E'src\\'x'", 'src', 'tgt')).toBe("DEFAULT E'src\\'x'");
    expect(rewritePgSchemaRefs('DEFAULT $$src.x$$', 'src', 'tgt')).toBe('DEFAULT $$src.x$$');
  });

  it('from===to 或缺参为 no-op', () => {
    expect(rewritePgSchemaRefs('src.x', 'src', 'src')).toBe('src.x');
    expect(rewritePgSchemaRefs('src.x')).toBe('src.x');
    expect(rewritePgSchemaRefs('src.x', undefined, 'tgt')).toBe('src.x');
  });
});

describe('pgExprPort：剥离归一（比较用）', () => {
  it('stripPgSchemaRefs：nextval 字面量与标识符上下文都剥（顺序固定）', () => {
    expect(stripPgSchemaRefs(`nextval('src.seq'::regclass)::src.myenum`, ['src']))
      .toBe('nextval(seq)::myenum');
  });

  it('stripIdentifierSchema：边界防误伤词内引用；字面量内不动', () => {
    expect(stripIdentifierSchema('xsrc.y', ['src'])).toBe('xsrc.y');
    expect(stripIdentifierSchema(`'src.y'`, ['src'])).toBe(`'src.y'`);
    expect(stripIdentifierSchema('src.y xsrc.z src.w', ['src'])).toBe('y xsrc.z w');
  });

  it('带引号的 schema 名同样剥离（含 `"` 的高阶形态）', () => {
    expect(stripIdentifierSchema('"src"."t"', ['src'])).toBe('"t"');
  });
});