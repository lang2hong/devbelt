import { describe, expect, it } from 'vitest';
import {
  AiProviderService,
  normalizeProviderBaseUrl,
  validateProviderCode,
  validateProviderModels,
} from '../../src/modules/ai/service/aiProviderService.js';
import { MemoryAiProviderRepo } from '../helpers/fakeAiProviderRepo.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const tx = {} as Queryable;

describe('normalizeProviderBaseUrl', () => {
  it('https 通过并去尾斜杠；保留路径', () => {
    expect(normalizeProviderBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normalizeProviderBaseUrl(' https://a.b.c ')).toBe('https://a.b.c');
  });
  it('拒绝 http / 内嵌凭据 / query / hash / 非 URL / 超长', () => {
    for (const bad of ['http://a.com/v1', 'https://u:p@a.com', 'https://a.com/v1?x=1', 'https://a.com/#h', 'not a url', '', 'https://a.com/' + 'x'.repeat(300)]) {
      expect(() => normalizeProviderBaseUrl(bad)).toThrow();
    }
    expect(() => normalizeProviderBaseUrl(123)).toThrow();
  });
});

describe('validateProviderCode / Models', () => {
  it('code 规则', () => {
    expect(validateProviderCode('open-ai_1')).toBe('open-ai_1');
    for (const bad of ['', 'A', 'Upper', '1abc', 'a', 'has space', 'x'.repeat(40)]) expect(() => validateProviderCode(bad)).toThrow();
  });
  it('models：1..50、id 无空白、不重复、至多一个 default', () => {
    expect(validateProviderModels([{ id: 'a', default: true }, { id: 'b', label: 'B' }])).toEqual([
      { id: 'a', default: true },
      { id: 'b', label: 'B' },
    ]);
    expect(() => validateProviderModels([])).toThrow();
    expect(() => validateProviderModels([{ id: 'a b' }])).toThrow();
    expect(() => validateProviderModels([{ id: 'a' }, { id: 'a' }])).toThrow();
    expect(() => validateProviderModels([{ id: 'a', default: true }, { id: 'b', default: true }])).toThrow();
    expect(() => validateProviderModels(Array.from({ length: 51 }, (_, i) => ({ id: `m${i}` })))).toThrow();
  });
});

describe('AiProviderService', () => {
  it('create：成功 / 重复 code 返回 undefined / 非法入参抛错', async () => {
    const repo = new MemoryAiProviderRepo();
    const svc = new AiProviderService(repo);
    const input = { code: 'acme', name: { en: 'Acme', zh: 'Acme' }, baseUrl: 'https://api.acme.com/v1/', models: [{ id: 'x', default: true }] };
    const created = await svc.createInTx(tx, input);
    expect(created?.baseUrl).toBe('https://api.acme.com/v1');
    expect(await svc.createInTx(tx, input)).toBeUndefined();
    await expect(svc.createInTx(tx, { ...input, code: 'bad code' })).rejects.toThrow();
    await expect(svc.createInTx(tx, { ...input, code: 'acme2', baseUrl: 'http://x.com' })).rejects.toThrow();
  });

  it('update：停用后 listActive 不含；未知 code → undefined', async () => {
    const repo = new MemoryAiProviderRepo();
    repo.seed({ code: 'a' });
    repo.seed({ code: 'b', sortOrder: 1 });
    const svc = new AiProviderService(repo);
    expect((await svc.updateInTx(tx, 'a', { status: 'disabled' }))?.status).toBe('disabled');
    expect((await svc.listActive()).map((p) => p.code)).toEqual(['b']);
    expect((await svc.listAll()).map((p) => p.code)).toEqual(['a', 'b']);
    expect(await svc.updateInTx(tx, 'nope', { sortOrder: 3 })).toBeUndefined();
  });
});
