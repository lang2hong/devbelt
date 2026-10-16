import type { Queryable } from '../../src/repository/mysql/db.js';
import type { AiProvider, IAiProviderRepo } from '../../src/modules/ai/repository/aiProviderRepo.js';

/** 内存版厂商目录仓储（测试用）。 */
export class MemoryAiProviderRepo implements IAiProviderRepo {
  readonly rows = new Map<string, AiProvider>();

  seed(p: Partial<AiProvider> & { code: string }): void {
    this.rows.set(p.code, {
      name: { en: p.code, zh: p.code },
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1', default: true }],
      status: 'active',
      sortOrder: 0,
      ...p,
    });
  }

  private sorted(): AiProvider[] {
    return [...this.rows.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  async listActive(): Promise<AiProvider[]> {
    return this.sorted().filter((p) => p.status === 'active');
  }
  async listAll(): Promise<AiProvider[]> {
    return this.sorted();
  }
  async findByCodeInTx(_exec: Queryable, code: string): Promise<AiProvider | undefined> {
    return this.rows.get(code);
  }
  async insertInTx(_exec: Queryable, p: AiProvider): Promise<boolean> {
    if (this.rows.has(p.code)) return false;
    this.rows.set(p.code, p);
    return true;
  }
  async updateInTx(_exec: Queryable, code: string, patch: Partial<AiProvider>): Promise<boolean> {
    const cur = this.rows.get(code);
    if (!cur) return false;
    this.rows.set(code, { ...cur, ...patch });
    return true;
  }
}
