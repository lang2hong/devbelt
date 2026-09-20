import { assertRecordId, assertU64Decimal, assertBase64UrlNoPad, assertBase64UrlRange } from './types.js';
import type { MementoLike } from './stateStore.js';

/**
 * 被权益门禁跳过的入站记录（仅密文）。
 *
 * 免费用户同步到未授权引擎（如 postgresql）的连接记录时，若直接丢弃并推进游标，
 * 升级后也不会补拉。此处按 userId+keyEpoch 持久化**远端密文**，权益放开后重放；
 * 明文不落盘（与 outbox 同一敏感边界）。
 */
export interface DeferredRecord {
  recordId: string;
  version: string;
  changeSequence: string;
  deleteTime: string | null;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
}

interface StoredRecord {
  version: string;
  changeSequence: string;
  deleteTime: string | null;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
}

interface DeferredData {
  records: Record<string, StoredRecord>;
}

/** 条目上限：未授权记录不应无限增长；超限丢最旧（changeSequence 最小）。 */
const MAX_DEFERRED_RECORDS = 1000;
const MAX_RECORD_CIPHERTEXT_BYTES = 256 * 1024;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateStored(recordId: string, raw: unknown): StoredRecord {
  if (!isPlainObject(raw)) throw new Error('corrupt deferred store: invalid record');
  assertRecordId(recordId, 'deferred.recordId');
  if (typeof raw.version !== 'string') throw new Error('corrupt deferred store: invalid version');
  assertU64Decimal(raw.version, 'deferred.version');
  if (typeof raw.changeSequence !== 'string') throw new Error('corrupt deferred store: invalid changeSequence');
  assertU64Decimal(raw.changeSequence, 'deferred.changeSequence', true);
  const deleteTime = raw.deleteTime;
  if (deleteTime !== null && typeof deleteTime !== 'string') {
    throw new Error('corrupt deferred store: invalid deleteTime');
  }
  const out: StoredRecord = {
    version: raw.version,
    changeSequence: raw.changeSequence,
    deleteTime: deleteTime === null ? null : String(deleteTime),
  };
  if (out.deleteTime === null) {
    // 非墓碑：必须携带完整密文三元组。
    if (typeof raw.nonce !== 'string' || typeof raw.ciphertext !== 'string' || typeof raw.tag !== 'string') {
      throw new Error('corrupt deferred store: missing ciphertext fields');
    }
    assertBase64UrlNoPad(raw.nonce, 12, 'deferred.nonce');
    assertBase64UrlRange(raw.ciphertext, 1, MAX_RECORD_CIPHERTEXT_BYTES, 'deferred.ciphertext');
    assertBase64UrlNoPad(raw.tag, 16, 'deferred.tag');
    out.nonce = raw.nonce;
    out.ciphertext = raw.ciphertext;
    out.tag = raw.tag;
  } else if (raw.nonce !== undefined || raw.ciphertext !== undefined || raw.tag !== undefined) {
    throw new Error('corrupt deferred store: tombstone must not carry ciphertext');
  }
  return out;
}

export class DeferredRecordStore {
  private static readonly KEY_PREFIX = 'devbelt.sync.deferred';

  private readonly key: string;
  private writeChain: Promise<void> = Promise.resolve();
  readonly userId: string;
  readonly keyEpoch: string;

  constructor(
    private readonly memento: MementoLike,
    userId: string,
    keyEpoch: string,
  ) {
    assertU64Decimal(userId, 'userId');
    assertU64Decimal(keyEpoch, 'keyEpoch');
    this.userId = userId;
    this.keyEpoch = keyEpoch;
    this.key = `${DeferredRecordStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  private read(): DeferredData {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return { records: {} };
    if (!isPlainObject(raw) || !isPlainObject(raw.records)) {
      throw new Error('corrupt deferred store: expected { records }');
    }
    const records: Record<string, StoredRecord> = {};
    for (const [recordId, entry] of Object.entries(raw.records)) {
      records[recordId] = validateStored(recordId, entry);
    }
    return { records };
  }

  private async write(data: DeferredData): Promise<void> {
    await this.memento.update(this.key, data);
  }

  private mutate(change: () => Promise<void>): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await change();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  list(): DeferredRecord[] {
    const data = this.read();
    return Object.entries(data.records).map(([recordId, entry]) => ({ recordId, ...entry }));
  }

  async put(rec: DeferredRecord): Promise<void> {
    assertRecordId(rec.recordId);
    const stored = validateStored(rec.recordId, rec);
    return this.mutate(async () => {
      const current = this.read();
      const records: Record<string, StoredRecord> = { ...current.records };
      records[rec.recordId] = stored;
      const ids = Object.keys(records);
      if (ids.length > MAX_DEFERRED_RECORDS) {
        // 丢最旧：changeSequence 最小者。
        ids.sort((a, b) => (BigInt(records[a].changeSequence) < BigInt(records[b].changeSequence) ? -1 : 1));
        for (const id of ids.slice(0, ids.length - MAX_DEFERRED_RECORDS)) delete records[id];
      }
      await this.write({ records });
    });
  }

  async delete(recordId: string): Promise<void> {
    assertRecordId(recordId);
    return this.mutate(async () => {
      const current = this.read();
      if (!(recordId in current.records)) return;
      const records: Record<string, StoredRecord> = { ...current.records };
      delete records[recordId];
      await this.write({ records });
    });
  }

  async clear(): Promise<void> {
    return this.mutate(async () => {
      await this.write({ records: {} });
    });
  }
}