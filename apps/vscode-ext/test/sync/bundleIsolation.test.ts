import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const OUT = join(ROOT, 'out');
const EXT = join(OUT, 'extension.js');
const WORKER = join(OUT, 'argon2Worker.js');
const MAIN = join(OUT, 'mainThreadFixture.js');

describe('bundle 红线门禁前置自检（始终运行）', () => {
  it('esbuild minify 须为 false：负向/正向标记依赖未压缩产物', () => {
    // hash-wasm 标记来自 esbuild 保留的模块命名，argon2id( 来自保留的调用标识符；
    // 一旦开启 minify，二者会失真，红线门禁会静默失效。
    const esbuildSrc = readFileSync(join(ROOT, 'esbuild.js'), 'utf8');
    expect(/minify:\s*false/.test(esbuildSrc), 'esbuild minify 非 false：请同步更新门禁标记（或改用抗压缩标记）').toBe(true);
  });
});

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