import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRedisTlsOptions } from '../../src/redis/redisTls';

describe('Redis TLS 选项构造', () => {
  it('默认 rejectUnauthorized=true（安全默认，不照搬 ARDM）', () => {
    expect(buildRedisTlsOptions({}).rejectUnauthorized).toBe(true);
  });

  it('仅显式 false 才放行自签证书', () => {
    expect(buildRedisTlsOptions({ rejectUnauthorized: false }).rejectUnauthorized).toBe(false);
  });

  it('读取 CA/cert/key 文件并透传 servername', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redis-tls-'));
    try {
      const ca = join(dir, 'ca.pem');
      const cert = join(dir, 'client.pem');
      const key = join(dir, 'client.key');
      writeFileSync(ca, 'CA-PEM');
      writeFileSync(cert, 'CERT-PEM');
      writeFileSync(key, 'KEY-PEM');
      const options = buildRedisTlsOptions({
        caPath: ca,
        clientCertPath: cert,
        clientKeyPath: key,
        servername: 'redis.example',
      });
      expect((options.ca as Buffer).toString()).toBe('CA-PEM');
      expect((options.cert as Buffer).toString()).toBe('CERT-PEM');
      expect((options.key as Buffer).toString()).toBe('KEY-PEM');
      expect(options.servername).toBe('redis.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不注入 checkServerIdentity 绕过（与 ARDM 有意不同）', () => {
    const options = buildRedisTlsOptions({}) as Record<string, unknown>;
    expect(options.checkServerIdentity).toBeUndefined();
  });

  it('未配置路径时不设置 ca/cert/key', () => {
    const options = buildRedisTlsOptions({}) as Record<string, unknown>;
    expect(options.ca).toBeUndefined();
    expect(options.cert).toBeUndefined();
    expect(options.key).toBeUndefined();
  });
});
