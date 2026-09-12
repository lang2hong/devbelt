import { resolveSigningKeys, type SigningKeys } from './service/signingKeys.js';
import { resolveConsoleOrigin } from './service/consoleOrigin.js';

/**
 * 统一布尔开关解析：`false`/`0`/`off` 视为关，缺省 undefined 视为关
 * （与 featureFlags.parseOff 同口径）；调用方按需取反表示「默认开」。
 */
function parseOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'off';
}

/**
 * 解析 `TRUST_PROXY`。取值语义见 docs/开发指南.md；`true` 被显式拒绝（左段
 * XFF 可由客户端伪造，使按 IP 的限流失效）。默认跳数 1（nginx 反代之后）。
 * 返回字符串形（`'1'` 表示信任 1 跳）：Fastify v5.12 起 trustProxy 不再接受 number。
 */
function parseTrustProxy(raw: string | undefined): boolean | string {
  if (raw === undefined || raw === '') return '1';
  const v = raw.trim();
  if (v === 'false' || v === '0') return false;
  if (v === 'true') {
    throw new Error(
      'TRUST_PROXY=true is refused: it reads the leftmost X-Forwarded-For entry, ' +
        'which the client fully controls, making per-IP rate limiting bypassable.',
    );
  }
  return v;
}

/**
 * 解析并校验 token 有效期（access / refresh 共用）。
 * 拒绝纯数字（秒 vs 毫秒语义歧义），并给每类 token 设硬上限，超限启动即失败。
 */
export function parseTokenTtl(
  raw: string,
  varName: string,
  maxMs: number,
): { raw: string; ms: number } {
  const m = /^(\d+)([smhd])$/.exec(raw);
  if (!m) {
    throw new Error(
      `${varName} must match \\d+[smhd] (e.g. 15m, 1h, 30d), got ${JSON.stringify(raw)}.`,
    );
  }
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = Number(m[1]) * mult[m[2]];
  if (ms <= 0) throw new Error(`${varName} must be greater than zero, got ${JSON.stringify(raw)}`);
  if (ms > maxMs) {
    throw new Error(`${varName}=${raw} exceeds the ${Math.round(maxMs / 60_000)} minute limit.`);
  }
  return { raw, ms };
}

const MAX_ACCESS_TTL_MS = 60 * 60 * 1000; // 1 小时
const MAX_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

const accessTtl = parseTokenTtl(process.env.ACCESS_TOKEN_EXPIRES_IN || '15m', 'ACCESS_TOKEN_EXPIRES_IN', MAX_ACCESS_TTL_MS);
const refreshTtl = parseTokenTtl(process.env.REFRESH_TOKEN_EXPIRES_IN || '30d', 'REFRESH_TOKEN_EXPIRES_IN', MAX_REFRESH_TTL_MS);

/**
 * 服务端配置：从环境变量读取，提供默认值。
 *
 * `signingKeys` 在模块加载时解析并校验；失败立即抛错，使任何 import 本模块的
 * 入口（server / 测试装配）在缺密钥时都无法启动 —— 而不是延迟到首个请求才 500。
 */
export const signingKeys: SigningKeys = resolveSigningKeys();

/**
 * 平台管理员引导邮箱（§10.4）。逗号分隔；与注册/登录一致 trim + lowercase 规范化。
 * 缺失 = 空数组（平台运营 fail-closed，无人自动提升）。
 */
function parsePlatformAdminEmails(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  accessTokenExpiresIn: accessTtl.raw,
  refreshTokenExpiresIn: refreshTtl.raw,
  refreshTokenExpiresMs: refreshTtl.ms,
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'dbclient',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'db_client',
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  rateLimitEnabled: !parseOff(process.env.RATE_LIMIT_ENABLED),
  /** 控制台公开页/邮件流接口允许的同源 Origin（生产/预发必须为 HTTPS SMTP_BASE_URL 源）。 */
  consoleOrigin: resolveConsoleOrigin(),
  /** 平台管理员引导邮箱（规范化后，供启动受控提升）。 */
  platformAdminEmails: parsePlatformAdminEmails(process.env.PLATFORM_ADMIN_EMAILS),
  /**
   * sync-reset 深链目标扩展 id（`vscode://<id>/reset-after-loss`）。
   * 深链按扩展的 publisher.name 路由；当前扩展 manifest 为 lang2hong.vscode-db-client，
   * 故默认取此实际 id（开箱即用）。若日后以 dbclient.sync 重新发布 marketplace，部署时
   * 用 SYNC_EXTENSION_ID 覆盖。
   */
  syncExtensionId: process.env.SYNC_EXTENSION_ID || 'lang2hong.vscode-db-client',
};

export { parseTrustProxy };
