import { diagError, diagWarn } from './diagnostics';

/**
 * 已知「库内部」未处理拒绝：ioredis 在节点重试耗尽关闭时会 flush 其内部命令队列并
 * reject `Connection is closed.` / `MaxRetriesPerRequestError`。这类 promise 由 ioredis
 * 内部创建（如 cluster 的 `getInfoFromNode` 复制连接发 `CLUSTER SLOTS`），调用侧无法 catch，
 * 也非本产品逻辑错误。仅忽略这些；其它未处理拒绝一律照常暴露。
 */
const KNOWN_LIBRARY_REJECTIONS: readonly RegExp[] = [
  /Connection is closed\./,
  /MaxRetriesPerRequestError/,
];

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 安装未处理拒绝守卫。
 *
 * - 扩展宿主（默认，非接管）：已知库内部错误记 `warn` 并忽略（不让扩展宿主因库内部拒绝崩溃）；
 *   其余记 `error` 并忽略，避免宿主崩溃，但保持可诊断。
 * - 测试（`takeOver: true`）：接管 `unhandledRejection` 监听（移除 Vitest 自带的），已知库内部
 *   错误忽略；**其它未处理拒绝仍抛出 → 测试失败**，从而门禁对本产品代码依旧成立。
 *
 * @returns 卸载函数（测试的 afterAll 调用可还原监听）。
 */
export function installUnhandledRejectionGuard(opts: { takeOver?: boolean } = {}): () => void {
  const takeOver = opts.takeOver === true;
  const prior = takeOver ? process.listeners('unhandledRejection') : [];

  const handler = (reason: unknown): void => {
    const msg = messageOf(reason);
    if (KNOWN_LIBRARY_REJECTIONS.some((re) => re.test(msg))) {
      diagWarn('ignored library-internal unhandled rejection', msg);
      return;
    }
    if (takeOver) {
      // 测试：非已知库内部 → 抛出令测试失败（不吞本产品的未处理拒绝）。
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
    // 宿主：不崩溃，但记录为错误以便诊断。
    diagError('unhandled rejection', msg);
  };

  if (takeOver) process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', handler);

  return () => {
    process.removeListener('unhandledRejection', handler);
    if (takeOver) for (const l of prior) process.on('unhandledRejection', l as (...args: unknown[]) => void);
  };
}