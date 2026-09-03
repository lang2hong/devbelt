import { parentPort } from 'worker_threads';
import { deriveKekSmp } from './argon2';
import { assertSmpKdfParams, type SmpKdfParams } from './smpKdfParams';
import { encodeBase64Url } from './recoveryCode';

/**
 * Argon2id KDF worker（§7.1：Argon2id 必须在 Worker 执行）。
 *
 * 每个 worker 只处理一条请求（每次派生新建 worker、不池化）。消息协议（结构化克隆，
 * 不经日志）：入参 { smp, params: SmpKdfParams }，回参 { ok, result?: base64url 32B KEK,
 * error?: message }。不回写日志/审计，不泄露 smp、KEK 或派生细节（§8）。
 */

interface WorkerRequest {
  smp: string;
  params: SmpKdfParams;
}

interface WorkerResponse {
  ok: boolean;
  result?: string;
  error?: string;
}

const port = parentPort;
if (!port) throw new Error('argon2Worker must run as a worker thread');

port.on('message', async (req: WorkerRequest) => {
  const resp: WorkerResponse = { ok: true };
  try {
    assertSmpKdfParams(req.params);
    const kek = await deriveKekSmp(req.smp, req.params);
    resp.result = encodeBase64Url(kek);
  } catch (err) {
    resp.ok = false;
    resp.error = err instanceof Error ? err.message : String(err);
  }
  port.postMessage(resp);
});