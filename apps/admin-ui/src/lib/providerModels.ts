import type { AdminAiProviderModel } from '../api/admin';

/**
 * 模型列表的文本编辑格式（一行一个）：
 *   `*gpt-4o-mini | GPT-4o mini`   —— 前缀 `*` 表示默认模型；`| 显示名` 可省略。
 * 空行忽略；id 不允许含空白。
 */
export function parseModelLines(text: string): { models: AdminAiProviderModel[]; error?: string } {
  const models: AdminAiProviderModel[] = [];
  const seen = new Set<string>();
  let defaults = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const isDefault = line.startsWith('*');
    const body = (isDefault ? line.slice(1) : line).trim();
    const [idPart, ...labelParts] = body.split('|');
    const id = (idPart ?? '').trim();
    const label = labelParts.join('|').trim();
    if (!id) return { models: [], error: '模型 id 不能为空。' };
    if (/\s/.test(id)) return { models: [], error: `模型 id 不能含空白：${id}` };
    if (id.length > 128) return { models: [], error: `模型 id 过长：${id.slice(0, 20)}…` };
    if (label.length > 64) return { models: [], error: `显示名过长：${id}` };
    if (seen.has(id)) return { models: [], error: `模型 id 重复：${id}` };
    seen.add(id);
    const model: AdminAiProviderModel = { id };
    if (label) model.label = label;
    if (isDefault) {
      defaults += 1;
      model.default = true;
    }
    models.push(model);
  }
  if (models.length === 0) return { models: [], error: '至少需要一个模型。' };
  if (models.length > 50) return { models: [], error: '模型最多 50 个。' };
  if (defaults > 1) return { models: [], error: '默认模型（*）至多一个。' };
  return { models };
}

export function formatModelLines(models: AdminAiProviderModel[]): string {
  return models.map((m) => `${m.default ? '*' : ''}${m.id}${m.label ? ` | ${m.label}` : ''}`).join('\n');
}
