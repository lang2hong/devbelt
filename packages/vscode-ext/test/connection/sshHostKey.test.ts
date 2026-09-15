import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isHostKeyTrusted, loadKnownHosts, type KnownHostEntry } from '../../src/connection/sshHostKey';

const KEY = Buffer.from('fake-host-key-blob');
const KEY_B64 = KEY.toString('base64');

function entry(over: Partial<KnownHostEntry> = {}): KnownHostEntry {
  return {
    hostPatterns: ['db.example.com'],
    keyType: 'ssh-ed25519',
    keyB64: KEY_B64,
    revoked: false,
    ...over,
  };
}

describe('isHostKeyTrusted', () => {
  it('trusts a host whose key matches known_hosts', () => {
    expect(isHostKeyTrusted('db.example.com', 22, KEY, [entry()])).toBe(true);
  });

  it('rejects a key mismatch (MITM)', () => {
    expect(isHostKeyTrusted('db.example.com', 22, Buffer.from('other'), [entry()])).toBe(false);
  });

  it('rejects an unknown host (fail-closed, no implicit TOFU)', () => {
    expect(isHostKeyTrusted('evil.example.com', 22, KEY, [entry()])).toBe(false);
  });

  it('rejects an explicitly revoked key even if another entry trusts it', () => {
    const entries = [entry(), entry({ revoked: true })];
    expect(isHostKeyTrusted('db.example.com', 22, KEY, entries)).toBe(false);
  });

  it('matches [host]:port form for non-default ports', () => {
    const e = entry({ hostPatterns: ['[db.example.com]:2222'] });
    expect(isHostKeyTrusted('db.example.com', 2222, KEY, [e])).toBe(true);
    expect(isHostKeyTrusted('db.example.com', 22, KEY, [e])).toBe(false);
  });

  it('matches OpenSSH hashed host names', () => {
    const salt = Buffer.from('0123456789abcdef');
    const hmac = createHmac('sha1', salt).update('db.example.com').digest();
    const hashed = `|1|${salt.toString('base64')}|${hmac.toString('base64')}`;
    expect(isHostKeyTrusted('db.example.com', 22, KEY, [entry({ hostPatterns: [hashed] })])).toBe(true);
  });
});

describe('loadKnownHosts', () => {
  it('parses plain, revoked and hashed entries, skipping comments/blank lines', () => {
    const file = path.join(os.tmpdir(), `known_hosts_${process.pid}_${Date.now()}`);
    const content = [
      '# comment',
      '',
      `db.example.com ssh-ed25519 ${KEY_B64}`,
      `@revoked old.example.com ssh-rsa ${KEY_B64}`,
      `|1|${Buffer.from('salt').toString('base64')}|${Buffer.from('mac').toString('base64')} ssh-ed25519 ${KEY_B64}`,
    ].join('\n');
    fs.writeFileSync(file, content);
    try {
      const entries = loadKnownHosts(file);
      expect(entries).toHaveLength(3);
      expect(entries[0].hostPatterns).toEqual(['db.example.com']);
      expect(entries[1].revoked).toBe(true);
      expect(entries[2].hostPatterns[0].startsWith('|1|')).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('returns an empty list when the file is missing', () => {
    expect(loadKnownHosts(path.join(os.tmpdir(), 'definitely-missing-known-hosts'))).toEqual([]);
  });
});
