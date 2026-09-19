import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * SSH 主机密钥校验（known_hosts）。
 *
 * ssh2 在未提供 `hostVerifier` 时会接受**任意**主机密钥，SSH 隧道因此可被
 * 中间人冒充（数据库口令随之泄露）。这里提供两层：
 *  - `isHostKeyTrusted`：严格判定（命中且未吊销才信任）；
 *  - `verifyHostKey`：按策略裁决（`strict` 拒绝未知；`tofu` 对未知主机询问并写入
 *    插件自管 known_hosts），**密钥不匹配/revoked 一律硬失败，绝不 TOFU 覆盖**。
 *
 * 支持明文主机名与 OpenSSH 哈希主机名（`|1|salt|hmac`）。
 */

export interface KnownHostEntry {
  hostPatterns: string[];
  keyType: string;
  keyB64: string;
  revoked: boolean;
}

/** known_hosts 路径：优先 `SSH_KNOWN_HOSTS`，否则 `~/.ssh/known_hosts`。 */
export function knownHostsPath(): string {
  return process.env.SSH_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts');
}

/** 读取并解析 known_hosts；文件不存在/不可读时返回空数组（交由调用方判为不信任）。 */
export function loadKnownHosts(file: string = knownHostsPath()): KnownHostEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let rest = line;
    let revoked = false;
    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      if (rest.slice(0, sp) === '@revoked') revoked = true;
      rest = rest.slice(sp + 1);
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 3) continue;
    entries.push({
      hostPatterns: parts[0].split(','),
      keyType: parts[1],
      keyB64: parts[2],
      revoked,
    });
  }
  return entries;
}

/** 非默认端口时 known_hosts 用 `[host]:port` 形式。 */
function hostCandidates(host: string, port: number): string[] {
  // OpenSSH 语义：非默认端口**只**认 `[host]:port`。旧实现同时返回裸 host，
  // 会让 22 端口的已知主机错误地信任其它端口上的同一主机名（弱化身份绑定）。
  if (port && port !== 22) return [`[${host}]:${port}`];
  return [host];
}

/** 匹配 OpenSSH 哈希主机名 `|1|saltBase64|hmacBase64`（HMAC-SHA1）。 */
function matchesHashedPattern(pattern: string, candidates: string[]): boolean {
  const m = /^\|1\|([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)$/.exec(pattern);
  if (!m) return false;
  const salt = Buffer.from(m[1], 'base64');
  const expected = Buffer.from(m[2], 'base64');
  for (const host of candidates) {
    const digest = createHmac('sha1', salt).update(host).digest();
    if (digest.length === expected.length && timingSafeEqual(digest, expected)) return true;
  }
  return false;
}

/**
 * 主机密钥是否可信。`keyBlob` 为 ssh2 提供的原始主机公钥（base64 与 known_hosts 一致）。
 */
export function isHostKeyTrusted(
  host: string,
  port: number,
  keyBlob: Buffer,
  entries: KnownHostEntry[] = loadKnownHosts(),
): boolean {
  const candidates = hostCandidates(host, port);
  const keyB64 = keyBlob.toString('base64');

  let trusted = false;
  for (const e of entries) {
    const matched = e.hostPatterns.some(
      (p) => matchesHashedPattern(p, candidates) || candidates.includes(p),
    );
    if (!matched || e.keyB64 !== keyB64) continue;
    // 命中的密钥被显式吊销：无条件拒绝（即使另有信任条目）。
    if (e.revoked) return false;
    trusted = true;
  }
  return trusted;
}

/** 供错误提示：给出把主机加入 known_hosts 的命令。 */
export function knownHostsHint(host: string, port: number): string {
  const target = port && port !== 22 ? `-p ${port} ${host}` : host;
  return `Add it with: ssh-keyscan ${target} >> ${knownHostsPath()}`;
}

/** known_hosts 里的主机名写法：非默认端口用 `[host]:port`。 */
export function knownHostsHost(host: string, port: number): string {
  return port && port !== 22 ? `[${host}]:${port}` : host;
}

/**
 * 从 ssh2 的原始主机公钥 blob 取 key 类型（blob 首段为 uint32 长度 + 类型名）。
 * 解析失败返回 'unknown'。
 */
export function hostKeyType(keyBlob: Buffer): string {
  if (keyBlob.length < 4) return 'unknown';
  const len = keyBlob.readUInt32BE(0);
  if (len <= 0 || 4 + len > keyBlob.length) return 'unknown';
  return keyBlob.subarray(4, 4 + len).toString('utf8');
}

/** OpenSSH 风格的 SHA256 指纹：`SHA256:<base64 无 padding>`。 */
export function fingerprintSha256(keyBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

/** 该主机在 entries 中是否存在任何条目（不看密钥是否匹配、是否 revoked）。 */
export function hostEntryExists(host: string, port: number, entries: KnownHostEntry[]): boolean {
  const candidates = hostCandidates(host, port);
  return entries.some((e) => e.hostPatterns.some(
    (p) => matchesHashedPattern(p, candidates) || candidates.includes(p),
  ));
}

/**
 * 该主机是否存在**指定密钥类型**的条目。
 *
 * 判断「密钥不匹配」只能按同一 key type 比：服务器新增一种算法（如 ssh-rsa 之外
 * 再提供 ssh-ed25519）时，旧条目里没有该类型的记录，若按「该主机有任意条目」
 * 就硬失败，则永远无法 TOFU 新算法——连接直接断而不是弹确认。
 * 同一类型已有条目却不匹配，才是真正的密钥替换，须硬失败。
 */
export function hostEntryExistsForType(
  host: string,
  port: number,
  keyType: string,
  entries: KnownHostEntry[],
): boolean {
  const candidates = hostCandidates(host, port);
  return entries.some((e) => e.keyType === keyType && e.hostPatterns.some(
    (p) => matchesHashedPattern(p, candidates) || candidates.includes(p),
  ));
}

/** 把信任的主机密钥追加到插件自管 known_hosts（目录不存在则创建）。 */
export function appendPluginKnownHost(
  file: string,
  host: string,
  port: number,
  keyType: string,
  keyBlob: Buffer,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${knownHostsHost(host, port)} ${keyType} ${keyBlob.toString('base64')}`;
  // 幂等：同一条主机密钥重复接受时不再追加，避免 known_hosts 里堆重复行。
  // （追加写本身走 O_APPEND，短行写入对并发进程是原子的。）
  // 插件自管文件（非用户 ~/.ssh/known_hosts）：收紧为 0600。Windows 上 chmod 无效，
// 失败不阻断 TOFU（best-effort）。
  const tighten = (): void => {
    try { fs.chmodSync(file, 0o600); } catch { /* Windows / 文件系统不支持 */ }
  };
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === line)) {
    tighten();
    return;
  }
  fs.appendFileSync(file, `${line}\n`);
  tighten();
}

export interface VerifyHostKeyOptions {
  /** `tofu`：未知主机构建时询问用户；`strict`：未知主机直接拒绝。 */
  policy: 'tofu' | 'strict';
  host: string;
  port: number;
  keyBlob: Buffer;
  /** 插件自管 known_hosts 文件（TOFU 接受后写入这里）。 */
  pluginStoreFile: string;
  /** 用户 known_hosts；缺省用 `knownHostsPath()`。 */
  userKnownHostsFile?: string;
  /** 未知主机且 policy=tofu 时询问：`true`=信任并记住，`'once'`=仅本次（不写入），`false`=拒绝。 */
  prompt: (host: string, port: number, fingerprint: string, keyType: string) => Promise<boolean | 'once'>;
}

/**
 * 主机密钥裁决（strict / tofu）。
 *
 * 顺序：
 *  1. 已信任（用户或插件 known_hosts 命中且未吊销）→ true；
 *  2. 该主机已有条目但密钥不匹配，或命中 `@revoked` → **false（硬失败）**，
 *     即便 policy=tofu 也不 TOFU 覆盖（防密钥替换型 MITM）；
 *  3. 未知主机：strict → false；tofu → 询问用户，`true` 写入插件自管文件并 true，
 *     `'once'` 仅本次放行（不落盘，下次仍需裁决）。
 */
export async function verifyHostKey(opts: VerifyHostKeyOptions): Promise<boolean> {
  const userEntries = loadKnownHosts(opts.userKnownHostsFile);
  const pluginEntries = loadKnownHosts(opts.pluginStoreFile);
  const entries = [...userEntries, ...pluginEntries];

  if (isHostKeyTrusted(opts.host, opts.port, opts.keyBlob, entries)) return true;
  // 同一主机 + 同一密钥类型已有条目却不被信任 = 密钥不匹配或 revoked → 硬失败。
  // 只按类型判定：该主机只有另一种算法（如 ssh-rsa）的条目时，应视为未知并走 TOFU，
  // 而不是硬失败（否则服务器升级算法后连接永远失败）。
  if (hostEntryExistsForType(opts.host, opts.port, hostKeyType(opts.keyBlob), entries)) return false;
  if (opts.policy === 'strict') return false;

  const accepted = await opts.prompt(
    opts.host,
    opts.port,
    fingerprintSha256(opts.keyBlob),
    hostKeyType(opts.keyBlob),
  );
  if (!accepted) return false;
  if (accepted === 'once') return true; // 仅本次：不写入 known_hosts，下次重新裁决
  appendPluginKnownHost(opts.pluginStoreFile, opts.host, opts.port, hostKeyType(opts.keyBlob), opts.keyBlob);
  return true;
}
