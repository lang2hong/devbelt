import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockEventEmitter<T> {
    private listeners = new Set<(e: T) => void>();
    readonly event = (listener: (e: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const l of this.listeners) l(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return { EventEmitter: MockEventEmitter };
});

import { AiKeyStore, AI_API_KEY_SECRET } from '../../src/ai/aiKeyStore';

function makeSecrets(): {
  secrets: any;
  values: Map<string, string>;
  change: (key: string) => void;
} {
  const values = new Map<string, string>();
  const listeners = new Set<(e: { key: string }) => void>();
  const secrets = {
    async get(key: string): Promise<string | undefined> {
      return values.get(key);
    },
    async store(key: string, value: string): Promise<void> {
      values.set(key, value);
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
    },
    onDidChange(listener: (e: { key: string }) => void): { dispose(): void } {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    _fire(key: string): void {
      for (const l of listeners) l({ key });
    },
  };
  return {
    secrets,
    values,
    change: (key) => secrets._fire(key),
  };
}

describe('AiKeyStore（SecretStorage 封装）', () => {
  it('set/get/clear + 空串视为未配置', async () => {
    const { secrets, values } = makeSecrets();
    const store = new AiKeyStore(secrets);
    expect(await store.getApiKey()).toBeUndefined();
    expect(await store.hasApiKey()).toBe(false);

    await store.setApiKey('  sk-123  ');
    expect(values.get(AI_API_KEY_SECRET)).toBe('sk-123');
    expect(await store.getApiKey()).toBe('sk-123');
    expect(await store.hasApiKey()).toBe(true);

    await store.setApiKey('   ');
    expect(await store.getApiKey()).toBeUndefined();
    expect(values.has(AI_API_KEY_SECRET)).toBe(false);
  });

  it('读取带缓存：重复 get 不重复读 SecretStorage', async () => {
    const { secrets } = makeSecrets();
    const spy = vi.spyOn(secrets, 'get');
    const store = new AiKeyStore(secrets);
    await store.getApiKey();
    await store.getApiKey();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('外部（其他窗口）变更 → 缓存失效并广播 onDidChange', async () => {
    const { secrets, values, change } = makeSecrets();
    const store = new AiKeyStore(secrets);
    await store.getApiKey();

    const changed = vi.fn();
    store.onDidChange(changed);
    values.set(AI_API_KEY_SECRET, 'sk-external');
    change(AI_API_KEY_SECRET);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(await store.getApiKey()).toBe('sk-external');
  });

  it('无关键变更不失效缓存', async () => {
    const { secrets, change } = makeSecrets();
    const spy = vi.spyOn(secrets, 'get');
    const store = new AiKeyStore(secrets);
    await store.getApiKey();
    change('other.key');
    await store.getApiKey();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});