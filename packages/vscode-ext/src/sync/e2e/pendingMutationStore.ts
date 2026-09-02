import { assertBase64UrlNoPad, assertRecordId, assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * 待推送 mutation outbox。
 *
 * 持久化完整已签名 record mutation，使请求发出后能原样重放（同 mutationId/nonce/
 * ciphertext/digest/signature）。不存明文连接、DEK、SMP 或私钥。键按 userId+keyEpoch
 * 隔离。分判联合：
 *  - `record.put`：必须含 nonce/ciphertext/tag（§7.5.1）。
 *  - `record.delete`：禁止 nonce/ciphertext/tag（DeleteRecordRequest 无这些字段）。
 */

interface PendingBase {
  recordId: string;
  connectionId: string;
  baseVersion: string;
  mutationId: string;
  signature: string;
  requestDigest: string;
}

export interface PendingPutMutation extends PendingBase {
  action: 'record.put';
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface PendingDeleteMutation extends PendingBase {
  action: 'record.delete';
}

export type PendingMutation = PendingPutMutation | PendingDeleteMutation;

function assertConnectionId(id: string): void {
  if (!id) throw new Error('connectionId must not be empty');
  if (id.startsWith('org:')) throw new Error('organization connection must not enter outbox');
}

function assertBase(recordId: string, connectionId: string, baseVersion: string, mutationId: string, signature: string, requestDigest: string): void {
  assertRecordId(recordId);
  assertConnectionId(connectionId);
  assertU64Decimal(baseVersion, 'baseVersion', true);
  assertBase64UrlNoPad(mutationId, 16, 'mutationId');
  assertBase64UrlNoPad(signature, 64, 'signature');
  assertBase64UrlNoPad(requestDigest, 32, 'requestDigest');
}

/** 全量协议校验：形状 + 字段长度/编码。put() 写入与 list() 读取共用同一口径。 */
function assertMutation(m: unknown): asserts m is PendingMutation {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    throw new Error('corrupt outbox entry: expected object');
  }
  const o = m as Record<string, unknown>;
  if (o.action !== 'record.put' && o.action !== 'record.delete') {
    throw new Error('corrupt outbox entry: invalid action');
  }
  if (typeof o.recordId !== 'string' || typeof o.connectionId !== 'string' ||
    typeof o.baseVersion !== 'string' || typeof o.mutationId !== 'string' ||
    typeof o.signature !== 'string' || typeof o.requestDigest !== 'string') {
    throw new Error('corrupt outbox entry: missing base field');
  }
  assertBase(o.recordId, o.connectionId, o.baseVersion, o.mutationId, o.signature, o.requestDigest);
  if (o.action === 'record.put') {
    if (typeof o.nonce !== 'string' || typeof o.ciphertext !== 'string' || typeof o.tag !== 'string') {
      throw new Error('corrupt outbox entry: put requires nonce/ciphertext/tag');
    }
    assertBase64UrlNoPad(o.nonce, 12, 'nonce');
    assertBase64UrlNoPad(o.tag, 16, 'tag');
  } else if ('nonce' in o) {
    throw new Error('corrupt outbox entry: delete must not carry nonce');
  } else if ('ciphertext' in o) {
    throw new Error('corrupt outbox entry: delete must not carry ciphertext');
  } else if ('tag' in o) {
    throw new Error('corrupt outbox entry: delete must not carry tag');
  }
}

export class PendingMutationStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.outbox';

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
    this.key = `${PendingMutationStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  list(): PendingMutation[] {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error('corrupt outbox: expected array');
    for (const item of raw) assertMutation(item);
    return raw as PendingMutation[];
  }

  async put(m: PendingMutation): Promise<void> {
    assertMutation(m);
    await this.mutate((list) => [...list, m]);
  }

  async delete(mutationId: string): Promise<void> {
    await this.mutate((list) => list.filter((m) => m.mutationId !== mutationId));
  }

  async clear(): Promise<void> {
    await this.mutate(() => []);
  }

  private mutate(change: (list: PendingMutation[]) => PendingMutation[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await this.write(change(this.list()));
    });
    // Keep subsequent operations usable after a persistence failure while returning the failure
    // to the caller that initiated it.
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  private async write(list: PendingMutation[]): Promise<void> {
    await this.memento.update(this.key, list);
  }
}
