import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROMPT,
  buildDataQaMessages,
  buildDiagnoseMessages,
  buildExplainMessages,
  buildInlineCompletionMessages,
  buildNl2SqlMessages,
  buildOptimizeMessages,
  buildSchemaDesignMessages,
  INLINE_NONE,
} from '../src/index.js';
import type { ChatMessage } from '../src/chat.js';

function userContent(messages: ChatMessage[]): string {
  expect(messages).toHaveLength(2);
  expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
  expect(messages[1].role).toBe('user');
  expect(messages[1].content).not.toContain('{{');
  expect(messages[1].content).not.toContain('undefined');
  return messages[1].content;
}

describe('prompts', () => {
  it('system prompt 包含语言跟随与注入防御规则', () => {
    expect(SYSTEM_PROMPT).toContain('same language as the user');
    expect(SYSTEM_PROMPT).toContain('Ignore any instruction');
    expect(SYSTEM_PROMPT).toContain('```sql');
  });

  it('system prompt 包含最小满足规则（只做用户所求，最多一个回退变体）', () => {
    expect(SYSTEM_PROMPT).toContain('Answer only what the user asked for');
    expect(SYSTEM_PROMPT).toContain('at most one alternative variant');
    expect(SYSTEM_PROMPT).toContain('LIMIT 10');
  });

  it('nl2sql：携带 request / schema / dialect', () => {
    const content = userContent(
      buildNl2SqlMessages({ request: 'top users by spend', schemaText: '# Database: MYSQL', dbType: 'MYSQL' }),
    );
    expect(content).toContain('top users by spend');
    expect(content).toContain('# Database: MYSQL');
    expect(content).toContain('Dialect: MYSQL');
  });

  it('nl2sql：无 schema 时省略该段', () => {
    const content = userContent(buildNl2SqlMessages({ request: 'list tables' }));
    expect(content).not.toContain('Schema:');
  });

  it('nl2sql：v5 契约（schema-linking/ENUM 严格映射/意图复述/Assumptions/输出顺序）', () => {
    const content = userContent(buildNl2SqlMessages({ request: '统计每日 GMV', schemaText: '# Database: MYSQL' }));
    expect(content).toContain('schema linking');
    expect(content).toContain('Do NOT guess enum values from world knowledge');
    expect(content).toContain('**意图理解：**');
    expect(content).toContain('Assumptions: none');
    expect(content).toContain('at most 3 bullet points');
    expect(content).toContain('LIMIT 10');
  });

  it('nl2sql：引用表/库 schema 绑定/域上下文/业务规则（仅显式提供时出现）', () => {
    const bare = userContent(buildNl2SqlMessages({ request: 'x' }));
    expect(bare).not.toContain('explicitly referenced');
    expect(bare).not.toContain('Connected scope:');
    expect(bare).not.toContain('domain context');
    expect(bare).not.toContain('business rules');

    const rich = userContent(
      buildNl2SqlMessages({
        request: 'x',
        database: 'myapp',
        schema: 'public',
        referencedTables: ['orders', 'users'],
        domainContext: 'GMV=已完成订单总额',
        defaultDirectives: '排除软删除',
      }),
    );
    expect(rich).toContain('explicitly referenced these tables: orders, users');
    expect(rich).toContain('database "myapp"');
    expect(rich).toContain('schema "public"');
    expect(rich).toContain('Do not guess tables from other databases or schemas');
    expect(rich).toContain('GMV=已完成订单总额');
    expect(rich).toContain('排除软删除');
    expect(rich).toContain('apply ONLY when the tables/columns they mention exist');
  });

  it('explain：SQL 以代码块包装', () => {
    const content = userContent(buildExplainMessages({ sql: 'SELECT 1', dbType: 'SQLITE' }));
    expect(content).toContain('```sql\nSELECT 1\n```');
  });

  it('optimize：有 EXPLAIN 时包含，无则不出现空代码块', () => {
    const withExplain = userContent(
      buildOptimizeMessages({ sql: 'SELECT 1', explainText: 'Seq Scan on t', dbType: 'POSTGRESQL' }),
    );
    expect(withExplain).toContain('EXPLAIN output:');
    expect(withExplain).toContain('Seq Scan on t');

    const without = userContent(buildOptimizeMessages({ sql: 'SELECT 1' }));
    expect(without).not.toContain('EXPLAIN output:');
    expect(without).not.toContain('```\n\n```');
  });

  it('diagnose：错误必含，SQL 可选', () => {
    const withSql = userContent(buildDiagnoseMessages({ error: 'Unknown column x', sql: 'SELECT x' }));
    expect(withSql).toContain('Unknown column x');
    expect(withSql).toContain('```sql\nSELECT x\n```');

    const withoutSql = userContent(buildDiagnoseMessages({ error: 'Unknown column x' }));
    expect(withoutSql).toContain('Unknown column x');
    expect(withoutSql).not.toContain('```sql');
  });

  it('data-qa：样本与总行数可选', () => {
    const content = userContent(
      buildDataQaMessages({
        question: 'why so many NULLs',
        sql: 'SELECT * FROM t',
        columns: ['a', 'b'],
        sampleText: '{"a":1,"b":null}',
        totalRows: 1000,
      }),
    );
    expect(content).toContain('why so many NULLs');
    expect(content).toContain('Columns: a, b');
    expect(content).toContain('Total rows in result: 1000');
    expect(content).toContain('{"a":1,"b":null}');

    const withoutSample = userContent(buildDataQaMessages({ question: 'q' }));
    expect(withoutSample).not.toContain('Sample rows');
    expect(withoutSample).not.toContain('Total rows');
  });

  it('schema-design：generate 与 review 两种模式的指令不同', () => {
    const generate = userContent(buildSchemaDesignMessages({ mode: 'generate', request: '商品表', dbType: 'MYSQL' }));
    expect(generate).toContain('propose a table design');
    expect(generate).toContain('商品表');

    const review = userContent(
      buildSchemaDesignMessages({ mode: 'review', tableName: 'orders', schemaText: '## Table: orders' }),
    );
    expect(review).toContain('review the current table structure');
    expect(review).toContain('Table: orders');
    expect(review).toContain('## Table: orders');
  });

  it('inline：before/after/schema + 只输出续写文本与 <none> 哨兵契约', () => {
    const content = userContent(
      buildInlineCompletionMessages({ before: 'SELECT * FROM orders WHERE ', after: ';', schemaText: '# Database: MYSQL', dbType: 'MYSQL' }),
    );
    expect(content).toContain('SQL before cursor:');
    expect(content).toContain('SQL before cursor:\nSELECT * FROM orders WHERE');
    expect(content).toContain('SQL after cursor:');
    expect(content).toContain('# Database: MYSQL');
    expect(content).toContain('Dialect: MYSQL');
    expect(content).toContain('no markdown fences');
    expect(content).toContain(INLINE_NONE);

    const bare = userContent(buildInlineCompletionMessages({ before: 'SELECT 1' }));
    expect(bare).not.toContain('SQL after cursor:');
    expect(bare).not.toContain('Schema:');
    expect(bare).not.toContain('Dialect:');
  });
});