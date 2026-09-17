import { parentPort } from 'worker_threads';
import { argon2id } from '@noble/hashes/argon2.js';

/**
 * Argon2id 计算 worker。
 *
 * 存在理由：Argon2id（m=65536,t=3,p=1）在本机实测约 2.4s，且 `@noble/hashes` v2 的
 * `argon2idAsync` **并不会**让出事件循环（实测 asyncTick=1/5/20 期间定时器 0 次触发）。
 * 若在主线程计算，每次登录/注册/改密都会把整个进程冻住 2.4s —— 包含 /health、
 * 其它请求和清理定时器。移到 worker 后主线程保持可响应，并且多核可并行。
 *
 * 每条请求新建一个 worker、算完即退（不池化）：登录频率低，省去池的生命周期管理；
 * 且 worker 崩溃不会污染后续请求。
 *
 * 消息协议（结构化克隆，不落日志）：
 *   入参 { password, salt, m, t, p, dkLen }
 *   回参 { ok: true, hash: Uint8Array } | { ok: false, error: string }
 * 明文密码只存在于 worker 生命周期内，不写日志、不进错误消息。
 */

export interface Argon2Request {
  password: string;
  salt: Uint8Array;
  m: number;
  t: number;
  p: number;
  dkLen: number;
}

export type Argon2Response =
  | { ok: true; hash: Uint8Array }
  | { ok: false; error: string };

const port = parentPort;
if (!port) throw new Error('passwordWorker must run as a worker thread');

port.on('message', (req: Argon2Request) => {
  let resp: Argon2Response;
  try {
    const hash = argon2id(req.password, req.salt, {
      m: req.m,
      t: req.t,
      p: req.p,
      dkLen: req.dkLen,
    });
    resp = { ok: true, hash };
  } catch (err) {
    // 只回传消息文本，不回传堆栈或入参，避免明文密码经由错误对象外泄。
    resp = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(resp);
});
