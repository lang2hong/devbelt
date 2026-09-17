// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') },
}));

vi.mock('../api/orders', () => ({
  createOrder: vi.fn(),
  getOrder: vi.fn(),
}));

vi.mock('@devkit/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { getOrder, createOrder } from '../api/orders';
import CheckoutView from './CheckoutView.vue';

const KEY = 'dbclient.console.pendingOrder';

function order(status: string, no = 'o1') {
  return {
    orderNo: no,
    planCode: 'pro',
    amountCents: 9900,
    channel: 'wechat',
    status,
    paidTime: null,
    expiresTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createTime: '2026-01-01T00:00:00.000Z',
  };
}

let assignSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(getOrder).mockReset();
  sessionStorage.clear();
  assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  assignSpy.mockRestore();
});

describe('CheckoutView 未完成订单恢复', () => {
  it('挂载时发现未完成订单即查询并展示支付状态卡片', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    vi.mocked(getOrder).mockResolvedValue({ kind: 'ok', value: order('pending') });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    expect(getOrder).toHaveBeenCalledWith('o1');
    expect(wrapper.text()).toContain('支付状态');
    expect(wrapper.text()).toContain('我已付款，刷新状态');
    expect(wrapper.text()).toContain('查看订单');
    wrapper.unmount();
  });

  it('恢复发现 paid/fulfilled 时清暂存并跳转账户页', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    vi.mocked(getOrder).mockResolvedValue({ kind: 'ok', value: order('paid') });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    expect(sessionStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(1500);
    expect(assignSpy).toHaveBeenCalledWith('/account');
    wrapper.unmount();
  });

  it('恢复发现 failed/expired 等终态时仅清暂存，不跳转', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    vi.mocked(getOrder).mockResolvedValue({ kind: 'ok', value: order('failed') });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    expect(sessionStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(assignSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('无暂存订单时不做恢复查询', async () => {
    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();
    expect(getOrder).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('组件卸载后，迟到的恢复响应不再清暂存或跳转', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    let resolveOrder!: (v: unknown) => void;
    vi.mocked(getOrder).mockReturnValue(new Promise((r) => { resolveOrder = r; }) as never);

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();
    wrapper.unmount(); // mounted=false

    resolveOrder({ kind: 'ok', value: order('paid') });
    await flushPromises();

    expect(sessionStorage.getItem(KEY)).toBe('o1'); // 未清除
    vi.advanceTimersByTime(2000);
    expect(assignSpy).not.toHaveBeenCalled(); // 未跳转
  });

  it('切换到新订单后，旧订单的迟到响应不覆盖、不跳转', async () => {
    vi.useFakeTimers();
    vi.mocked(createOrder)
      .mockResolvedValueOnce({ kind: 'ok', value: { order: order('pending', 'o1'), payParams: { codeUrl: 'c1' } } })
      .mockResolvedValueOnce({ kind: 'ok', value: { order: order('pending', 'o2'), payParams: { codeUrl: 'c2' } } });

    let resolveOld!: (v: unknown) => void;
    const oldPromise = new Promise((r) => { resolveOld = r; });
    let getOrderCalls = 0;
    vi.mocked(getOrder).mockImplementation(() => {
      getOrderCalls += 1;
      if (getOrderCalls === 1) return oldPromise as never;
      return Promise.resolve({ kind: 'ok', value: order('pending') }) as never;
    });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    const submitBtn = () => wrapper.findAll('button').find((b) => b.text().trim() === '跳转到支付宝')!;
    await submitBtn().trigger('click');
    await flushPromises();
    vi.advanceTimersByTime(3000); // 第一次轮询 tick 挂起（oldPromise）
    await flushPromises();

    await submitBtn().trigger('click'); // 新订单 o2，generation 递增
    await flushPromises();

    resolveOld({ kind: 'ok', value: order('paid', 'o1') });
    await flushPromises();

expect(sessionStorage.getItem(KEY)).toBe('o2'); // 旧响应未清除新订单号
    vi.advanceTimersByTime(2000);
    expect(assignSpy).not.toHaveBeenCalled(); // 旧响应未触发跳转
    wrapper.unmount();
  });

  it('提交新订单期间，仍在途的旧 getOrder 迟到 paid 响应不得覆盖新订单/触发跳转', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    // 恢复流程的 getOrder('o1') 挂起（模拟慢网络），此时用户点击「跳转到支付宝」。
    let resolveRecoveryCheck!: (v: unknown) => void;
    vi.mocked(getOrder).mockReturnValue(new Promise((r) => { resolveRecoveryCheck = r; }) as never);
    vi.mocked(createOrder).mockResolvedValue({
      kind: 'ok', value: { order: order('pending', 'o2'), payParams: { codeUrl: 'c2' } },
    });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises(); // 恢复检查已发出且挂起（generation=1）

    const submitBtn = () => wrapper.findAll('button').find((b) => b.text().trim() === '跳转到支付宝')!;
    await submitBtn().trigger('click'); // submit() 立即令 generation=2，随后 createOrder 落地
    await flushPromises();

    expect(sessionStorage.getItem(KEY)).toBe('o2');

    // 旧的恢复检查（generation=1）此刻才迟到返回：不得覆盖 o2 或触发跳转。
    resolveRecoveryCheck({ kind: 'ok', value: order('paid', 'o1') });
    await flushPromises();

    expect(sessionStorage.getItem(KEY)).toBe('o2');
    vi.advanceTimersByTime(2000);
    expect(assignSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('提交下单后卸载，迟到的 createOrder 响应不再写入暂存/跳转/轮询', async () => {
    vi.useFakeTimers();
    let resolveCreate!: (v: unknown) => void;
    vi.mocked(createOrder).mockReturnValue(new Promise((r) => { resolveCreate = r; }) as never);

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '跳转到支付宝')!.trigger('click');
    await flushPromises();
    wrapper.unmount(); // mounted=false

    resolveCreate({ kind: 'ok', value: { order: order('pending', 'o1'), payParams: { codeUrl: 'c1' } } });
    await flushPromises();

    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('single-flight：慢响应期间不并发发起新请求，响应返回后正常处理终态', async () => {
    vi.useFakeTimers();
    let resolveSlow!: (v: unknown) => void;
    let call = 0;
    vi.mocked(getOrder).mockImplementation(() => {
      call += 1;
      return new Promise((r) => { resolveSlow = r; }) as never;
    });
    vi.mocked(createOrder).mockResolvedValue({ kind: 'ok', value: { order: order('pending', 'o1'), payParams: { codeUrl: 'c1' } } });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '跳转到支付宝')!.trigger('click');
    await flushPromises();

    vi.advanceTimersByTime(3000); // 第一轮 tick：getOrder 挂起（call=1）
    await flushPromises();
    vi.advanceTimersByTime(3000); // 上一请求未返回，不得再发起新请求
    await flushPromises();
    vi.advanceTimersByTime(3000);
    await flushPromises();

    expect(call).toBe(1); // 无并发堆积

    resolveSlow({ kind: 'ok', value: order('fulfilled', 'o1') });
    await flushPromises();

    expect(wrapper.text()).toContain('已生效'); // pollStatus 为 fulfilled
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(call).toBe(1); // 终态后停止轮询，不再发起新请求

    vi.advanceTimersByTime(2000);
    expect(assignSpy).toHaveBeenCalledWith('/account');
    wrapper.unmount();
  });

  it('过期订单点「重新下单」按支付宝默认跳转模式下单（mode 不被事件对象污染）', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    const expired = { ...order('pending', 'o1'), expiresTime: new Date(Date.now() - 1000).toISOString() };
    vi.mocked(getOrder).mockResolvedValue({ kind: 'ok', value: expired });
    vi.mocked(createOrder).mockResolvedValue({ kind: 'failure' });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    expect(wrapper.text()).toContain('订单已过期');

    const reorder = wrapper.findAll('button').find((b) => b.text().trim() === '重新下单')!;
    await reorder.trigger('click');
    await flushPromises();

    expect(createOrder).toHaveBeenCalledWith('pro', 'alipay', 'csrf', 'redirect');
    wrapper.unmount();
  });

  it('恢复到的 pending 订单本地已过期时不再轮询并清暂存', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY, 'o1');
    const expired = { ...order('pending', 'o1'), expiresTime: new Date(Date.now() - 1000).toISOString() };
    vi.mocked(getOrder).mockResolvedValue({ kind: 'ok', value: expired });

    const wrapper = mount(CheckoutView, { props: { user: null, subscription: null } });
    await flushPromises();

    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(KEY)).toBeNull();

    vi.advanceTimersByTime(10000);
    await flushPromises();
    expect(getOrder).toHaveBeenCalledTimes(1); // 到期后不再轮询
    expect(assignSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});