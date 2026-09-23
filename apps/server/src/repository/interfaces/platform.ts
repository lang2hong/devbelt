import type {
  MailFlow,
  AuditEvent,
} from "../../domain/entities.js";
import type {
  MailFlowType,
} from "../../domain/enums.js";
import type { Queryable } from "../mysql/db.js";

/** 仓储接口 · platform（自 interfaces.ts 按聚合拆分，纯类型移动）。 */

export interface IMailFlowRepo {
  create(input: {
    type: MailFlowType;
    targetTokenHash: Buffer;
    targetRecordId: number | null;
    userId: number | null;
    nonceHash: Buffer;
    expiresTime: Date;
  }): Promise<MailFlow>;
  /** 按 nonce hash 只读查找。 */
  findByNonceHash(nonceHash: Buffer): Promise<MailFlow | undefined>;
  /** 事务内按 nonce hash 锁定 mail_flow 行（消费的序列化点）。 */
  findByNonceHashForUpdate(exec: Queryable, nonceHash: Buffer): Promise<MailFlow | undefined>;
  /** 绑定登录用户到邮件流（`user_id`）；仅 issued 且未绑定/同用户时生效。事务内执行。 */
  bindUser(exec: Queryable, id: number, userId: number): Promise<void>;
  /** 标记消费（写 consumed_time）。事务内执行。 */
  markConsumed(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 删除已过期或已消费且超出保留期的 flow 行。返回删除行数。 */
  prune(before: Date, limit: number): Promise<number>;
}

export interface IAuditRepo {
  insert(event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent>;
  /** 事务内写入（幂等回执下审计与业务写同事务、重放不重复审计）。 */
  insertInTx(exec: Queryable, event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent>;
  /** 平台审计查询（filter 有序，cursor 为上一页最后一条 id，DESC）。 */
  search(input: AuditFilter): Promise<AuditEvent[]>;
  /** 平台审计命中计数（导出上限校验）。 */
  count(input: Omit<AuditFilter, 'cursor' | 'limit'>): Promise<number>;
  /** 事务内查询（导出幂等回执下读取与审计写同事务）。 */
  searchInTx(exec: Queryable, input: AuditFilter): Promise<AuditEvent[]>;
  /** 事务内计数（导出上限校验）。 */
  countInTx(exec: Queryable, input: Omit<AuditFilter, 'cursor' | 'limit'>): Promise<number>;
}

export interface AuditFilter {
  fromTime?: Date;
  toTime?: Date;
  actorUserId?: number;
  eventType?: string;
  targetType?: string;
  cursor?: number;
  limit: number;
}
