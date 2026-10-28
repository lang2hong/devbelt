import { ValidationError } from '../../../domain/errors.js';
import type { ITelemetryRepo } from '../../../repository/interfaces/telemetry.js';

export const MAX_APP_VERSION = 64;
export const MAX_OS = 32;
export const MAX_ARCH = 32;

/** 扩展使用 `crypto.randomUUID()`（UUID v4）；只接受该形状，降低垃圾数据。 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HeartbeatInput {
  installId: string;
  appVersion: string;
  os?: string;
  arch?: string;
  isRemote?: boolean;
}

/** 匿名安装心跳：只做纯校验/裁剪，限流在路由层。 */
export class TelemetryService {
  constructor(private readonly repo: ITelemetryRepo) {}

  async heartbeat(input: HeartbeatInput): Promise<void> {
    const installId = (input.installId ?? '').trim().toLowerCase();
    if (!UUID_V4.test(installId)) throw new ValidationError('installId must be a UUID v4');

    const appVersion = trimmed(input.appVersion);
    if (!appVersion) throw new ValidationError('appVersion is required');
    if (appVersion.length > MAX_APP_VERSION) {
      throw new ValidationError(`appVersion exceeds ${MAX_APP_VERSION} characters`);
    }

    await this.repo.record({
      installId,
      appVersion,
      os: optional(input.os, MAX_OS, 'os'),
      arch: optional(input.arch, MAX_ARCH, 'arch'),
      isRemote: input.isRemote === true,
    });
  }
}

function trimmed(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function optional(v: string | undefined, max: number, name: string): string | null {
  const t = trimmed(v);
  if (!t) return null;
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  return t;
}