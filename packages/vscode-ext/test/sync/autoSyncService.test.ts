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
