import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { FileMemento, FileSecureStorage } from './ports.js';
import { createHandlers, dispatch, type HandlerDeps } from './rpc.js';

/**
 * db-hostd：把 `@devkit/db-host` 暴露为 stdio NDJSON JSON-RPC 服务。
 *
 * 宿主（如未来的 IntelliJ 插件）只需：拉起本进程 → 写一行 JSON 请求 → 读一行 JSON 响应。
 * 逻辑全部复用 db-host，不在宿主侧重写。
 */
export function runSidecar(readable: Readable, writable: Writable, deps: HandlerDeps): void {
  const handlers = createHandlers(deps);
  const rl = createInterface({ input: readable, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    void (async () => {
      let req: unknown;
      try {
        req = JSON.parse(text);
      } catch {
        writable.write(`${JSON.stringify({ id: null, error: { code: -32700, message: 'parse error' } })}\n`);
        return;
      }
      const res = await dispatch(handlers, req as never);
      writable.write(`${JSON.stringify(res)}\n`);
    })();
  });
}

export function defaultDeps(home = process.env.DEVKIT_HOSTD_HOME ?? resolve(process.cwd(), '.db-hostd')): HandlerDeps {
  return {
    secrets: new FileSecureStorage(join(home, 'secrets.json')),
    memento: new FileMemento(join(home, 'memento.json')),
  };
}

export function main(): void {
  runSidecar(process.stdin, process.stdout, defaultDeps());
}

// 仅当本模块作为进程入口直接运行时才启动 sidecar。被 import（嵌入宿主或单测）时
// 若自动启动，会立刻开始读 process.stdin，导出的 runSidecar/defaultDeps 无法使用。
// 注意用 realpath 归一：通过 `node_modules/.bin` 的符号链接启动时，argv[1] 是链接路径、
// import.meta.url 是真实路径，直接比较会失配而静默退出。
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(arg).href;
  }
}
if (isEntryPoint()) {
  main();
}