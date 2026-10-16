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

  it('协议层（aiProtocol.ts）apiKey 仅出现在上行 save/test：下行永不携带密钥值', () => {
    // P9 模型接入（2026-10-16 批准的方案 A）：Key 允许经上行 saveModelAccess/testModelAccess
    // 一次性进入宿主（SecretStorage）；**下行任何消息不得携带 apiKey 值**（只允许 hasKey 布尔）。
    const text = read('result/aiProtocol.ts');
    const splitAt = text.indexOf('AiSaveModelAccessUp');
    expect(splitAt).toBeGreaterThan(-1);
    // 上行区（含 save/test 两条具名接口）：apiKey 必须只作为 string 字段出现（不超过 2 处定义）。
    const up = text.slice(splitAt);
    expect((up.match(/apiKey\s*:/g) ?? []).length).toBeLessThanOrEqual(2);
    // 下行区（splitAt 之前，含所有 Down 消息）：不允许任何 apiKey 字段。
    const down = text.slice(0, splitAt);
    expect(down).not.toMatch(/apiKey\s*[:?]/);
    // 全文：不允许出现 apiKey 的回显/下发措辞（getApiKey/down 类载荷）。
    expect(text).not.toMatch(/(?:^|[\s{,(])apiKey\?\s*:/);
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

  it('模型接入：Memento 侧存储无 apiKey 字段落点（Key 只在 SecretStorage）', () => {
    const store = read('ai/aiModelAccessStore.ts');
    // 落 Memento 的记录结构（ModelAccessRecord → fields）不得含 apiKey；stripKey 兜底丢弃。
    const recStart = store.indexOf('export interface ModelAccessRecord');
    expect(recStart).toBeGreaterThan(-1);
    const recSlice = store.slice(recStart, store.indexOf('}', recStart));
    expect(recSlice).not.toMatch(/apiKey/i);
    expect(store).toContain('stripKey');
    const backend = read('ai/modelAccessSyncBackend.ts');
    // 后端只在 prefs.key 且 payload 携带时写 SecretStorage；不得写 Memento。
    expect(backend).toMatch(/setApiKey/);
    expect(backend).not.toMatch(/memento\.update/);
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