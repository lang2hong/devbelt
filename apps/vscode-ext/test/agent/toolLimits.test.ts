import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_DEFINITIONS } from '../../src/agent/tools';
import { MONITOR_TOOL_DEFINITION } from '../../src/agent/monitorTool';
import { buildWriteTools } from '../../src/agent/writeTools';

/**
 * 服务端 `/api/ai/chat` 的校验上限（`aiProxyService.parseTools`）：
 * description ≤ 1024 字符、单个 parameters ≤ 16 KB、最多 32 个工具。
 * 超了服务端直接 400，而 400 会被当成「工具定义有问题」——曾经因为
 * `propose_monitor` 的描述 1513 字符，让整个 Agent 请求失败。
 */
const MAX_DESCRIPTION = 1024;
const MAX_SCHEMA_BYTES = 16_384;
const MAX_TOOLS = 32;

// 写工具默认不注册，但打开写权限后会一起发给服务端，因此同样受限制。
const definitions = [...AGENT_TOOL_DEFINITIONS, MONITOR_TOOL_DEFINITION, ...buildWriteTools({} as never).definitions];

describe('agent tool definitions fit the server limits', () => {
  it('stays within the tool count', () => {
    expect(definitions.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it.each(definitions.map((d) => [d.name, d] as const))('%s: description and schema size', (_name, def) => {
    expect(def.description?.length ?? 0).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(Buffer.byteLength(JSON.stringify(def.parameters), 'utf8')).toBeLessThanOrEqual(MAX_SCHEMA_BYTES);
  });

  it('has unique, server-acceptable names', () => {
    const names = definitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});