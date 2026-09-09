import { createHash } from 'crypto';
import { IdempotencyKeyReusedError, IdempotencyInProgressError, ValidationError } from '../domain/errors.js';
import type { IIdempotencyReceiptRepo } from '../repository/interfaces.js';
import type { IdempotencyReceipt } from '../domain/entities.js';
import type { TxRunner, Queryable } from '../repository/mysql/db.js';

/** 回执在线保留 24 小时（§6.1）。关闭组织经 `retentionMs` 传 30 天（切片 3）；订阅调整/禁用用户的 30 天属切片 4。 */
const RECEIPT_RETENTION_MS = 24 * 3600 * 1000;

/** Idempotency-Key：canonical RFC 4122 UUIDv4（version=4，variant=[89ab]）。 */
const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

export interface IdempotencyRunInput {
  actorUserId: number;
  sessionId: string;
  method: string;
  normalizedPath: string;
  idempotencyKey: string;
  requestBody?: unknown;
  /** 回执保留毫秒数。默认 24h；关闭组织等须 30d（§6.1）。 */
  retentionMs?: number;
  /**
   * 首次执行前置（例如限流）：在 createProcessing 之后、business 之前，于**同一事务**上执行。
   * 仅并发胜者（成功插入回执者）触达；限流须用 exec（Queryable）计数，与回执、业务写、审计同滚，
   * 保证失败整体回滚、不留下可恢复失败的 processing 回执。
   */
  beforeWrite?: (tx: Queryable) => Promise<void>;
  /** 业务写入 + 事务内审计；在（调用方传入事务上）执行。 */
  business: (tx: Queryable) => Promise<{ status: number; body: unknown }>;
}

export interface IdempotencyRunResult {
  status: number;
  body: unknown;
  /** true = 同键同摘要重放（未重跑业务写与审计）。 */
  replayed: boolean;
}

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

/** 规范 JSON：递归按键排序、无空白；空 body → 空串。用于请求摘要与响应体缓存。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 校验 Idempotency-Key 头；缺失/多值/非法（非 UUIDv4）抛 ValidationError（各作用域映射 400/422）。 */
export function validateIdempotencyKey(raw: string | string[] | undefined): string {
  if (Array.isArray(raw) || typeof raw !== 'string' || !IDEMPOTENCY_KEY_RE.test(raw)) {
    throw new ValidationError('Idempotency-Key must be a canonical UUIDv4');
  }
  return raw;
}

function isDuplicateKey(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === ER_DUP_ENTRY;
}

/**
 * 幂等原语（P3 §6.1）。
 *
 * 同键同摘要 → 重放首次响应（不重跑业务、不重复审计）；同键异摘要 → 409 IDEMPOTENCY_KEY_REUSED；
 * 仍在处理中 → 等待至多 `maxWaitMs` 后未决 → 409 IDEMPOTENCY_IN_PROGRESS。
 * 首次请求在**单事务**内：createProcessing → beforeWrite(tx)（如限流，同连接计数）→
 * business(tx)（业务写 + insertInTx 审计）→ complete；失败整体回滚，receipt、限流计数、
 * 业务与审计同滚。并发同 key 由唯一键串行化：败者 INSERT 阻塞至胜者提交后得 ER_DUP_ENTRY，
 * 回滚并重读重放/冲突——胜者独享 beforeWrite，且不产生跨事务的 processing 残留。
 */
export class IdempotencyService {
  constructor(
    private readonly receiptRepo: IIdempotencyReceiptRepo,
    private readonly runner: TxRunner,
    private readonly maxWaitMs: number = 5000,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async run(input: IdempotencyRunInput): Promise<IdempotencyRunResult> {
    const digest = sha256(canonicalJson(input.requestBody));
    const key = {
      actorUserId: input.actorUserId,
      sessionId: input.sessionId,
      method: input.method,
      normalizedPath: input.normalizedPath,
      idempotencyKey: input.idempotencyKey,
    };

    // 预检（事务外，连接池读）：快速短路重放/冲突/处理中。
    const existing = await this.receiptRepo.findByKey(key.actorUserId, key.sessionId, key.method, key.normalizedPath, key.idempotencyKey);
    if (existing) {
      return this.resolve(existing, digest, key);
    }

    const expiresTime = new Date(Date.now() + (input.retentionMs ?? RECEIPT_RETENTION_MS));

    // 首次：单事务 createProcessing → beforeWrite(tx) → business(tx) → complete。
    // 唯一键串行化并发：并发败者的 INSERT 阻塞于唯一键，待胜者提交（completed）后抛
    // ER_DUP_ENTRY → 回滚本事务 → 重读并按 completed 回放/冲突。
    let duplicate = false;
    try {
      return await this.runner(async (tx) => {
        const receipt = await this.receiptRepo.createProcessing(tx, { ...key, requestDigest: digest, expiresTime });
        await input.beforeWrite?.(tx);
        const result = await input.business(tx);
        await this.receiptRepo.complete(tx, receipt.id, result.status, canonicalJson(result.body));
        return { status: result.status, body: result.body, replayed: false };
      });
    } catch (e) {
      if (isDuplicateKey(e)) duplicate = true;
      else throw e;
    }

    if (duplicate) {
      // 唯一键冲突：并发请求先提交，回滚后重读并重放/冲突。
      const resolved = await this.receiptRepo.findByKey(key.actorUserId, key.sessionId, key.method, key.normalizedPath, key.idempotencyKey);
      if (resolved) return this.resolve(resolved, digest, key);
    }
    // 并发请求消失（其事务被回滚清除）或仍处理中 → 409 in-progress。
    throw new IdempotencyInProgressError();
  }

  private async resolve(
    receipt: IdempotencyReceipt,
    digest: Buffer,
    key: { actorUserId: number; sessionId: string; method: string; normalizedPath: string; idempotencyKey: string },
  ): Promise<IdempotencyRunResult> {
    // 摘要不同 → 立即冲突（即使仍在 processing，§6.1 要求立即 409 KEY_REUSED）。
    if (!receipt.requestDigest.equals(digest)) throw new IdempotencyKeyReusedError();
    if (receipt.status === 'completed') {
      const body = receipt.responseBody == null ? null : JSON.parse(receipt.responseBody);
      return { status: receipt.httpStatus ?? 200, body, replayed: true };
    }
    // processing：仅同摘要才允许有界等待。
    const deadline = Date.now() + this.maxWaitMs;
    while (Date.now() < deadline) {
      await this.sleep(200);
      const latest = await this.receiptRepo.findByKey(key.actorUserId, key.sessionId, key.method, key.normalizedPath, key.idempotencyKey);
      if (!latest) break;
      if (latest.requestDigest.equals(digest) && latest.status === 'completed') {
        const body = latest.responseBody == null ? null : JSON.parse(latest.responseBody);
        return { status: latest.httpStatus ?? 200, body, replayed: true };
      }
    }
    throw new IdempotencyInProgressError();
  }
}