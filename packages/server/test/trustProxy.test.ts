import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { parseTrustProxy } from '../src/config.js';

/**
 * trustProxy 的安全语义。
 *
 * req.ip 是限流的分桶键，也是 devices.ip 的来源。取错了有两个后果：
 * 反代下所有人共用一个 IP（限流退化成全站锁门），或者客户端能自己伪造 IP
 * （限流形同虚设）。
 *
 * 这个文件把四种取值的实际行为钉死。特别是 `trustProxy: true` 可被伪造那条 ——
 * 它看起来是「信任代理」的自然写法，实际是本项目里唯一有安全后果的错误配置。
 */

async function probe(trustProxy: any, headers: Record<string, string>): Promise<string> {
  const app = Fastify({ logger: false, trustProxy });
  app.get('/', async (req) => ({ ip: req.ip }));
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/', headers, remoteAddress: '127.0.0.1' });
  await app.close();
  return res.json().ip;
}

/** nginx `proxy_set_header X-Forwarded-For $remote_addr`（覆写） */
const NGINX_OVERWRITE = { 'x-forwarded-for': '203.0.113.9' };
/** nginx `$proxy_add_x_forwarded_for`（追加），且客户端预先塞了伪造值 */
const NGINX_APPEND_FORGED = { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' };
/** 客户端塞了多段伪造值 */
const MULTI_FORGED = { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.9' };

const REAL_CLIENT = '203.0.113.9';
const PROXY = '127.0.0.1';

describe('trustProxy: false（默认，不信任代理）', () => {
  it('恒返回直连地址，XFF 一律忽略', async () => {
    expect(await probe(false, {})).toBe(PROXY);
    expect(await probe(false, NGINX_OVERWRITE)).toBe(PROXY);
    expect(await probe(false, MULTI_FORGED)).toBe(PROXY);
  });
});

describe('trustProxy: true（危险，配置层已禁止）', () => {
  /**
   * 这两条是「为什么 parseTrustProxy 拒绝 true」的证据。
   *
   * true 取 XFF 最左段，那一段完全由客户端控制：攻击者每个请求换一个伪造 IP
   * 就能让按 IP 的限流永远命中不到同一个桶。留着这两个用例是为了让任何想
   * 改成 true 的人先看到后果。
   */
  it('nginx 覆写时取值正确', async () => {
    expect(await probe(true, NGINX_OVERWRITE)).toBe(REAL_CLIENT);
  });

  it('nginx 追加时取到客户端伪造的最左段', async () => {
    expect(await probe(true, NGINX_APPEND_FORGED)).toBe('1.2.3.4');
    expect(await probe(true, MULTI_FORGED)).toBe('9.9.9.9');
  });
});

describe('trustProxy: 1（本项目默认，信任 1 跳）', () => {
  it('两种 nginx 写法都取到真实客户端', async () => {
    expect(await probe(1, NGINX_OVERWRITE)).toBe(REAL_CLIENT);
    expect(await probe(1, NGINX_APPEND_FORGED)).toBe(REAL_CLIENT);
  });

  it('客户端伪造多段也无效（从右往左数 1 跳）', async () => {
    expect(await probe(1, MULTI_FORGED)).toBe(REAL_CLIENT);
  });

  it('无 XFF 时退回直连地址', async () => {
    expect(await probe(1, {})).toBe(PROXY);
  });
});

describe('trustProxy: 代理地址', () => {
  it("'127.0.0.1' 与跳数 1 等效（此部署下）", async () => {
    expect(await probe(PROXY, NGINX_OVERWRITE)).toBe(REAL_CLIENT);
    expect(await probe(PROXY, MULTI_FORGED)).toBe(REAL_CLIENT);
  });
});

describe('parseTrustProxy', () => {
  it('未设置 → 1（假定有反代）', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('')).toBe(1);
  });

  it("'false' / '0' → false（直连部署）", () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
  });

  it('纯数字 → 跳数', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('其余按字符串透传（IP / CIDR / 列表）', () => {
    expect(parseTrustProxy('127.0.0.1')).toBe('127.0.0.1');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy('127.0.0.1,10.0.0.1')).toBe('127.0.0.1,10.0.0.1');
  });

  it('两端空白被裁掉', () => {
    expect(parseTrustProxy('  1  ')).toBe(1);
    expect(parseTrustProxy(' false ')).toBe(false);
  });

  /**
   * 拒绝 true 是刻意的：见上面 `trustProxy: true` 那两条用例。
   * 报错信息里必须给出替代写法，否则运维只会一脸茫然。
   */
  it("'true' 直接报错，并提示改用跳数", () => {
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY=true is refused/);
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY=1/);
  });
});
