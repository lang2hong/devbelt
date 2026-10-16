import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/** AI 模型厂商目录仓储（自带 Key 模式的预设；管理后台维护）。 */

export interface AiProviderModel {
  id: string;
  label?: string;
  default?: boolean;
}

export interface AiProvider {
  code: string;
  name: { en: string; zh: string };
  baseUrl: string;
  models: AiProviderModel[];
  status: 'active' | 'disabled';
  sortOrder: number;
}

export interface IAiProviderRepo {
  listActive(): Promise<AiProvider[]>;
  listAll(): Promise<AiProvider[]>;
  findByCodeInTx(exec: Queryable, code: string): Promise<AiProvider | undefined>;
  /** 新增；code 已存在返回 false。 */
  insertInTx(exec: Queryable, provider: AiProvider): Promise<boolean>;
  updateInTx(
    exec: Queryable,
    code: string,
    patch: Partial<Pick<AiProvider, 'name' | 'baseUrl' | 'models' | 'status' | 'sortOrder'>>,
  ): Promise<boolean>;
}

const COLS = 'code, name_json, base_url, models_json, status, sort_order';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw && typeof raw === 'object') return raw as T;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function mapProvider(r: Record<string, unknown>): AiProvider {
  const name = parseJson<{ en?: string; zh?: string }>(r.name_json, {});
  return {
    code: String(r.code),
    name: { en: String(name.en ?? r.code), zh: String(name.zh ?? r.code) },
    baseUrl: String(r.base_url),
    models: parseJson<AiProviderModel[]>(r.models_json, []),
    status: r.status === 'disabled' ? 'disabled' : 'active',
    sortOrder: Number(r.sort_order ?? 0),
  };
}

export class MysqlAiProviderRepo implements IAiProviderRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async listActive(): Promise<AiProvider[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${COLS} FROM ai_providers WHERE status = 'active' ORDER BY sort_order ASC, id ASC`,
    );
    return rows.map(mapProvider);
  }

  async listAll(): Promise<AiProvider[]> {
    const [rows] = await this.db().query<any[]>(`SELECT ${COLS} FROM ai_providers ORDER BY sort_order ASC, id ASC`);
    return rows.map(mapProvider);
  }

  async findByCodeInTx(exec: Queryable, code: string): Promise<AiProvider | undefined> {
    const [rows] = await exec.query<any[]>(`SELECT ${COLS} FROM ai_providers WHERE code = ?`, [code]);
    return rows[0] ? mapProvider(rows[0]) : undefined;
  }

  async insertInTx(exec: Queryable, p: AiProvider): Promise<boolean> {
    const [result] = await exec.query<any>(
      `INSERT INTO ai_providers (code, name_json, base_url, models_json, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE code = code`,
      [p.code, JSON.stringify(p.name), p.baseUrl, JSON.stringify(p.models), p.status, p.sortOrder],
    );
    return Number(result?.affectedRows ?? 0) === 1;
  }

  async updateInTx(
    exec: Queryable,
    code: string,
    patch: Partial<Pick<AiProvider, 'name' | 'baseUrl' | 'models' | 'status' | 'sortOrder'>>,
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name_json = ?');
      params.push(JSON.stringify(patch.name));
    }
    if (patch.baseUrl !== undefined) {
      sets.push('base_url = ?');
      params.push(patch.baseUrl);
    }
    if (patch.models !== undefined) {
      sets.push('models_json = ?');
      params.push(JSON.stringify(patch.models));
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sortOrder);
    }
    if (sets.length === 0) return true;
    const [result] = await exec.query<any>(`UPDATE ai_providers SET ${sets.join(', ')} WHERE code = ?`, [...params, code]);
    return Number(result?.affectedRows ?? 0) > 0;
  }
}
