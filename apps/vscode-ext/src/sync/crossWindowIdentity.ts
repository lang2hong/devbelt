import { l10n } from '../i18n';

/**
 * 另一个窗口换了登录账号时，本窗口的同步该怎么办。
 *
 * 本窗口已解锁的同步会话持有旧账号的密钥，却会带新账号的 token 去请求，服务端只会拒绝，
 * 用户看到的是一个没有解释的停摆图标。这里做三件事：停掉同步会话、刷新状态栏、
 * 提示一次「请重新加载窗口」。
 *
 * 刻意不做自动换号：后台窗口里弹迁移询问的模态框是干扰，而且本窗口的面板、连接树、
 * 各类 store 都是按旧账号加载的，只有重新加载才能一致。
 */
export interface CrossWindowIdentityDeps {
  invalidateSync(): void;
  refreshStatus(): void;
  warn(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  reloadWindow(): void;
  log(message: string, detail: Record<string, unknown>): void;
}

export interface IdentityChange {
  from?: string;
  to?: string;
}

export function createCrossWindowIdentityHandler(deps: CrossWindowIdentityDeps): (change: IdentityChange) => void {
  let notified = false;
  return (change) => {
    // 日志里只记「有没有」，不记 userId 本身。
    deps.log('account changed in another window', { hadUser: change.from !== undefined, hasUser: change.to !== undefined });
    deps.invalidateSync();
    deps.refreshStatus();
    if (notified) return;
    notified = true;
    const reload = l10n('sync.action.reloadWindow');
    void Promise.resolve(deps.warn(l10n('sync.crossWindowAccountChanged'), reload)).then((picked) => {
      if (picked === reload) deps.reloadWindow();
    });
  };
}
