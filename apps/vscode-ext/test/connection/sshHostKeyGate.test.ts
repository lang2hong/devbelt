import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendPluginKnownHost,
  fingerprintSha256,
  hostKeyType,
  knownHostsHost,
  verifyHostKey,
} from '../../src/connection/sshHostKey';

function keyBlob(type = 'ssh-ed25519', extra = Buffer.from([1, 2, 3, 4])): Buffer {
  const t = Buffer.from(type, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length, 0);
  return Buffer.concat([len, t, extra]);
}

let dir: string;
let storeFile: string;
let userFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshgate-'));
  storeFile = path.join(dir, 'plugin_known_hosts');
  userFile = path.join(dir, 'user_known_hosts');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sshHostKey 辅助', () => {
  it('parses key type and computes an OpenSSH-style SHA256 fingerprint', () => {
    const blob = keyBlob('ssh-ed25519');
    expect(hostKeyType(blob)).toBe('ssh-ed25519');
    expect(fingerprintSha256(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    // 固定 blob 的黄金值（独立用 node:crypto 计算），确保指纹算法本身正确，
    // 而不是上一次「自己等于自己」的恒真断言。
    expect(fingerprintSha256(blob)).toBe('SHA256:3Hsnk6QpWN8KsgnXzuWXiIHu2w47b1U6phcPznoSfCc');
    // 不同密钥必须得到不同指纹
    expect(fingerprintSha256(keyBlob('ssh-ed25519', Buffer.from([9])))).not.toBe(fingerprintSha256(blob));
  });

  it('knownHostsHost uses [host]:port for non-default ports', () => {
    expect(knownHostsHost('h', 22)).toBe('h');
    expect(knownHostsHost('h', 2222)).toBe('[h]:2222');
  });
});

describe('verifyHostKey', () => {
  const opts = (over: Partial<Parameters<typeof verifyHostKey>[0]> = {}) => ({
    policy: 'tofu' as const,
    host: 'db.example.com',
    port: 22,
    keyBlob: keyBlob(),
    pluginStoreFile: storeFile,
    userKnownHostsFile: userFile,
    prompt: vi.fn(async () => true),
    ...over,
  });

  it('strict rejects an unknown host', async () => {
    const o = opts({ policy: 'strict' });
    expect(await verifyHostKey(o)).toBe(false);
    expect(o.prompt).not.toHaveBeenCalled();
  });

  it('tofu prompts for an unknown host and remembers it on accept', async () => {
    const o = opts();
    expect(await verifyHostKey(o)).toBe(true);
    expect(o.prompt).toHaveBeenCalledTimes(1);
    // 第二次同一主机+密钥：已写入插件文件，不再询问。
    const again = opts();
    expect(await verifyHostKey(again)).toBe(true);
    expect(again.prompt).not.toHaveBeenCalled();
  });

  it('tofu rejects when the user declines and stores nothing', async () => {
    const o = opts({ prompt: vi.fn(async () => false) });
    expect(await verifyHostKey(o)).toBe(false);
    expect(fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : '').toBe('');
  });

  it('key mismatch is a hard failure even in tofu (no TOFU overwrite)', async () => {
    appendPluginKnownHost(storeFile, 'db.example.com', 22, 'ssh-ed25519', keyBlob('ssh-ed25519', Buffer.from([9])));
    const o = opts({ keyBlob: keyBlob('ssh-ed25519', Buffer.from([1])) });
    expect(await verifyHostKey(o)).toBe(false);
    expect(o.prompt).not.toHaveBeenCalled();
  });

  it('a revoked key is rejected', async () => {
    const blob = keyBlob();
    fs.writeFileSync(userFile, `@revoked db.example.com ssh-ed25519 ${blob.toString('base64')}\n`);
    expect(await verifyHostKey(opts({ keyBlob: blob }))).toBe(false);
  });
});
describe("verifyHostKey '仅本次'（不持久化）", () => {
  it("prompt 返回 'once'：放行但不写入 known_hosts，下次仍询问", async () => {
    const dirOnce = fs.mkdtempSync(path.join(os.tmpdir(), 'sshgate-once-'));
    const store = path.join(dirOnce, 'plugin_known_hosts');
    const user = path.join(dirOnce, 'user_known_hosts');
    const base = {
      policy: 'tofu' as const,
      host: 'db.example.com',
      port: 22,
      keyBlob: keyBlob(),
      pluginStoreFile: store,
      userKnownHostsFile: user,
      prompt: vi.fn(async () => 'once' as const),
    };
    try {
      expect(await verifyHostKey(base)).toBe(true);
      expect(fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : '').toBe('');
      const again = { ...base, prompt: vi.fn(async () => 'once' as const) };
      expect(await verifyHostKey(again)).toBe(true);
      expect(again.prompt).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dirOnce, { recursive: true, force: true });
    }
  });
});

describe('verifyHostKey 新算法（不同 key type）', () => {
  it('该主机已有另一种算法的条目时硬失败，不再 TOFU（防新型密钥替换）', async () => {
    appendPluginKnownHost(storeFile, 'db.example.com', 22, 'ssh-rsa', keyBlob('ssh-rsa', Buffer.from([9])));
    const prompt = vi.fn(async () => true as const);
    const ok = await verifyHostKey({
      policy: 'tofu',
      host: 'db.example.com',
      port: 22,
      keyBlob: keyBlob('ssh-ed25519'),
      pluginStoreFile: storeFile,
      userKnownHostsFile: userFile,
      prompt,
    });
    expect(ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
});
