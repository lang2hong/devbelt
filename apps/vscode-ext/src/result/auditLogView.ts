import { BaseWebView } from './baseWebView';
import { AuditLogger, type AuditAction } from '../utils/auditLogger';

const PAGE_SIZE = 200;

/**
 * 审计日志面板：展示 AuditLogger 记录的操作流水，支持按动作过滤与清空。
 *
 * 消息协议（与 webview/src/views/AuditLogView.vue 对齐）：
 *   webview → ext: ready | filter{action} | clear
 *   ext → webview: init{mode:'auditLog'} | entries{entries}
 */
export class AuditLogView extends BaseWebView {
  private static current?: AuditLogView;
  private filter?: AuditAction;

  private constructor(private readonly logger: AuditLogger) {
    super('devbelt.auditLog', 'Audit Log');
  }

  static open(logger: AuditLogger): void {
    if (AuditLogView.current) AuditLogView.current.dispose();
    AuditLogView.current = new AuditLogView(logger);
  }

  /** 账号切换：审计日志按账号隔离，旧账号的流水不能留在打开的面板里。 */
  static closeAll(): void {
    AuditLogView.current?.dispose();
    AuditLogView.current = undefined;
  }

  protected async handleMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // 首个 ready 来自默认挂载的 QueryView，需先切模式；切换后新视图会再发一次 ready
        if (!this.initSent) {
          this.initSent = true;
          this.post({ type: 'init', mode: 'auditLog' });
          return;
        }
        this.sendEntries();
        return;
      case 'filter':
        this.filter = msg.action ? (msg.action as AuditAction) : undefined;
        this.sendEntries();
        return;
      case 'clear':
        this.logger.clear();
        this.sendEntries();
        return;
      default:
        return;
    }
  }

  private sendEntries(): void {
    this.post({ type: 'entries', entries: this.logger.getEntries(PAGE_SIZE, this.filter) });
  }

  protected onDispose(): void {
    super.onDispose();
    if (AuditLogView.current === this) AuditLogView.current = undefined;
  }
}
