/**
 * 账号作用域：本地数据按登录用户隔离（方案 B1）。
 *
 * - 未登录 = `local`：沿用原来的键，老数据继续可见；
 * - 登录后 = `u.<userId>`：读写 `<base>::u.<userId>` 的键；
 * - **迁移是「读时复制」**：目标键不存在而旧键有值时，复制一份到账号作用域，
 *   原数据保留（B1：不移动、不删除，避免升级后看起来像数据丢失）。
 *
 * 只用于「属于某个账号」的数据：AI 对话、模型接入、apiKey、ES 保存的 DSL。
 * 连接/历史/审计在第二期接入；验证器、MCP 令牌、本机路径覆盖保持全局。
 */
import type { Memento } from 'vscode';

let currentUserId: string | undefined;
const listeners = new Set<(scope: string) => void>();

/** 当前作用域名：登录用户 id，未登录为 `local`。 */
export function accountScope(): string {
  return currentUserId ?? 'local';
}

/** 切换作用域；返回值表示是否真的变了（用于决定要不要刷新界面）。 */
export function setAccountScope(userId: string | undefined): boolean {
  const next = typeof userId === 'string' && userId.trim() ? userId.trim() : undefined;
  if (next === currentUserId) return false;
  currentUserId = next;
  for (const listener of [...listeners]) {
    try { listener(accountScope()); } catch { /* 单个订阅失败不影响其他 */ }
  }
  return true;
}

export function onAccountScopeChange(listener: (scope: string) => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

/** 作用域化的键；`local` 返回原键（兼容旧数据）。 */
export function scopedKey(base: string, scope: string = accountScope()): string {
  return scope === 'local' ? base : `${base}::u.${scope}`;
}

/** 账号作用域下的键前缀（记录式存储用）。 */
export function scopedPrefix(base: string, scope: string = accountScope()): string {
  return scope === 'local' ? base : `${base}u.${scope}.`;
}

/**
 * 读作用域化数据：目标为空时回退到旧键，并异步复制一份（只读时迁移）。
 * 同步函数：调用方需要立刻拿到数据，复制失败只影响下一次读取。
 */
export function readScoped<T>(memento: Memento, base: string, scope: string = accountScope()): T | undefined {
  const target = scopedKey(base, scope);
  const scoped = memento.get<T>(target);
  if (scoped !== undefined) return scoped;
  if (scope === 'local') return undefined;
  const legacy = memento.get<T>(base);
  if (legacy !== undefined) void memento.update(target, legacy);
  return legacy;
}

/** 写作用域化数据。 */
export function writeScoped(memento: Memento, base: string, value: unknown, scope: string = accountScope()): Thenable<void> {
  return memento.update(scopedKey(base, scope), value);
}