import { assertBase64UrlNoPad, assertRecordId, assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * 待推送 mutation outbox（B3b，§8.1.8 nonce/receipt 不可复用语义）。
 *
 * 持久化完整已签名 record mutation，使请求发出后能原样重放（同 mutationId/nonce/
 * ciphertext/digest/signature）。不存明文连接、DEK、SMP 或私钥。键按 userId+keyEpoch
 * 隔离。分判联合：
 *  - `record.put`：必须含 nonce/ciphertext/tag（§8.1.7 PutRecordRequest）。
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

export class PendingMutationStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.v3.outbox';

  private readonly key: string;

  constructor(
    private readonly memento: MementoLike,
    userId: string,
    keyEpoch: string,
  ) {
    assertU64Decimal(userId, 'userId');
    assertU64Decimal(keyEpoch, 'keyEpoch');
    this.key = `${PendingMutationStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  list(): PendingMutation[] {
    const raw = this.memento.get<PendingMutation[]>(this.key);
    return Array.isArray(raw) ? raw : [];
  }

  async put(m: PendingMutation): Promise<void> {
    assertBase(m.recordId, m.connectionId, m.baseVersion, m.mutationId, m.signature, m.requestDigest);
    if (m.action === 'record.put') {
      assertBase64UrlNoPad(m.nonce, 12, 'nonce');
      if (typeof m.ciphertext !== 'string') throw new Error('put mutation requires ciphertext');
      assertBase64UrlNoPad(m.tag, 16, 'tag');
    } else if (m.action === 'record.delete') {
      if ('nonce' in m) throw new Error('delete mutation must not carry nonce');
      if ('ciphertext' in m) throw new Error('delete mutation must not carry ciphertext');
      if ('tag' in m) throw new Error('delete mutation must not carry tag');
    } else {
      throw new Error(`invalid mutation action: ${(m as { action: string }).action}`);
    }
    await this.write([...this.list(), m]);
  }

  async delete(mutationId: string): Promise<void> {
    await this.write(this.list().filter((m) => m.mutationId !== mutationId));
  }

  async clear(): Promise<void> {
    await this.write([]);
  }

  private async write(list: PendingMutation[]): Promise<void> {
    await this.memento.update(this.key, list);
  }
}