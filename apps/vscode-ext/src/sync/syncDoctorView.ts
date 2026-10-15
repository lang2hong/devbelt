import * as vscode from 'vscode';
import type { SyncSessionFactory } from '@devbelt/db-host/sync/sessionFactory';
import type { PersonalSyncSession } from '@devbelt/db-host/sync/session';
import type { FindingsReport, RepairOutcome } from '@devbelt/db-host/sync/e2e/syncEngine';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import { diagError, diagInfo } from '../utils/diagnostics';
import type {
  SyncConflictView,
  SyncDoctorSnapshotMessage,
  SyncDoctorUpMessage,
  SyncFindingView,
} from '../result/protocol';

/**
 * S7k.8「数据体检」面板（webview）。
 *
 * 只做「发现 → 用户选择」：扩展下发逐条发现与冲突，用户点按钮，写入全部由用户触发
 * （面板自身绝不主动改数据）。检测触发点：打开面板、面板「重新检查」、解锁后/手动同步后
 * 的通知入口（`devbelt.syncDoctor` 命令 = 打开面板并自动检查）。
 */
export class SyncDoctorView extends BaseWebView {
  private static current?: SyncDoctorView;
  private checking = false;
  private lastCheckAt?: number;

  private constructor(private readonly factory: SyncSessionFactory) {
    super('devbelt.syncDoctor', l10n('sync.doctorTitle'));
  }

  protected onDispose(): void {
    super.onDispose();
    if (SyncDoctorView.current === this) SyncDoctorView.current = undefined;
  }

  /** 打开或聚焦面板（单例）。 */
  static open(factory: SyncSessionFactory): void {
    if (SyncDoctorView.current) {
      SyncDoctorView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    SyncDoctorView.current = new SyncDoctorView(factory);
  }

  /** 命令注册：`devbelt.syncDoctor` = 打开面板（面板 ready 后自动检查）。 */
  static register(context: vscode.ExtensionContext, factory: SyncSessionFactory): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('devbelt.syncDoctor', () => SyncDoctorView.open(factory)),
    );
  }

  protected async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as SyncDoctorUpMessage;
    switch (msg?.type) {
      case 'ready':
        if (!this.initSent) {
          this.initSent = true;
          this.post({ type: 'init', mode: 'syncDoctor' });
          return;
        }
        await this.check();
        return;
      case 'syncDoctorRefresh':
        await this.check();
        return;
      case 'syncDoctorRepair':
        await this.repair(msg.ids, msg.direction);
        return;
      case 'syncDoctorResolveConflict':
        await this.resolveConflict(msg.recordId, msg.decision);
        return;
      default:
        return;
    }
  }

  /** 外部入口（解锁/同步后的通知按钮）：确保面板已打开并刷新检查。 */
  static checkCurrent(): void {
    void SyncDoctorView.current?.check();
  }

  private async session(): Promise<PersonalSyncSession | undefined> {
    try {
      return await this.factory.ensureSession();
    } catch {
      return undefined;
    }
  }

  private postChecking(checking: boolean): void {
    this.post(this.snapshotMessage([], [], false, { checking }));
  }

  private snapshotMessage(
    findings: SyncFindingView[],
    conflicts: SyncConflictView[],
    incomplete: boolean,
    extra: { checking: boolean; locked?: boolean },
  ): SyncDoctorSnapshotMessage {
    return {
      type: 'syncDoctorSnapshot',
      checking: extra.checking,
      locked: extra.locked,
      lastCheckAt: this.lastCheckAt,
      findings,
      conflicts,
      incomplete,
    };
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.postChecking(true);
    try {
      const session = await this.session();
      if (!session || !session.isUnlocked) {
        this.post(this.snapshotMessage([], [], false, { checking: false, locked: true }));
        return;
      }
      const report: FindingsReport = await session.inspectFindings();
      const conflicts = session.listConflicts();
      this.lastCheckAt = Date.now();
      diagInfo('sync doctor findings', {
        count: report.findings.length,
        conflicts: conflicts.length,
        incomplete: report.incomplete,
        kinds: report.findings.map((f) => f.kind),
      });
      this.post(this.snapshotMessage(report.findings, conflicts, report.incomplete, { checking: false }));
    } catch (err) {
      diagError('sync doctor check failed', String(err));
      this.post(this.snapshotMessage([], [], false, { checking: false }));
    } finally {
      this.checking = false;
    }
  }

  private async repair(ids?: string[], direction?: 'cloud' | 'local' | 'merge'): Promise<void> {
    const session = await this.session();
    if (!session?.isUnlocked) return;
    try {
      const result: RepairOutcome = await session.repairFindings(ids, direction);
      diagInfo('sync doctor repair', { ids: ids ?? '(all)', direction: direction ?? 'cloud', ...result });
      const repaired = result.cloud + result.merged + result.swept;
      this.post({
        type: 'syncDoctorResult',
        repaired,
        failed: result.failed,
        pushed: result.local,
        pending: result.pending,
      });
      // 定向推送在引擎内完成（只发本次点选的 mutation，不动 outbox 其它积压）。
    } catch (err) {
      diagError('sync doctor repair failed', String(err));
      this.post({ type: 'syncDoctorResult', repaired: 0, failed: 1 });
    }
    await this.check();
  }

  private async resolveConflict(recordId: string, decision: 'local' | 'merge' | 'remote'): Promise<void> {
    const session = await this.session();
    if (!session?.isUnlocked) return;
    try {
      await session.resolveConflict(recordId, decision);
    } catch (err) {
      diagError('sync doctor resolveConflict failed', String(err));
    }
    session.scheduleNow();
    await this.check();
  }
}

