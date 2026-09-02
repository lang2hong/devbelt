import { argon2id } from '@noble/hashes/argon2.js';
import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * 密码哈希（Argon2id，纯 JS @noble/hashes）。
 *
 * 参数固定（实施规格 §5.1）：memory 65536 KiB、iterations 3、parallelism 1、
 * salt 16 bytes、output 32 bytes。每个 hash 自描述算法与参数，格式：
 *
 *   `argon2id$m=65536,t=3,p=1$<salt base64>$<hash base64>`
 *
 * 验证时按**存储的自描述参数**重算（而非当前硬编码参数），使未来参数升级后
 * 旧 hash 仍可验证。
 */

const HASH_PREFIX = 'argon2id$';
const SALT_BYTES = 16;

/** 固定参数（写入自描述串；验证以存储串为准）。 */
const MEMORY_KIB = 65536;
const ITERATIONS = 3;
const PARALLELISM = 1;
const OUTPUT_BYTES = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = computeHash(password, salt, MEMORY_KIB, ITERATIONS, PARALLELISM, OUTPUT_BYTES);
  return `${HASH_PREFIX}m=${MEMORY_KIB},t=${ITERATIONS},p=${PARALLELISM}$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

/**
 * 校验密码。使用 timingSafeEqual 防时序攻击；旧格式/坏参数一律返回 false。
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored.startsWith(HASH_PREFIX)) return false;
  const body = stored.slice(HASH_PREFIX.length);
  const sep1 = body.indexOf('$');
  if (sep1 < 0) return false;
  const params = body.slice(0, sep1);
  const rest = body.slice(sep1 + 1);
  const sep2 = rest.lastIndexOf('$');
  if (sep2 < 0) return false;
  const salt = Buffer.from(rest.slice(0, sep2), 'base64');
  const expected = Buffer.from(rest.slice(sep2 + 1), 'base64');

  const pm = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(params);
  if (!pm) return false;
  const m = Number(pm[1]);
  const t = Number(pm[2]);
  const p = Number(pm[3]);
  if (!Number.isInteger(m) || !Number.isInteger(t) || !Number.isInteger(p) || m <= 0 || t <= 0 || p <= 0) {
    return false;
  }

  const actual = Buffer.from(computeHash(password, salt, m, t, p, expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function computeHash(
  password: string,
  salt: Uint8Array,
  memoryKib: number,
  iterations: number,
  parallelism: number,
  outputBytes: number,
): Uint8Array {
  return argon2id(password, salt, { m: memoryKib, t: iterations, p: parallelism, dkLen: outputBytes });
}