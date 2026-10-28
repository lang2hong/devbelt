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
 *
 * **只迁移一次**：旧键属于「升级前的本机数据」，只能被第一个账号认领。
 * 若本机已经存在任何一个账号副本（`<base>::u.*`），说明旧键已被认领，
 * 后来登录的账号必须从空数据开始——否则第二个/第三个账号会各自拿到一份
 * 同样的旧 2FA 条目、密钥与聊天历史（跨账号泄漏）。
 */
export function readScoped<T>(memento: Memento, base: string, scope: string = accountScope()): T | undefined {
  const target = scopedKey(base, scope);
  const scoped = memento.get<T>(target);
  if (scoped !== undefined) return scoped;
  if (scope === 'local') return undefined;
  const legacy = memento.get<T>(base);
  if (legacy === undefined) return undefined;
  if (hasAnyScopedKey(memento, base)) return undefined;
  void memento.update(target, legacy);
  return legacy;
}

/** 本机是否已有该键的任意账号副本（`<base>::u.<scope>`）。 */
function hasAnyScopedKey(memento: Memento, base: string): boolean {
  const m = memento as Partial<Pick<Memento, 'keys'>>;
  if (typeof m.keys !== 'function') return false; // 测试替身/旧宿主：退回迁移行为
  const prefix = `${base}::u.`;
  return m.keys().some((key) => key.startsWith(prefix));
}

/** 写作用域化数据。 */
export function writeScoped(memento: Memento, base: string, value: unknown, scope: string = accountScope()): Thenable<void> {
  return memento.update(scopedKey(base, scope), value);
}

/**
 * scopedMemento 需要的 Memento 子集（便于测试注入最小实现）。
 * vscode.Memento 结构上满足它。
 */
export interface ScopedMementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): unknown;
  keys(): readonly string[];
}

/**
 * 只作用于「属于账号」的 Memento 键的包装器：get/update 自动加当前作用域后缀。
 * 未登录时行为与原始 Memento 完全一致。
 */
export function scopedMemento<T extends ScopedMementoLike>(inner: T): T {
  const suffix = (): string => {
    const scope = accountScope();
    return scope === 'local' ? '' : `::u.${scope}`;
  };
  return {
    get: <V>(key: string, defaultValue?: V) => inner.get<V>(`${key}${suffix()}`, defaultValue),
    update: (key: string, value: unknown) => inner.update(`${key}${suffix()}`, value),
    keys: () => {
      const tail = suffix();
      const keys = inner.keys();
      if (!tail) return keys.filter((k) => !k.includes('::u.'));
      return keys.filter((k) => k.endsWith(tail)).map((k) => k.slice(0, -tail.length));
    },
  } as unknown as T;
}