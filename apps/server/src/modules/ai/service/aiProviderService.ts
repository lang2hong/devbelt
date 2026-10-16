import { ValidationError } from '../../../domain/errors.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AiProvider, AiProviderModel, IAiProviderRepo } from '../repository/aiProviderRepo.js';

const CODE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_MODELS = 50;
const MAX_MODEL_ID = 128;
const MAX_LABEL = 64;
const MAX_NAME = 64;
const MAX_URL = 255;

/**
 * baseUrl 规整：仅 https（厂商目录经服务端下发，用户的 API Key 会发往该地址，
 * 不接受明文 http）；禁止内嵌凭据/query/hash；去尾斜杠。
 */
export function normalizeProviderBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('invalid baseUrl');
  const text = raw.trim();
  if (!text || text.length > MAX_URL) throw new ValidationError('invalid baseUrl');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ValidationError('invalid baseUrl');
  }
  if (url.protocol !== 'https:') throw new ValidationError('baseUrl must use https');
  if (url.username || url.password || url.search || url.hash) throw new ValidationError('invalid baseUrl');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function str(raw: unknown, field: string, max: number): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || v.length > max) throw new ValidationError(`invalid ${field}`);
  return v;
}

export function validateProviderCode(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!CODE_RE.test(v)) throw new ValidationError('invalid code');
  return v;
}

export function validateProviderName(raw: unknown): { en: string; zh: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { en: str(o.en, 'name.en', MAX_NAME), zh: str(o.zh, 'name.zh', MAX_NAME) };
}

export function validateProviderModels(raw: unknown): AiProviderModel[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MODELS) throw new ValidationError('invalid models');
  const seen = new Set<string>();
  let defaults = 0;
  const out: AiProviderModel[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = str(o.id, 'model.id', MAX_MODEL_ID);
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f]/.test(id)) throw new ValidationError('invalid model.id');
    if (seen.has(id)) throw new ValidationError('duplicate model.id');
    seen.add(id);
    const model: AiProviderModel = { id };
    if (o.label !== undefined && o.label !== '') model.label = str(o.label, 'model.label', MAX_LABEL);
    if (o.default === true) {
      defaults += 1;
      model.default = true;
    }
    out.push(model);
  }
  if (defaults > 1) throw new ValidationError('at most one default model');
  return out;
}

export class AiProviderService {
  constructor(private readonly repo: IAiProviderRepo) {}

  /** 用户侧：仅启用项。 */
  listActive(): Promise<AiProvider[]> {
    return this.repo.listActive();
  }

  /** 管理视图：含停用。 */
  listAll(): Promise<AiProvider[]> {
    return this.repo.listAll();
  }

  /** 新增；code 重复返回 undefined（路由映射 409）。入参逐字段校验。 */
  async createInTx(
    tx: Queryable,
    input: { code: unknown; name: unknown; baseUrl: unknown; models: unknown; sortOrder?: number },
  ): Promise<AiProvider | undefined> {
    const provider: AiProvider = {
      code: validateProviderCode(input.code),
      name: validateProviderName(input.name),
      baseUrl: normalizeProviderBaseUrl(input.baseUrl),
      models: validateProviderModels(input.models),
      status: 'active',
      sortOrder: Number.isSafeInteger(input.sortOrder) ? (input.sortOrder as number) : 0,
    };
    const inserted = await this.repo.insertInTx(tx, provider);
    return inserted ? provider : undefined;
  }

  /** 更新；不存在返回 undefined。 */
  async updateInTx(
    tx: Queryable,
    code: string,
    input: { name?: unknown; baseUrl?: unknown; models?: unknown; status?: 'active' | 'disabled'; sortOrder?: number },
  ): Promise<AiProvider | undefined> {
    const patch: Parameters<IAiProviderRepo['updateInTx']>[2] = {};
    if (input.name !== undefined) patch.name = validateProviderName(input.name);
    if (input.baseUrl !== undefined) patch.baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    if (input.models !== undefined) patch.models = validateProviderModels(input.models);
    if (input.status !== undefined) patch.status = input.status;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    const ok = await this.repo.updateInTx(tx, code, patch);
    if (!ok) return undefined;
    return this.repo.findByCodeInTx(tx, code);
  }
}
