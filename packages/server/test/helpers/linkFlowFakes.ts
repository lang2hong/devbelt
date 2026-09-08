import type { IAuditRepo, IMailFlowRepo } from '../../src/repository/interfaces.js';
import type { AuditEvent, MailFlow } from '../../src/domain/entities.js';
import type { MailFlowType } from '../../src/domain/enums.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

/** 内存邮件流假实现：以 nonceHash hex 为键。 */
export class FakeMailFlowRepo implements IMailFlowRepo {
  readonly store = new Map<string, MailFlow>();
  private id = 1;

  async create(input: {
    type: MailFlowType;
    targetTokenHash: Buffer;
    targetRecordId: number | null;
    userId: number | null;
    nonceHash: Buffer;
    expiresTime: Date;
  }): Promise<MailFlow> {
    const flow: MailFlow = {
      id: this.id++,
      type: input.type,
      targetTokenHash: input.targetTokenHash,
      targetRecordId: input.targetRecordId,
      userId: input.userId,
      nonceHash: input.nonceHash,
      status: 'issued',
      expiresTime: input.expiresTime,
      consumedTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(input.nonceHash.toString('hex'), flow);
    return flow;
  }

  async findByNonceHash(nonceHash: Buffer): Promise<MailFlow | undefined> {
    return this.store.get(nonceHash.toString('hex'));
  }

  async findByNonceHashForUpdate(_exec: Queryable, nonceHash: Buffer): Promise<MailFlow | undefined> {
    return this.store.get(nonceHash.toString('hex'));
  }

  async markConsumed(_exec: Queryable, id: number, now: Date): Promise<void> {
    for (const f of this.store.values()) {
      if (f.id === id) {
        f.status = 'consumed';
        f.consumedTime = now;
      }
    }
  }

  async prune(before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [k, f] of [...this.store]) {
      if (n >= limit) break;
      if (f.expiresTime < before || (f.consumedTime && f.consumedTime < before)) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }
}

/** 内存审计假实现：收集事件，供断言与审计 writer 测试。 */
export class FakeAuditRepo implements IAuditRepo {
  readonly events: Omit<AuditEvent, 'id' | 'createTime'>[] = [];

  async insert(event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent> {
    this.events.push(event);
    return { ...event, id: this.events.length, createTime: new Date() };
  }
}