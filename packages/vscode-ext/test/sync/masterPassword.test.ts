import { describe, expect, it, vi } from 'vitest';
import { resolveMasterPassword, withMasterPassword } from '../../src/commands/shared';

/**
 * 主密码在验证之前就被记住。
 *
 * `resolveMasterPassword` 原先是：提示输入 → **立刻**写入 SecretStorage →
 * 返回。而调用方（syncPull / syncPush）拿到密码后才去 preview，那时才知道
 * 密码对不对。于是输错一次的后果是：
 *
 *  - pull：错误密码被记住 → 这次 preview 解密失败报错 → 下次 pull 时
 *    `getRememberedMasterPassword()` 直接返回那个错误密码，**不再提示输入**，
 *    再次失败。用户被永久卡住，除非知道存在一个"忘记主密码"的入口
 *    （实际只挂在 logout 里）。
 *  - push：更糟。错误密码会被用来**加密并上传**。远端数据从此用一个用户
 *    自己都不知道的密码加密，其他设备用正确密码拉取会全部解密失败 ——
 *    这是数据丢失级别的后果，而起因只是一次手抖。
 *
 * 修法：把"记住"从取密码里拆出来，交由调用方在**验证成功之后**触发。
 */

function makeSync(remembered?: string) {
  return {
    getRememberedMasterPassword: vi.fn(async () => remembered),
    rememberMasterPassword: vi.fn(async (_p: string) => {}),
    forgetMasterPassword: vi.fn(async () => {}),
  };
}

/** 用 mock 替掉 vscode 的输入框 */
const prompt = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('vscode', () => ({
  window: {
    showInputBox: vi.fn(async () => prompt.value),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showTextDocument: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({ get: () => true }),
    fs: { writeFile: vi.fn() },
    openTextDocument: vi.fn(),
  },
  // i18n 的语言探测走 env.language
  env: { language: 'en' },
  Uri: { joinPath: vi.fn() },
}));

describe('resolveMasterPassword', () => {
  it('新输入的密码不会立刻被记住', async () => {
    const sync = makeSync(undefined);
    prompt.value = 'typo-password';

    const r = await resolveMasterPassword(sync as any, true);

    expect(r?.password).toBe('typo-password');
    expect(sync.rememberMasterPassword, '验证之前不得写入 SecretStorage')
      .not.toHaveBeenCalled();
  });

  it('调用方确认后才写入', async () => {
    const sync = makeSync(undefined);
    prompt.value = 'good-password';

    const r = await resolveMasterPassword(sync as any, true);
    await r!.confirm();

    expect(sync.rememberMasterPassword).toHaveBeenCalledWith('good-password');
  });

  it('remember=false 时 confirm 也不写入（用户关掉了记住功能）', async () => {
    const sync = makeSync(undefined);
    prompt.value = 'good-password';

    const r = await resolveMasterPassword(sync as any, false);
    await r!.confirm();

    expect(sync.rememberMasterPassword).not.toHaveBeenCalled();
  });

  it('已记住的密码直接返回，且 confirm 是无操作（避免重复写入）', async () => {
    const sync = makeSync('stored-password');

    const r = await resolveMasterPassword(sync as any, true);
    await r!.confirm();

    expect(r?.password).toBe('stored-password');
    expect(sync.rememberMasterPassword).not.toHaveBeenCalled();
  });

  it('用户取消输入 → 返回 undefined，不写入任何东西', async () => {
    const sync = makeSync(undefined);
    prompt.value = undefined;

    const r = await resolveMasterPassword(sync as any, true);

    expect(r).toBeUndefined();
    expect(sync.rememberMasterPassword).not.toHaveBeenCalled();
  });

  it('空字符串视为取消（输入框里直接回车）', async () => {
    const sync = makeSync(undefined);
    prompt.value = '';

    const r = await resolveMasterPassword(sync as any, true);

    expect(r).toBeUndefined();
    expect(sync.rememberMasterPassword).not.toHaveBeenCalled();
  });

  /**
   * 验证失败时必须把已记住的错误密码清掉。
   *
   * 否则历史遗留的错误值（本次修复之前记下的）会让用户永远进不去 ——
   * 每次 pull 都拿那个错密码去解密，不再提示输入。
   */
  it('提供 reject 用于清掉已记住的错误密码', async () => {
    const sync = makeSync('wrong-stored');

    const r = await resolveMasterPassword(sync as any, true);
    await r!.reject();

    expect(sync.forgetMasterPassword).toHaveBeenCalled();
  });
});

/**
 * confirm / reject 的调用编排。
 *
 * 漏调它们是**静默失效**：漏 confirm 则"记住主密码"形同不存在（每次同步都要
 * 重输），漏 reject 则历史遗留的错误密码永远清不掉。两者都不报错。
 * 这段编排原先散在两个命令注册回调里，需要整套 vscode mock 才测得到 ——
 * 提取成 withMasterPassword 之后才有钉住的可能。
 */
describe('withMasterPassword', () => {
  it('操作成功 → 记住密码并返回结果', async () => {
    const sync = makeSync(undefined);
    prompt.value = 'good';

    const out = await withMasterPassword(
      sync as any, true,
      async (pw) => `used:${pw}`,
      () => { throw new Error('onError should not be called'); },
    );

    expect(out).toEqual({ password: 'good', result: 'used:good' });
    expect(sync.rememberMasterPassword).toHaveBeenCalledWith('good');
    expect(sync.forgetMasterPassword).not.toHaveBeenCalled();
  });

  it('操作失败 → 清掉记住的密码、上报错误、返回 undefined', async () => {
    const sync = makeSync('stale-wrong');
    const errors: unknown[] = [];

    const out = await withMasterPassword(
      sync as any, true,
      async () => { throw new Error('cannot decrypt'); },
      (e) => errors.push(e),
    );

    expect(out).toBeUndefined();
    expect(sync.forgetMasterPassword).toHaveBeenCalled();
    expect(sync.rememberMasterPassword).not.toHaveBeenCalled();
    expect((errors[0] as Error).message).toBe('cannot decrypt');
  });

  it('用户取消 → 不执行操作、不上报错误', async () => {
    const sync = makeSync(undefined);
    prompt.value = undefined;
    let ran = false;

    const out = await withMasterPassword(
      sync as any, true,
      async () => { ran = true; return 1; },
      () => { throw new Error('onError should not be called'); },
    );

    expect(out).toBeUndefined();
    expect(ran, '取消时不该拿 undefined 去解密').toBe(false);
  });

  it('操作拿到的是明文密码本身', async () => {
    const sync = makeSync('stored');
    let seen: string | undefined;
    await withMasterPassword(sync as any, true, async (pw) => { seen = pw; }, () => {});
    expect(seen).toBe('stored');
  });
});
