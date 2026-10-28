import { describe, expect, it, vi } from 'vitest';
import { TelemetryService, MAX_OS } from '../../src/modules/telemetry/service/telemetryService';

const INSTALL_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeRepo() {
  return {
    record: vi.fn(async () => undefined),
    overview: vi.fn(),
  };
}

const base = {
  installId: INSTALL_ID,
  appVersion: '0.4.1',
  os: 'linux',
  arch: 'x64',
  isRemote: false,
};

describe('TelemetryService', () => {
  it('规范化 installId 并落库', async () => {
    const repo = makeRepo();
    const svc = new TelemetryService(repo as never);
    await svc.heartbeat({ ...base, installId: ` ${INSTALL_ID.toUpperCase()} `, appVersion: ' 0.4.1 ' });
    expect(repo.record).toHaveBeenCalledWith({
      installId: INSTALL_ID,
      appVersion: '0.4.1',
      os: 'linux',
      arch: 'x64',
      isRemote: false,
    });
  });

  it('拒绝非 UUID v4 的 installId', async () => {
    const svc = new TelemetryService(makeRepo() as never);
    await expect(svc.heartbeat({ ...base, installId: 'not-a-uuid' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('拒绝空版本号', async () => {
    const svc = new TelemetryService(makeRepo() as never);
    await expect(svc.heartbeat({ ...base, appVersion: '   ' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('拒绝超长 os', async () => {
    const svc = new TelemetryService(makeRepo() as never);
    await expect(svc.heartbeat({ ...base, os: 'x'.repeat(MAX_OS + 1) }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('isRemote 缺省为 false', async () => {
    const repo = makeRepo();
    const svc = new TelemetryService(repo as never);
    await svc.heartbeat({ installId: INSTALL_ID, appVersion: '0.4.1' });
    expect(repo.record).toHaveBeenCalledWith(expect.objectContaining({
      installId: INSTALL_ID,
      os: null,
      arch: null,
      isRemote: false,
    }));
  });
});