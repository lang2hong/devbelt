/**
 * 控制台写请求幂等键工具（P3 §6.1）。
 *
 * 所有 console 写 API（组织写 8 类 + PATCH /me + 设备撤销）必须携带 RFC 4122
 * UUIDv4 形态的 Idempotency-Key（服务端 validateIdempotencyKey 强校验）。用户每
 * 个写动作生成一次新键，同一次提交重试沿用同一键（由页面「提交中」防抖保证）。
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}