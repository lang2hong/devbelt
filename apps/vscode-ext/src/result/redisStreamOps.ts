/**
 * Stream 查看/编辑操作（从 `RedisView` 抽出，Phase 2 拆分）。
 *
 * 覆盖 XADD/XDEL/XTRIM/XGROUP/XINFO/XRANGE 等；破坏性操作经 `needConfirm` 二次确认。
 * 通过 `RedisOpsHost` 宿主面执行命令、回发消息与审计，不直接持有视图状态。
 */
import {
  redisXRevRange, redisXAdd, redisXDel, redisXTrimMaxlen,
  redisXInfoConsumers, redisXGroupCreate, redisXGroupDestroy, redisXGroupDelConsumer,
  redisXPending, redisXPendingEntries, redisXAck, redisXClaim,
  isValidStreamId, compareStreamId, redisXRange,
} from '@devbelt/db-core';
import { l10n } from '../i18n';
import type { RedisOpsHost } from './redisViewSupport';
import { STREAM_PAGE, pairsOf, strs } from './redisViewSupport';

const PENDING_PAGE = 100;

export class RedisStreamOps {
  constructor(private readonly host: RedisOpsHost) {}

  /** 破坏性操作：未带 confirmed 时先回确认请求，由 webview 二次下发。 */
  private needConfirm(msg: any, kind: string, detail: string): boolean {
    if (msg.confirmed === true) return false;
    this.host.post({ type: 'confirmOpRequired', kind, detail });
    return true;
  }

  async streamAdd(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const id = String(msg.id ?? '*');
    const fields = pairsOf(msg.fields);
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        const c = session.client;
        if (id !== '*') {
          if (!isValidStreamId(id)) {
            this.host.post({ type: 'keyAction', action: 'XADD', ok: false, error: l10n('cmd.redis.streamInvalidId') });
            return;
          }
          const last = await redisXRevRange(c, key, '+', '-', 1);
          const lastId = last[0]?.id;
          if (lastId && compareStreamId(id, lastId) <= 0) {
            this.host.post({ type: 'keyAction', action: 'XADD', ok: false, error: l10n('cmd.redis.streamIdNotGreater') });
            return;
          }
        }
        const started = Date.now();
        await redisXAdd(c, key, fields, id);
        this.host.audit('XADD', key, Date.now() - started);
        this.host.post({ type: 'keyAction', action: 'XADD', ok: true, error: null });
        await this.host.doPushValue(session, key);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XADD', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamDelOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const ids = strs(msg.ids);
    if (!ids.length) return;
    // 单条走普通管线；批量走确认。
    if (ids.length > 1 && this.needConfirm(msg, 'streamDel', `${ids.length} entries`)) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        const started = Date.now();
        await redisXDel(session.client, key, ids);
        this.host.audit('XDEL', key, Date.now() - started);
        this.host.post({ type: 'keyAction', action: 'XDEL', ok: true, error: null });
        await this.host.doPushValue(session, key);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XDEL', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamTrimOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const maxlen = Number(msg.maxlen);
    if (!Number.isFinite(maxlen) || maxlen < 0) return;
    if (this.needConfirm(msg, 'streamTrim', `MAXLEN ${maxlen}`)) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        const started = Date.now();
        await redisXTrimMaxlen(session.client, key, maxlen);
        this.host.audit('XTRIM', key, Date.now() - started);
        this.host.post({ type: 'keyAction', action: 'XTRIM', ok: true, error: null });
        await this.host.doPushValue(session, key);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XTRIM', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamGroupCreateOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    if (!group) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        await redisXGroupCreate(session.client, key, group, String(msg.id ?? '$'), msg.mkstream !== false);
        this.host.audit('XGROUP CREATE', `${key} ${group}`);
        this.host.post({ type: 'keyAction', action: 'XGROUP', ok: true, error: null });
        await this.host.doPushValue(session, key);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XGROUP', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamGroupDestroyOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    if (!group) return;
    if (this.needConfirm(msg, 'streamGroupDestroy', group)) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        await redisXGroupDestroy(session.client, key, group);
        this.host.audit('XGROUP DESTROY', `${key} ${group}`);
        this.host.post({ type: 'keyAction', action: 'XGROUP', ok: true, error: null });
        await this.host.doPushValue(session, key);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XGROUP', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamGroupDelConsumerOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    const consumer = String(msg.consumer ?? '');
    if (!group || !consumer) return;
    if (this.needConfirm(msg, 'streamGroupDelConsumer', `${group}/${consumer}`)) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        await redisXGroupDelConsumer(session.client, key, group, consumer);
        this.host.audit('XGROUP DELCONSUMER', `${key} ${group} ${consumer}`);
        this.host.post({ type: 'keyAction', action: 'XGROUP', ok: true, error: null });
        await this.host.doPushValue(session, key);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XGROUP', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamGroupDetailOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    if (!group) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        await this.postGroupDetail(session.client, key, group);
      } catch (err) {
        this.host.post({ type: 'error', message: (err as Error).message });
      }
    });
  }

  async streamAckOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    const ids = strs(msg.ids);
    if (!key || !group || !ids.length) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        const started = Date.now();
        const acked = await redisXAck(session.client, key, group, ids);
        this.host.audit('XACK', `${key} ${group}`, Date.now() - started);
        this.host.post({ type: 'keyAction', action: 'XACK', ok: acked > 0, error: acked > 0 ? null : l10n('cmd.redis.pendingNoMatch') });
        await this.postGroupDetail(session.client, key, group);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XACK', ok: false, error: (err as Error).message });
      }
    });
  }

  async streamClaimOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    const consumer = String(msg.consumer ?? '').trim();
    const ids = strs(msg.ids);
    if (!key || !group || !consumer || !ids.length) return;
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        const started = Date.now();
        await redisXClaim(session.client, key, group, consumer, ids);
        this.host.audit('XCLAIM', `${key} ${group} ${consumer}`, Date.now() - started);
        this.host.post({ type: 'keyAction', action: 'XCLAIM', ok: true, error: null });
        await this.postGroupDetail(session.client, key, group);
      } catch (err) {
        this.host.post({ type: 'keyAction', action: 'XCLAIM', ok: false, error: (err as Error).message });
      }
    });
  }

  private async postGroupDetail(client: any, key: string, group: string): Promise<void> {
    const [consumers, pending, pendingEntries] = await Promise.all([
      redisXInfoConsumers(client, key, group),
      redisXPending(client, key, group),
      redisXPendingEntries(client, key, group, PENDING_PAGE),
    ]);
    this.host.post({
      type: 'streamGroupDetail',
      key,
      group,
      consumers,
      pending,
      pendingEntries,
      pendingTruncated: pending.count > pendingEntries.length,
    });
  }

  async streamRangeOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const start = String(msg.start ?? '-');
    await this.host.enqueue(async () => {
      try {
        const session = await this.host.sessionForDb();
        // 排他续页：起点用 `(<lastId>`，避免重复末条。
        const entries = await redisXRange(session.client, key, start === '-' ? '-' : `(${start}`, '+', STREAM_PAGE);
        this.host.post({ type: 'streamRangeResult', key, entries, done: entries.length < STREAM_PAGE });
      } catch (err) {
        this.host.post({ type: 'error', message: (err as Error).message });
      }
    });
  }
}