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
    expect(fingerprintSha256(blob)).toBe(fingerprintSha256(blob));
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