import { assertBase64UrlNoPad, assertRecordId, assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * 待推送 mutation outbox（B3b，§8.1.8 nonce/receipt 不可复用语义）。
 *
 * 持久化完整已签名 record mutation，使请求发出后能原样重放（同 mutationId/nonce/
 * ciphertext/digest/signature）。不存明文连接、DEK、SMP 或私钥。键按 userId+keyEpoch 隔离。
 */

export interface PendingMutation {
  action: 'record.put' | 'record.delete';
  recordId: string;
  connectionId: string;
  baseVersion: string;
  mutationId: string;
  nonce: string;
  ciphertext?: string;
  tag?: string;
  signature: string;
  requestDigest: string;
}

function assertConnectionId(id: string): void {
  if (!id) throw new Error('connectionId must not be empty');
  if (id.startsWith('org:')) throw new Error('organization connection must not enter outbox');
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

  put(m: PendingMutation): void {
    if (m.action !== 'record.put' && m.action !== 'record.delete') throw new Error('invalid mutation action');
    assertRecordId(m.recordId);
    assertConnectionId(m.connectionId);
    assertU64Decimal(m.baseVersion, 'baseVersion', true);
    assertBase64UrlNoPad(m.mutationId, 16, 'mutationId');
    assertBase64UrlNoPad(m.nonce, 12, 'nonce');
    assertBase64UrlNoPad(m.signature, 64, 'signature');
    assertBase64UrlNoPad(m.requestDigest, 32, 'requestDigest');
    if (m.action === 'record.put') {
      if (typeof m.ciphertext !== 'string') throw new Error('put mutation requires ciphertext');
      if (typeof m.tag !== 'string') throw new Error('put mutation requires tag');
      assertBase64UrlNoPad(m.tag, 16, 'tag');
    }
    this.write([...this.list(), m]);
  }

  delete(mutationId: string): void {
    this.write(this.list().filter((m) => m.mutationId !== mutationId));
  }

  clear(): void {
    this.write([]);
  }

  private write(list: PendingMutation[]): void {
    void this.memento.update(this.key, list);
  }
}