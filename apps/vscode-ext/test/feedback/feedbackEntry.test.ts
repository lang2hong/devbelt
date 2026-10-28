import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('vscode', () => ({}));

const { OPEN_FEEDBACK_COMMAND } = await import('../../src/feedback/feedbackView');

const ROOT = join(__dirname, '../..');

describe('反馈入口命令', () => {
  it('侧边栏用的常量、package.json 声明、extension.ts 注册三处命令名一致', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    const declared = pkg.contributes.commands.find((c) => c.command === OPEN_FEEDBACK_COMMAND);
    expect(declared?.title).toBe('%cmd.feedback.open%');

    const ext = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');
    expect(ext).toContain(`registerCommand('${OPEN_FEEDBACK_COMMAND}'`);
  });

  it('命令标题在中英文 nls 中都有定义', () => {
    for (const f of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const nls = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, string>;
      expect(nls['cmd.feedback.open'], f).toBeTruthy();
    }
  });
});
