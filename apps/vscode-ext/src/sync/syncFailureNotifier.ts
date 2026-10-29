import { l10n } from '../i18n';
import { classifySyncFailure, describeSyncFailure, failureInputOf, type SyncFailureKind } from './syncFailure';

/**
 * 后台同步失败的提醒。
 *
 * 状态栏图标在后台失败时不会打扰用户；autoSync 默认关闭时，两次手动同步之间的失败
 * 更是完全不可见。这里在「连续多轮失败」或「进入停止自动重试的终态」时弹一次警告，
 * 带可操作的按钮。同一类失败每个窗口会话只弹一次，同步成功后重置。
 */
export interface FailureNotifierDeps {
  warn(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  run(command: string): void;
}

export interface SyncResultLike {
  stage?: string;
  terminal?: { code?: string };
  reason?: string;
}

const ACTIONS: Record<SyncFailureKind, Array<{ labelKey: string; command: string }>> = {
  epoch: [{ labelKey: 'sync.action.unlock', command: 'devbelt.unlockPersonalSync' }],
  auth: [{ labelKey: 'sync.action.login', command: 'devbelt.login' }],
  quota: [{ labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
  signature: [{ labelKey: 'sync.action.unlock', command: 'devbelt.unlockPersonalSync' }, { labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
  featureRequired: [{ labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
  protocol: [{ labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
  notInitialized: [{ labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
  network: [{ labelKey: 'sync.action.syncNow', command: 'devbelt.syncNow' }, { labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
  other: [{ labelKey: 'sync.action.syncNow', command: 'devbelt.syncNow' }, { labelKey: 'sync.action.viewLogs', command: 'devbelt.showDiagnostics' }],
};

export class SyncFailureNotifier {
  /** 连续失败多少轮（可重试的 error）后才提醒。 */
  static readonly THRESHOLD = 3;

  private consecutive = 0;
  private manualDepth = 0;
  private readonly shown = new Set<string>();

  constructor(private readonly deps: FailureNotifierDeps) {}

  /** 手动同步自己会反馈结果：进行期间不重复弹。 */
  beginManual(): void { this.manualDepth += 1; }
  endManual(): void { this.manualDepth = Math.max(0, this.manualDepth - 1); }

  onResult(result: SyncResultLike | undefined, lastError?: string): void {
    const stage = result?.stage;
    if (stage === 'ok') {
      this.consecutive = 0;
      this.shown.clear();
      return;
    }
    // 冲突由状态栏与体检面板负责引导。
    if (stage === 'conflict') return;

    const input = failureInputOf(result, lastError);
    const kind = classifySyncFailure(input);
    // 协调器抛出异常时没有 result（stage 为 undefined），按可重试失败计。
    const terminal = stage === 'terminal' || stage === 'epoch-mismatch';
    if (!terminal) {
      this.consecutive += 1;
      if (this.consecutive < SyncFailureNotifier.THRESHOLD) return;
    }
    if (this.manualDepth > 0) return;

    const key = `${terminal ? 'terminal' : 'error'}:${kind}:${input.terminalCode ?? ''}`;
    if (this.shown.has(key)) return;
    this.shown.add(key);

    const actions = ACTIONS[kind].map((a) => ({ label: l10n(a.labelKey), command: a.command }));
    const message = l10n('sync.failureToast', { detail: describeSyncFailure(input) });
    void Promise.resolve(this.deps.warn(message, ...actions.map((a) => a.label))).then((picked) => {
      const hit = actions.find((a) => a.label === picked);
      if (hit) this.deps.run(hit.command);
    });
  }
}
