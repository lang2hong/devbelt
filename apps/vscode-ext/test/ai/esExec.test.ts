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
    expect(result.content).toContain('2 hit(s)');
    expect(result.content).toContain('_id=1');
  });

  it('模型给了 size → 不覆盖；索引名转义进路径', async () => {
    const { session, request } = fakeSession({ status: 200, body: { hits: { hits: [] } } });
    await executeEsDsl(session, 'log-2026.01', '{"size":5,"query":{"match_all":{}}}');
    const [, path, body] = request.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(path).toBe('/log-2026.01/_search');
    expect(body.size).toBe(5);
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
