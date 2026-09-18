import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
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

main();