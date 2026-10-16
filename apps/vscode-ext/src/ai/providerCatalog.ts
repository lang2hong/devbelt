import { BUILTIN_PROVIDERS, parseCatalogResponse, type CatalogProvider } from './modelAccess.js';

/** Memento 最小面。 */
export interface CatalogMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const CACHE_KEY = 'devbelt.ai.providerCatalog';
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface CacheEntry {
  at: number;
  items: CatalogProvider[];
}

/**
 * 厂商目录：服务端（管理后台维护）→ Memento 缓存（1h TTL；失败时过期缓存仍可用）→ 内置兜底。
 * 服务端响应按不可信输入校验（`parseCatalogResponse`：仅 https 地址、字段/长度白名单）。
 */
export class ProviderCatalog {
  constructor(
    private readonly memento: CatalogMemento,
    private readonly serverUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(force = false): Promise<CatalogProvider[]> {
    const cached = this.memento.get<CacheEntry>(CACHE_KEY);
    if (!force && cached && this.now() - cached.at < TTL_MS && cached.items.length > 0) return cached.items;
    const fresh = await this.fetchRemote();
    if (fresh) {
      await this.memento.update(CACHE_KEY, { at: this.now(), items: fresh } satisfies CacheEntry);
      return fresh;
    }
    if (cached?.items?.length) return cached.items;
    return [...BUILTIN_PROVIDERS];
  }

  private async fetchRemote(): Promise<CatalogProvider[] | undefined> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.serverUrl.replace(/\/+$/, '')}/api/ai/providers`, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) return undefined;
      return parseCatalogResponse(await res.json());
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
