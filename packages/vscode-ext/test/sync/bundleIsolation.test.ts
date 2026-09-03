import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const OUT = join(__dirname, '../../out');

const describeIfBuilt = existsSync(join(OUT, 'extension.js')) && existsSync(join(OUT, 'argon2Worker.js'))
  ? describe
  : describe.skip;

describeIfBuilt('Argon2id 主线程隔离（bundle 红线门禁）', () => {
  it('out/extension.js 不含 hash-wasm/argon2id/deriveKekSmp；out/argon2Worker.js 含', () => {
    const ext = readFileSync(join(OUT, 'extension.js'), 'utf8');
    const worker = readFileSync(join(OUT, 'argon2Worker.js'), 'utf8');
    expect(ext).not.toMatch(/hash-wasm/);
    expect(ext).not.toMatch(/argon2id/);
    expect(ext).not.toMatch(/deriveKekSmp/);
    expect(worker).toMatch(/deriveKekSmp/);
    expect(worker).toMatch(/hash-wasm/);
  });
});