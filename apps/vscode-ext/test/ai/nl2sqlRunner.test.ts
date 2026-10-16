import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  assembleExplainMessages,
  assembleNl2SqlMessages,
  assembleOptimizeMessages,
  extractReferencedTables,
  injectBusinessRules,
} from '../../src/ai/nl2sqlRunner';
import type { AiEditorContext } from '../../src/ai/nl2sqlRunner';
import type { AiContextStore } from '../../src/ai/aiContextStore';
import { BUSINESS_RULES_HEADER, DOMAIN_CONTEXT_HEADER, type ChatMessage } from '@devbelt/ai-core';

function contextStore(domain = '', directives = ''): AiContextStore {
  return {
    getDomainContext: () => domain,
    getDefaultDirectives: () => directives,
  } as unknown as AiContextStore;
}

const CTX: AiEditorContext = {
  conn: { id: 'c1', name: '本地库', dbType: 'MYSQL' } as never,
  database: 'myapp',
  dbType: 'MYSQL',
  schemaText: '# Database: MYSQL, database: myapp',
  tableCount: 2,
  totalTables: 2,
  commentCount: 3,
};

describe('extractReferencedTables（@ 引用解析）', () => {
  it('@name / @db.name / @schema.name 取末段；去重；上限 10', () => {
    expect(extractReferencedTables('查 @orders 和 @myapp.users，再看 @orders')).toEqual(['orders', 'users']);
    expect(extractReferencedTables('@public.logs')).toEqual(['logs']);
    const many = Array.from({ length: 15 }, (_, i) => `@t${i}`).join(' ');
    expect(extractReferencedTables(many)).toHaveLength(10);
  });

  it('无 @ 返回空数组', () => {
    expect(extractReferencedTables('查所有订单')).toEqual([]);
  });
});

describe('assembleNl2SqlMessages（五路信号）', () => {
  it('注入库绑定/引用表/域上下文/默认指令（全信号）', () => {
    const messages = assembleNl2SqlMessages({
      request: '统计每日 GMV',
      ctx: CTX,
      referencedTables: ['orders'],
      contextStore: contextStore('GMV=已完成订单总额', '排除软删除'),
    });
    const content = messages[1].content;
    expect(content).toContain('统计每日 GMV');
    expect(content).toContain('database "myapp"');
    expect(content).toContain('explicitly referenced these tables: orders');
    expect(content).toContain('GMV=已完成订单总额');
    expect(content).toContain('排除软删除');
    expect(content).toContain('# Database: MYSQL, database: myapp');
  });

  it('无域上下文/默认指令时不出现对应区块', () => {
    const messages = assembleNl2SqlMessages({
      request: 'x',
      ctx: { tableCount: 0, totalTables: 0, commentCount: 0, note: 'no-connection' },
      referencedTables: [],
      contextStore: contextStore(),
    });
    const content = messages[1].content;
    expect(content).not.toContain('domain context');
    expect(content).not.toContain('business rules');
  });
});

describe('assembleExplain/Optimize（按文档不注入域上下文/业务规则）', () => {
  it('explain：SQL 代码块 + schema + 方言', () => {
    const content = assembleExplainMessages('SELECT 1', CTX)[1].content;
    expect(content).toContain('```sql\nSELECT 1\n```');
    expect(content).toContain('# Database: MYSQL');
    expect(content).toContain('Dialect: MYSQL');
    expect(content).not.toContain('business rules');
  });

  it('optimize：EXPLAIN 有则含，无则省略段', () => {
    const withPlan = assembleOptimizeMessages('SELECT 1', 'Seq Scan on t', CTX)[1].content;
    expect(withPlan).toContain('Seq Scan on t');
    const without = assembleOptimizeMessages('SELECT 1', undefined, CTX)[1].content;
    expect(without).not.toContain('EXPLAIN output:');
  });
});

describe('injectBusinessRules（场景白名单）', () => {
  const base: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
  ];

  it('data-qa/nl2sql/chat 注入；explain/optimize/diagnose 不注入', () => {
    for (const feature of ['data-qa', 'nl2sql', 'chat']) {
      const out = injectBusinessRules(base, contextStore('术语', '规则'), 'c1', feature);
      expect(out).toHaveLength(3);
      expect(out[1].content).toContain('User-provided domain context');
      expect(out[1].content).toContain('User-provided business rules');
      expect(out[1].content).toContain('术语');
    }
    for (const feature of ['explain', 'optimize', 'error-diagnose', 'schema-design']) {
      expect(injectBusinessRules(base, contextStore('术语', '规则'), 'c1', feature)).toBe(base);
    }
  });

  it('两段分为独立区块（与 NL2SQL 同标题）；只配一段时只出一段', () => {
    const both = injectBusinessRules(base, contextStore('GMV=订单', '排除软删除'), 'c1', 'chat')[1].content as string;
    expect(both).toContain(`${DOMAIN_CONTEXT_HEADER}\nGMV=订单`);
    expect(both).toContain(`${BUSINESS_RULES_HEADER}\n排除软删除`);
    expect(both.indexOf(DOMAIN_CONTEXT_HEADER)).toBeLessThan(both.indexOf(BUSINESS_RULES_HEADER));

    const onlyRules = injectBusinessRules(base, contextStore('', '排除软删除'), 'c1', 'chat')[1].content as string;
    expect(onlyRules).not.toContain('domain context');
    expect(onlyRules).toContain(BUSINESS_RULES_HEADER);
  });

  it('无 connId / 无文本 时不注入', () => {
    expect(injectBusinessRules(base, contextStore('术语', '规则'), undefined, 'chat')).toBe(base);
    expect(injectBusinessRules(base, contextStore(), 'c1', 'chat')).toBe(base);
  });
});