import { EventEmitter, ThemeColor, type Disposable, type Event, type FileDecoration, type FileDecorationProvider, type Uri } from 'vscode';
import type { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { CONN_DECORATION_SCHEME, connectionDecorationSpec } from './connectionDecoration';

/**
 * 把 `connectionDecorationSpec` 结果包成 vscode 的 FileDecoration（唯一需要 vscode 的薄层）。
 *
 * 订阅 `store.onChanged` 并 fire `onDidChangeFileDecorations`：VS Code 会按 URI 缓存装饰结果，
 * 连接环境/颜色变更后若不主动通知，徽标会 stale（直到 Reload）。
 */
export class ConnectionDecorationProvider implements FileDecorationProvider, Disposable {
  private readonly emitter = new EventEmitter<Uri | Uri[] | undefined>();
  readonly onDidChangeFileDecorations: Event<Uri | Uri[] | undefined> = this.emitter.event;
  private readonly storeSub: Disposable;

  constructor(private readonly store: ConnectionStore) {
    this.storeSub = store.onChanged(() => this.emitter.fire(undefined));
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    if (uri.scheme !== CONN_DECORATION_SCHEME) return undefined;
    const conn = this.store.get(uri.authority);
    if (!conn) return undefined;
    const spec = connectionDecorationSpec(conn);
    if (!spec) return undefined;
    return { badge: spec.badge, color: new ThemeColor(spec.colorToken) };
  }

  dispose(): void {
    this.storeSub.dispose();
    this.emitter.dispose();
  }
}