/**
 * 个人同步「客户端签 → 服务端 Node verify」互通测试向量（单一源）。
 *
 * 固定 32B seed 派生 Ed25519 公钥，并对固定 signingInput 的 JCS 消息签名。
 * - 扩展端断言 @noble/curves 确定性复算得到同一公钥/签名；
 * - 服务端断言 Node `crypto.verify` 对该签名验签通过（篡改消息则失败）。
 * 该向量不得在任一包内拷贝，双方共同 import 本文件以验证端到端签名互通。
 */

export const SYNC_SIGN_TEST_VECTOR = {
  /** 32B seed（0x11 × 32） */
  seedHex: '1111111111111111111111111111111111111111111111111111111111111111',
  /** 派生的 32B raw 公钥 */
  publicKeyHex: 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
  /** 被签消息（signingInput `state.destroy` 的 JCS，UTF-8） */
  message: '{"action":"state.destroy","domain":"devbelt/sync/v1","expectedStateVersion":"1","keyEpoch":"1","mutationId":"AAAAAAAAAAAAAAAAAAAAAA","requestDigest":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","userId":"7"}',
  /** 64B 签名，base64url 无 padding */
  signatureB64Url: 'EZCyOzwljqjCbxVgOLyhM1Kw2Ir-HHVh0ILzMP0ZANksjvRzOYwk6WX6x7C0tXsFmms2Jt781hkeDxme29KdBw',
} as const;
