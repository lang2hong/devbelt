import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  ViewColumn: { Active: 1 },
  commands: { registerCommand: vi.fn() },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { reveal: vi.fn() };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    dispose(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/diagnostics', () => ({ diagInfo: vi.fn(), diagWarn: vi.fn(), diagError: vi.fn() }));

import { SyncDoctorView } from '../../src/sync/syncDoctorView';

function makeView(session: Record<string, unknown> | undefined): any {
  const factory = { ensureSession: vi.fn(async () => session) };
  const view = new (SyncDoctorView as any)(factory, vi.fn(async () => {}));
  return view;
}

function unlocked(over: Record<string, unknown> = {}) {
  return {
    isUnlocked: true,
    listConflicts: () => [],
    inspectFindings: vi.fn(async () => ({ findings: [], incomplete: false })),
    repairFindings: vi.fn(async () => ({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0 })),
    ...over,
  };
}

async function runCheck(view: any): Promise<any> {
  await view.handleMessage({ type: 'ready' });
  await view.handleMessage({ type: 'ready' });
  const snaps = view.post.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'syncDoctorSnapshot' && !m.checking);
  return snaps.at(-1);
}

beforeEach(() => vi.clearAllMocks());

describe('SyncDoctorView 检查失败不冒充「一致」', () => {
  it('检查正常且无差异：incomplete=false，可显示「一致」', async () => {
    const snap = await runCheck(makeView(unlocked()));
    expect(snap.incomplete).toBe(false);
    expect(snap.checkError).toBeUndefined();
  });

  it('引擎报告 error（断网）：incomplete=true + 本地化 checkError，不含原始英文', async () => {
    const view = makeView(unlocked({
      inspectFindings: vi.fn(async () => ({ findings: [], incomplete: true, error: 'getState failed: fetch failed' })),
    }));
    const snap = await runCheck(view);
    expect(snap.incomplete).toBe(true);
    expect(snap.checkError).toContain('network');
    expect(snap.checkError).not.toContain('getState failed');
  });

  it('inspectFindings 抛异常：以前发空且 incomplete=false（假「一致」），现在 incomplete=true', async () => {
    const view = makeView(unlocked({ inspectFindings: vi.fn(async () => { throw new Error('boom'); }) }));
    const snap = await runCheck(view);
    expect(snap.incomplete).toBe(true);
    expect(snap.findings).toEqual([]);
    expect(snap.checkError).toBeTruthy();
  });

  it('未解锁：locked，不当作一致', async () => {
    const snap = await runCheck(makeView({ isUnlocked: false, listConflicts: () => [] }));
    expect(snap.locked).toBe(true);
  });

  it('修复没开始（aborted）：回执带本地化说明', async () => {
    const view = makeView(unlocked({
      repairFindings: vi.fn(async () => ({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0, aborted: 'remote keyEpoch differs from local' })),
    }));
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'syncDoctorRepair' });
    const result = view.post.mock.calls.map((c: any[]) => c[0]).find((m: any) => m.type === 'syncDoctorResult');
    expect(result.aborted).toBeTruthy();
    expect(result.aborted).not.toContain('keyEpoch differs');
  });
});
