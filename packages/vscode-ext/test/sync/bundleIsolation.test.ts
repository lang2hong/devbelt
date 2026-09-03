import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const OUT = join(__dirname, '../../out');
const EXT = join(OUT, 'extension.js');
const WORKER = join(OUT, 'argon2Worker.js');
const MAIN = join(OUT, 'mainThreadFixture.js');

const describeIfBuilt = [EXT, WORKER, MAIN].every((p) => existsSync(p))
  ? describe
  : describe.skip;

describeIfBuilt('Argon2id 主线程隔离（bundle 红线门禁）', () => {
  it('主线程侧（extension + fixture）不含执行依赖；worker 含执行体', () => {
    const ext = readFileSync(EXT, 'utf8');
    const main = readFileSync(MAIN, 'utf8');
    const worker = readFileSync(WORKER, 'utf8');

    // 负向：hash-wasm 是执行依赖；argon2id( 是执行调用标记。
    // 不拒绝 'argon2id' 协议字面量或 deriveKekSmpInWorker 门面标识符。
    for (const text of [ext, main]) {
      expect(text).not.toMatch(/hash-wasm/);
      expect(text).not.toMatch(/argon2id\(/);
    }
    // fixture 确已真正引入主线程门面（非树摇）
    expect(main).toMatch(/deriveKekSmpInWorker/);

    // 正向：worker 侧才含执行体。
    expect(worker).toMatch(/hash-wasm/);
    expect(worker).toMatch(/argon2id\(/);
  });
});