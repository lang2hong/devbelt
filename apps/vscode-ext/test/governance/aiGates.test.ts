import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AiBridge } from '../../src/ai/aiBridge';

/**
 * AI 机械门禁（P9 S6，§十一"源自 P7/P8 教训"清单）：
 * 密钥/审计/协议/setting 的静态与行为断言；模式只针对 src/ai 与少量接线文件窄匹配。
 */
const SRC = join(__dirname, '../../src');
const PKG = join(__dirname, '../../package.json');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return name.endsWith('.ts') ? [p] : [];
  });
}

interface Pkg {
  contributes: {
    configuration: { properties: Record<string, { default?: unknown }> };
    keybindings: { command: string; key: string; when?: string }[];
  };
}

describe('AI 机械门禁', () => {
  it('apiKey 只落 SecretStorage：AiKeyStore 无 Memento/globalState 读写调用（注释提及不算）', () => {
    const text = read('ai/aiKeyStore.ts');
    expect(text).not.toMatch(/\bmemento\.(get|update)|\bglobalState\.(get|update)/i);
    expect(text).toContain('secrets.store');
    expect(text).toContain('secrets.delete');
  });

  it('src/ai 无把 apiKey 写入日志/诊断/console 的调用', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'ai'))) {
      const text = readFileSync(file, 'utf8');
      if (/(?:log|diag\w*|console\.\w+)\s*\([^)]*apiKey/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('协议层（aiProtocol.ts）不含 apiKey 载荷字段：密钥永不进 webview', () => {
    // `setApiKey`/`clearApiKey` 是无载荷的 UI 命令消息；这里断言不存在携带密钥值的字段。
    const text = read('result/aiProtocol.ts');
    expect(text).not.toMatch(/(?:^|[\s{,(])apiKey\s*[:?]/);
    expect(text).not.toMatch(/apiKey:\s*string/);
  });

  it('审计仅元数据：writeAudit 不含 prompt/messages/content（类型层面 AuditEntry 亦无）', () => {
    const aiService = read('ai/aiService.ts');
    const start = aiService.indexOf('private writeAudit');
    expect(start).toBeGreaterThan(-1);
    const slice = aiService.slice(start, start + 500);
    expect(slice).not.toMatch(/messages|prompt|content|apiKey/i);

    const audit = read('utils/auditLogger.ts');
    const entryStart = audit.indexOf('export interface AuditEntry');
    const entrySlice = audit.slice(entryStart, audit.indexOf('}', entryStart));
    expect(entrySlice).not.toMatch(/prompt|messages|apiKey|secret/i);
  });

  it('AI 设置：默认值正确且源码有读取点（enableInlineCompletion/dataSampleRows/schemaContextMode/includeColumnComments）', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as Pkg;
    const props = pkg.contributes.configuration.properties;
    expect(props['devbelt.ai.enableInlineCompletion']?.default).toBe(false);
    expect(props['devbelt.ai.dataSampleRows']?.default).toBe(10);
    expect(props['devbelt.ai.schemaContextMode']?.default).toBe('current-db');
    expect(props['devbelt.ai.includeColumnComments']?.default).toBe(true);

    expect(read('completion/aiInlineProvider.ts')).toContain("'ai.enableInlineCompletion'");
    const aiService = read('ai/aiService.ts');
    for (const key of ['ai.dataSampleRows', 'ai.schemaContextMode', 'ai.includeColumnComments']) {
      expect(aiService, key).toContain(key);
    }

    // Alt+/ 键位引用同一配置（VS Code config.* when 上下文）
    const binding = pkg.contributes.keybindings.find((k) => k.command === 'devbelt.ai.inlineComplete');
    expect(binding?.when).toContain('config.devbelt.ai.enableInlineCompletion');
  });

  it('AI 未启用（bridge 未初始化）时安全：tryGet 空值 no-op，接线视图有用户提示', () => {
    AiBridge.reset();
    expect(AiBridge.tryGet()).toBeUndefined();
    expect(read('result/tableQueryView.ts')).toContain("l10n('ai.notEnabled')");
    expect(read('result/tableDesignView.ts')).toContain("l10n('ai.notEnabled')");
  });
});