import { describe, expect, it } from 'vitest';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';
import { AiTopupService } from '../../src/modules/ai/service/aiTopupService.js';
import { MemoryAiTopupRepo } from '../helpers/fakeAiTopupRepo.js';
import {
  TopupOrderNotFoundError,
  TopupOrderStateError,
  TopupSkuNotFoundError,
} from '../../src/modules/ai/domain/errors.js';

const NOW = new Date('2026-10-15T00:00:00Z');
const passthroughRunner: TxRunner = (fn) => fn({} as Queryable);

function build(): { svc: AiTopupService; repo: MemoryAiTopupRepo } {
  const repo = new MemoryAiTopupRepo();
  const svc = new AiTopupService(repo, passthroughRunner, () => NOW);
  return { svc, repo };
}

describe('AiTopupService（P9.1 加油包）', () => {
  it('手工建单：建单即 fulfilled 并同事务入账（过期=now+validDays）', async () => {
    const { svc, repo } = build();
    repo.seedSku({ code: 'sk1', tokens: 5000, priceCents: 900, validDays: 30 });

    const result = await svc.createManualOrder({ userId: 7, skuCode: 'sk1' });
    expect(result).toMatchObject({ userId: 7, skuCode: 'sk1', tokens: 5000, amountCents: 900, status: 'fulfilled', grantInserted: true });
    const order = repo.orders.get(result.orderNo)!;
    expect(order.channel).toBe('manual');
    const grants = [...repo.grants.values()].filter((g) => g.userId === 7);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.expiresTime.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  });

  it('手工建单：SKU 不存在/停用 → TopupSkuNotFoundError', async () => {
    const { svc, repo } = build();
    repo.seedSku({ code: 'off', status: 'disabled' });
    await expect(svc.createManualOrder({ userId: 7, skuCode: 'nope' })).rejects.toBeInstanceOf(TopupSkuNotFoundError);
    await expect(svc.createManualOrder({ userId: 7, skuCode: 'off' })).rejects.toBeInstanceOf(TopupSkuNotFoundError);
  });

  it('fulfill：paid → fulfilled + 入账；重放幂等（grantInserted=false，不重复入账）', async () => {
    const { svc, repo } = build();
    repo.seedSku({ code: 'sk1', tokens: 5000, priceCents: 900 });
    const order = await repo.insertTopupOrderInTx({} as Queryable, {
      orderNo: 'o-paid-1', userId: 7, skuCode: 'sk1', amountCents: 900, channel: 'wechat', status: 'pending', expiresTime: NOW,
    });
    await repo.setOrderStatusInTx({} as Queryable, order.id, 'pending', 'paid');

    const first = await svc.fulfill('o-paid-1');
    expect(first).toMatchObject({ status: 'fulfilled', grantInserted: true, tokens: 5000 });
    const second = await svc.fulfill('o-paid-1');
    expect(second).toMatchObject({ status: 'fulfilled', grantInserted: false });
    expect([...repo.grants.values()].filter((g) => g.orderId === order.id)).toHaveLength(1);
  });

  it('fulfill：非 paid 前态 → TopupOrderStateError；订单不存在 → 404 错', async () => {
    const { svc, repo } = build();
    repo.seedSku({ code: 'sk1' });
    await repo.insertTopupOrderInTx({} as Queryable, {
      orderNo: 'o-pending-1', userId: 7, skuCode: 'sk1', amountCents: 900, channel: 'wechat', status: 'pending', expiresTime: NOW,
    });
    await expect(svc.fulfill('o-pending-1')).rejects.toBeInstanceOf(TopupOrderStateError);
    await expect(svc.fulfill('o-missing')).rejects.toBeInstanceOf(TopupOrderNotFoundError);
  });

  it('退款：撤销剩余额度（grant → refunded、used 保留），订单 → refunded；重放幂等；非 fulfilled 拒绝', async () => {
    const { svc, repo } = build();
    repo.seedSku({ code: 'sk1', tokens: 5000 });
    const result = await svc.createManualOrder({ userId: 7, skuCode: 'sk1' });
    const grant = [...repo.grants.values()][0]!;
    grant.tokensUsed = 1200; // 模拟已消耗

    const refunded = await svc.refund(result.orderNo);
    expect(refunded.status).toBe('refunded');
    expect(grant.status).toBe('refunded');
    expect(grant.tokensUsed).toBe(1200); // 已用保留审计
    expect((await svc.refund(result.orderNo)).status).toBe('refunded'); // 幂等

    // pending 订单不可退
    await repo.insertTopupOrderInTx({} as Queryable, {
      orderNo: 'o-p2', userId: 7, skuCode: 'sk1', amountCents: 900, channel: 'wechat', status: 'pending', expiresTime: NOW,
    });
    await expect(svc.refund('o-p2')).rejects.toBeInstanceOf(TopupOrderStateError);
  });

  it('退款后 grant 不再计入余额；grantBalance 汇总活跃余额', async () => {
    const { svc, repo } = build();
    repo.seedSku({ code: 'sk1', tokens: 5000 });
    const a = await svc.createManualOrder({ userId: 7, skuCode: 'sk1' });
    await svc.createManualOrder({ userId: 7, skuCode: 'sk1' });
    repo.seedGrant({ userId: 8, tokens: 999, expiresTime: new Date('2026-11-01T00:00:00Z') });

    expect((await svc.grantBalance(7)).remaining).toBe(10_000);
    await svc.refund(a.orderNo);
    expect((await svc.grantBalance(7)).remaining).toBe(5000);
    expect((await svc.grantBalance(8)).remaining).toBe(999);
  });
});