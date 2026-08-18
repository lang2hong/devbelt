import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from '../../src/utils/event';
import { AutoSyncService } from '../../src/sync/autoSyncService';

type Status = 'ok' | 'no-master' | 'error';

function setup(mode: 'off' | 'reminder' | 'silent', intervalMin = 0, status: Status = 'ok') {
  const emitter = new EventEmitter<void>();
  const tryAuto = vi.fn(async (): Promise<Status> => status);
  const sync = { tryAutoSync: tryAuto } as any;
  const onReminder = vi.fn();
  const onSynced = vi.fn();
  const svc = new AutoSyncService(
    sync, () => mode, () => intervalMin, emitter.event, onReminder, onSynced, () => true,
  );
  return { emitter, tryAuto, onReminder, onSynced, svc };
}

describe('AutoSyncService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('off mode: does nothing on startup or changes', async () => {
    const { emitter, tryAuto, onReminder, svc } = setup('off');
    svc.start();
    emitter.fire();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tryAuto).not.toHaveBeenCalled();
    expect(onReminder).not.toHaveBeenCalled();
    svc.dispose();
  });

  it('reminder mode: notifies on debounced store change without tryAutoSync', async () => {
    const { emitter, tryAuto, onReminder, svc } = setup('reminder');
    svc.start();
    await vi.advanceTimersByTimeAsync(1); // flush startup
    onReminder.mockClear();
    tryAuto.mockClear();
    emitter.fire();
    emitter.fire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReminder).not.toHaveBeenCalled(); // debounce not elapsed
    await vi.advanceTimersByTimeAsync(1500);
    expect(tryAuto).not.toHaveBeenCalled();
    expect(onReminder).toHaveBeenCalledTimes(1);
    svc.dispose();
  });

  it('silent mode success: calls tryAutoSync and onSynced', async () => {
    const { tryAuto, onSynced, onReminder, svc } = setup('silent', 0, 'ok');
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(tryAuto).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSynced).toHaveBeenCalled();
    expect(onReminder).not.toHaveBeenCalled();
    svc.dispose();
  });

  it('silent mode without stored master password: falls back to reminder, no retry', async () => {
    const { onReminder, onSynced, tryAuto, svc } = setup('silent', 0, 'no-master');
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onReminder).toHaveBeenCalled();
    expect(onSynced).not.toHaveBeenCalled();
    tryAuto.mockClear();
    await vi.advanceTimersByTimeAsync(120000); // no retry scheduled for no-master
    expect(tryAuto).not.toHaveBeenCalled();
    svc.dispose();
  });

  it('silent mode error: schedules backoff retry up to 3 times', async () => {
    const { tryAuto, onSynced, svc } = setup('silent', 0, 'error');
    svc.start();
    await vi.advanceTimersByTimeAsync(1); // startup → error → schedule retry #1 (30s)
    expect(tryAuto).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000); // retry #1
    expect(tryAuto).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000); // retry #2
    expect(tryAuto).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120000); // retry #3
    expect(tryAuto).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(240000); // no more retries
    expect(tryAuto).toHaveBeenCalledTimes(4);
    expect(onSynced).not.toHaveBeenCalled();
    svc.dispose();
  });

  it('silent retry resets to 0 after a success', async () => {
    const emitter = new EventEmitter<void>();
    let status: Status = 'error';
    const tryAuto = vi.fn(async (): Promise<Status> => status);
    const sync = { tryAutoSync: tryAuto } as any;
    const onSynced = vi.fn();
    const svc = new AutoSyncService(
      sync, () => 'silent', () => 0, emitter.event, () => {}, onSynced, () => true,
    );
    svc.start();
    await vi.advanceTimersByTimeAsync(1); // startup error → retry scheduled
    status = 'ok';
    await vi.advanceTimersByTimeAsync(30000); // retry #1 succeeds
    expect(onSynced).toHaveBeenCalled();
    svc.dispose();
  });

  it('periodic timer triggers at the configured interval', async () => {
    const { tryAuto, svc } = setup('silent', 1, 'ok');
    svc.start();
    await vi.advanceTimersByTimeAsync(1); // startup
    tryAuto.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(tryAuto).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(tryAuto).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('skips triggers when not logged in', async () => {
    const emitter = new EventEmitter<void>();
    const tryAuto = vi.fn(async (): Promise<Status> => 'ok');
    const sync = { tryAutoSync: tryAuto } as any;
    const onReminder = vi.fn();
    const svc = new AutoSyncService(
      sync, () => 'silent', () => 0, emitter.event, onReminder, () => {}, () => false,
    );
    svc.start();
    emitter.fire();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tryAuto).not.toHaveBeenCalled();
    expect(onReminder).not.toHaveBeenCalled();
    svc.dispose();
  });
});

/**
 * 重入保护。
 *
 * 一次 tryAutoSync 是 7 个串行 HTTP 请求（1 pull + 5 push + 1 usage），每个都可能
 * 因为网络慢或 PBKDF2 派生（600k 轮，约 0.5s）拖到几秒。而防抖窗口只有 3 秒，
 * 定时器最小间隔 1 分钟 —— 上一轮没跑完下一轮就来了是常态，不是边缘情况。
 *
 * 重叠的后果不只是浪费请求：两个 trigger 会各自撞到 access token 过期，各自拿
 * 同一个 refresh token 去续期。服务端的 refresh 是「查—撤销—签发」三步非原子，
 * 并发进去要么泄漏一个孤儿 token，要么命中重用检测把用户从所有设备踢下线。
 */
describe('AutoSyncService 重入保护', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** tryAutoSync 需要外部控制何时 resolve，才能造出重叠 */
  function setupSlow() {
    const emitter = new EventEmitter<void>();
    let release: (() => void) | undefined;
    const inFlight: Array<() => void> = [];
    const tryAuto = vi.fn(
      () =>
        new Promise<Status>((resolve) => {
          release = () => resolve('ok');
          inFlight.push(release);
        }),
    );
    const sync = { tryAutoSync: tryAuto } as any;
    const onSynced = vi.fn();
    const svc = new AutoSyncService(
      sync, () => 'silent', () => 0, emitter.event, () => {}, onSynced, () => true,
    );
    return {
      emitter, tryAuto, onSynced, svc,
      releaseAll: () => { inFlight.splice(0).forEach((r) => r()); },
    };
  }

  it('上一轮未结束时，新的触发不会并发启动第二轮', async () => {
    const { emitter, tryAuto, svc, releaseAll } = setupSlow();
    svc.start(); // 启动触发一次，卡住不 resolve
    await vi.advanceTimersByTimeAsync(1);
    expect(tryAuto).toHaveBeenCalledTimes(1);

    // 期间数据反复变更，防抖窗口过去 → 若无 guard 会再开一轮
    emitter.fire();
    await vi.advanceTimersByTimeAsync(3500);
    emitter.fire();
    await vi.advanceTimersByTimeAsync(3500);
    expect(tryAuto).toHaveBeenCalledTimes(1);

    releaseAll();
    await vi.advanceTimersByTimeAsync(1);
  });

  it('上一轮结束后仍可正常触发（guard 不会永久卡死）', async () => {
    const { emitter, tryAuto, svc, releaseAll } = setupSlow();
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    releaseAll();
    await vi.advanceTimersByTimeAsync(1);
    expect(tryAuto).toHaveBeenCalledTimes(1);

    emitter.fire();
    await vi.advanceTimersByTimeAsync(3500);
    expect(tryAuto).toHaveBeenCalledTimes(2);
    releaseAll();
    await vi.advanceTimersByTimeAsync(1);
  });

  /**
   * tryAutoSync 抛异常时的三个要求：
   *  1. guard 必须释放（否则一次意外之后自动同步永久停摆到重启）
   *  2. 按 'error' 处理（退避重排 + 提示），语义上和返回 'error' 没区别
   *  3. 不能漏出未捕获的 promise 拒绝 —— 所有调用点都是 `void this.trigger()`
   */
  it('抛异常时释放 guard 并按 error 处理', async () => {
    const emitter = new EventEmitter<void>();
    let shouldThrow = true;
    const tryAuto = vi.fn(async (): Promise<Status> => {
      if (shouldThrow) throw new Error('boom');
      return 'ok';
    });
    const sync = { tryAutoSync: tryAuto } as any;
    const onReminder = vi.fn();
    const onSynced = vi.fn();
    const svc = new AutoSyncService(
      sync, () => 'silent', () => 0, emitter.event, onReminder, onSynced, () => true,
    );
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(tryAuto).toHaveBeenCalledTimes(1);
    expect(onReminder).toHaveBeenCalled();
    expect(onSynced).not.toHaveBeenCalled();

    // guard 已释放：下一次变更还能触发
    shouldThrow = false;
    emitter.fire();
    await vi.advanceTimersByTimeAsync(3500);
    expect(tryAuto).toHaveBeenCalledTimes(2);
    expect(onSynced).toHaveBeenCalled();
    svc.dispose();
  });

  it('抛异常也会安排退避重试（与返回 error 一致）', async () => {
    const emitter = new EventEmitter<void>();
    const tryAuto = vi.fn(async (): Promise<Status> => { throw new Error('boom'); });
    const sync = { tryAutoSync: tryAuto } as any;
    const svc = new AutoSyncService(
      sync, () => 'silent', () => 0, emitter.event, () => {}, () => {}, () => true,
    );
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(tryAuto).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); // 退避 #1
    expect(tryAuto).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('定时器周期触发同样受 guard 约束', async () => {
    const emitter = new EventEmitter<void>();
    const inFlight: Array<() => void> = [];
    const tryAuto = vi.fn(
      () => new Promise<Status>((resolve) => { inFlight.push(() => resolve('ok')); }),
    );
    const sync = { tryAutoSync: tryAuto } as any;
    const svc = new AutoSyncService(
      sync, () => 'silent', () => 1, emitter.event, () => {}, () => {}, () => true,
    );
    svc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(tryAuto).toHaveBeenCalledTimes(1);

    // 三个周期过去，第一轮始终没结束
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tryAuto).toHaveBeenCalledTimes(1);

    inFlight.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(1);
    svc.dispose();
  });
});
