import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(async () => undefined), showWarningMessage: vi.fn(async () => undefined) },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  env: { language: 'en' },
}));

import type { ElasticsearchConnectionSession } from '../../src/connection/connectionSession';
import { executeEsDsl } from '../../src/ai/esExec';

function fakeSession(response: { status: number; body: unknown }): {
  session: ElasticsearchConnectionSession;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => ({ status: response.status, headers: {}, body: response.body, tookMs: 1 }));
  const session = { kind: 'elasticsearch', es: { request } } as unknown as ElasticsearchConnectionSession;
  return { session, request };
}

describe('executeEsDsl（AI DSL 执行桥）', () => {
  it('成功：固定 POST /<index>/_search、默认 size 注入、摘要含 total/took/hit 预览', async () => {
    const { session, request } = fakeSession({
      status: 200,
      body: {
        took: 3,
        timed_out: false,
        hits: { total: { value: 2, relation: 'eq' }, hits: [{ _id: '1', _source: { a: 1 } }, { _id: '2', _source: { b: 2 } }] },
      },
    });
    const result = await executeEsDsl(session, 'orders', '{"query":{"match_all":{}}}');
    expect(result.isError).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, body] = request.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(method).toBe('POST');
    expect(path).toBe('/orders/_search');
    expect(body.size).toBe(20);
    const payload = JSON.parse(result.content) as {
      index: string;
      took: number;
      total: number;
      hits: Array<{ _id: string; _source: unknown }>;
    };
    expect(payload.index).toBe('orders');
    expect(payload.took).toBe(3);
    expect(payload.total).toBe(2);
    expect(payload.hits).toHaveLength(2);
    expect(payload.hits[0]?._id).toBe('1');
  });

  it('聚合结果 → aggregations JSON（优先于 hits 通道）', async () => {
    const { session } = fakeSession({
      status: 200,
      body: {
        took: 7,
        aggregations: { by_status: { buckets: [{ key: 'ok', doc_count: 3 }] } },
        hits: { total: { value: 3, relation: 'eq' }, hits: [] },
      },
    });
    const result = await executeEsDsl(session, 'orders', '{"aggs":{"by_status":{"terms":{"field":"status"}}}}');
    const payload = JSON.parse(result.content) as { aggregations?: { by_status?: unknown }; hits?: unknown };
    expect(result.isError).toBe(false);
    expect(payload.aggregations?.by_status).toBeTruthy();
    expect(payload.hits).toBeUndefined();
  });

  it('模型给了 size → 不覆盖；索引名转义进路径', async () => {
    const { session, request } = fakeSession({ status: 200, body: { hits: { hits: [] } } });
    await executeEsDsl(session, 'log-2026.01', '{"size":5,"query":{"match_all":{}}}');
    const [, path, body] = request.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(path).toBe('/log-2026.01/_search');
    expect(body.size).toBe(5);
  });

  it('过大 size → 钳制到 HIT_LIMIT 防全量缓冲（数字/字符串/非法值归一）', async () => {
    const { session, request } = fakeSession({ status: 200, body: { hits: { hits: [] } } });
    await executeEsDsl(session, 'orders', '{"size":100000,"query":{"match_all":{}}}');
    expect((request.mock.calls[0][2] as Record<string, unknown>).size).toBe(20);
    await executeEsDsl(session, 'orders', '{"size":"100000","query":{"match_all":{}}}');
    expect((request.mock.calls[1][2] as Record<string, unknown>).size).toBe(20);
    await executeEsDsl(session, 'orders', '{"size":-1,"query":{"match_all":{}}}');
    expect((request.mock.calls[2][2] as Record<string, unknown>).size).toBe(20);
  });

  it('suggest 结果 → suggest 通道（优先于空 hits）', async () => {
    const { session } = fakeSession({
      status: 200,
      body: {
        took: 2,
        hits: { total: { value: 0, relation: 'eq' }, hits: [] },
        suggest: { mysug: [{ text: 'x', options: [{ text: 'y', score: 0.9 }] }] },
      },
    });
    const result = await executeEsDsl(session, 'orders', '{"suggest":{"mysug":{"text":"x","term":{"field":"name"}}}}');
    const payload = JSON.parse(result.content) as { suggest?: unknown; hits?: unknown };
    expect(result.isError).toBe(false);
    expect(payload.suggest).toBeTruthy();
    expect(payload.hits).toBeUndefined();
  });

  it('超大 _source → 按预算截断为字符串', async () => {
    const big = 'x'.repeat(3000);
    const { session } = fakeSession({
      status: 200,
      body: { took: 1, hits: { total: { value: 1, relation: 'eq' }, hits: [{ _id: '1', _source: { big } }] } },
    });
    const result = await executeEsDsl(session, 'orders', '{"query":{"match_all":{}}}');
    const payload = JSON.parse(result.content) as { hits: Array<{ _source: unknown }> };
    expect(typeof payload.hits[0]._source).toBe('string');
    expect(String(payload.hits[0]._source)).toContain('(truncated)');
  });

  it('HTTP 4xx → 错误摘要（含 reason）；非法 JSON / 数组 → 直接失败不请求', async () => {
    const { session, request } = fakeSession({ status: 400, body: { error: { type: 'parsing_exception', reason: 'bad field' } } });
    const http = await executeEsDsl(session, 'orders', '{"query":{"bad":1}}');
    expect(http.isError).toBe(true);
    expect(http.content).toContain('bad field');

    const invalid = await executeEsDsl(session, 'orders', '{ bad ');
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('valid JSON');

    const arr = await executeEsDsl(session, 'orders', '[1,2]');
    expect(arr.isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(1); // 仅上一个 4xx 用例发出过请求
  });

  it('网络异常 → 错误摘要不抛', async () => {
    const request = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const session = { kind: 'elasticsearch', es: { request } } as unknown as ElasticsearchConnectionSession;
    const result = await executeEsDsl(session, 'orders', '{"query":{"match_all":{}}}');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ECONNREFUSED');
  });
});
