import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROVIDERS,
  chatEndpointOf,
  classifyTestError,
  isKnownProviderHost,
  normalizeBaseUrl,
  parseCatalogResponse,
  parseModelAccessSave,
} from '../../src/ai/modelAccess';

describe('normalizeBaseUrl（自定义地址规整）', () => {
  it('https 通过并去尾斜杠；http 回环通过', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toEqual({ ok: true, url: 'https://api.openai.com/v1' });
    expect(normalizeBaseUrl(' http://localhost:8000/v1 ')).toEqual({ ok: true, url: 'http://localhost:8000/v1' });
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1')).toEqual({ ok: true, url: 'http://127.0.0.1:11434/v1' });
  });
  it('远程 http 拒绝（insecure）；凭据/query/非 URL/超长拒绝（invalid）', () => {
    expect(normalizeBaseUrl('http://api.example.com/v1')).toEqual({ ok: false, reason: 'insecure' });
    for (const bad of ['https://u:p@a.com', 'https://a.com/v1?x=1', 'https://a.com/#h', 'not a url', '', 'https://a.com/' + 'x'.repeat(300), 42]) {
      expect(normalizeBaseUrl(bad as never)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('chatEndpointOf / isKnownProviderHost', () => {
  it('chat/completions 端点；已知厂商主机判定含自定义厂商', () => {
    expect(chatEndpointOf('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(isKnownProviderHost('https://api.openai.com/v1', BUILTIN_PROVIDERS)).toBe(true);
    expect(isKnownProviderHost('https://evil.example.com/v1', BUILTIN_PROVIDERS)).toBe(false);
    expect(isKnownProviderHost('https://myproxy.internal/v1', [], [{ id: 'cv-1', name: 'x', baseUrl: 'https://myproxy.internal/v1', models: [] }])).toBe(true);
  });
});

describe('parseCatalogResponse（目录按不可信输入校验）', () => {
  it('合法条目规整排序；https-only；坏条目跳过', () => {
    const items = parseCatalogResponse({
      items: [
        { code: 'bb', name: { en: 'B', zh: '乙' }, baseUrl: 'https://b.com/v1', models: [{ id: 'm', default: true }], sortOrder: 20 },
        { code: 'aa', name: { en: 'A', zh: '甲' }, baseUrl: 'https://a.com/v1', models: [{ id: 'm' }], sortOrder: 10 },
        { code: 'http', name: { en: 'H', zh: '丙' }, baseUrl: 'http://b.com/v1', models: [{ id: 'm' }], sortOrder: 5 },
        { code: 'Bad Code', name: { en: 'X', zh: 'X' }, baseUrl: 'https://x.com/v1', models: [{ id: 'm' }], sortOrder: 1 },
      ],
    });
    expect(items?.map((i) => i.code)).toEqual(['aa', 'bb']);
  });
  it('非数组/空结果 → undefined（回退内置）', () => {
    expect(parseCatalogResponse({})).toBeUndefined();
    expect(parseCatalogResponse({ items: [] })).toBeUndefined();
    expect(parseCatalogResponse(null)).toBeUndefined();
  });
});

describe('parseModelAccessSave（保存载荷校验）', () => {
  const base = {
    mode: 'openai-compatible' as const,
    vendorId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    customVendors: [],
    customModels: {},
    apiKey: '',
    clearKey: false,
    prefs: { selection: true, custom: true, key: true },
  };
  it('合法：规整 baseUrl；prefs 缺省全开；server-proxy 跳过地址校验', () => {
    const r = parseModelAccessSave({ ...base, baseUrl: 'https://api.openai.com/v1/' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.baseUrl).toBe('https://api.openai.com/v1');
    const sp = parseModelAccessSave({ ...base, mode: 'server-proxy', baseUrl: '' });
    expect(sp.ok).toBe(true);
    if (sp.ok) expect(sp.value.baseUrl).toBe('');
  });

  it('非法：远程 http 地址（insecure）/ 缺 model / apiKey 带空白 / 自定义厂商缺字段', () => {
    expect(parseModelAccessSave({ ...base, baseUrl: 'http://api.example.com/v1' })).toMatchObject({ ok: false, error: 'insecure' });
    expect(parseModelAccessSave({ ...base, model: ' ' })).toMatchObject({ ok: false, error: 'model' });
    expect(parseModelAccessSave({ ...base, apiKey: 'sk 123' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(parseModelAccessSave({ ...base, customVendors: [{ id: 'cv-1', name: 'x', baseUrl: 'http://remote.com/v1', models: [] }] })).toMatchObject({ ok: false, error: 'vendors' });
    expect(parseModelAccessSave({ ...base, customVendors: [{ id: 'cv-1', name: '', baseUrl: 'https://a.com', models: [] }] })).toMatchObject({ ok: false, error: 'vendors' });
    expect(parseModelAccessSave('x')).toMatchObject({ ok: false, error: 'invalid' });
    expect(parseModelAccessSave({ ...base, mode: 'weird' })).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('classifyTestError（失败 → 稳定原因码）', () => {
  it('按状态码与错误文本映射；detail 单行截断', () => {
    expect(classifyTestError({ status: 401 }, 12).code).toBe('auth');
    expect(classifyTestError({ status: 429 }, 12).code).toBe('rate');
    expect(classifyTestError({ status: 503 }, 12).code).toBe('server');
    expect(classifyTestError({ message: 'HTTP 404 model not found' }, 12).code).toBe('model');
    expect(classifyTestError({ message: 'fetch failed' }, 12).code).toBe('network');
    expect(classifyTestError(new Error('operation was aborted'), 12).code).toBe('timeout');
    expect(classifyTestError({ message: 'weird\n\n\tfailure  ' }, 12).detail).toBe('weird failure');
  });
});
