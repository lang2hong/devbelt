import type { ExplainPlan, ExplainPlanNode } from './types.js';

export interface FormatPlanOptions {
  /** Maximum number of nodes rendered before truncating. */
  maxNodes?: number;
  /** Maximum output length in characters before truncating. */
  maxChars?: number;
}

export const DEFAULT_FORMAT_MAX_NODES = 200;
export const DEFAULT_FORMAT_MAX_CHARS = 8000;

function describeNode(node: ExplainPlanNode): string {
  const parts: string[] = [node.operation];
  if (node.object) parts.push(`on ${node.object}`);
  if (node.index) parts.push(`index=${node.index}`);
  if (node.estimatedRows !== undefined) parts.push(`rows=${node.estimatedRows}`);
  if (node.actualRows !== undefined) parts.push(`actualRows=${node.actualRows}`);
  if (node.estimatedCost !== undefined) parts.push(`cost=${node.estimatedCost}`);
  if (node.actualTimeMs !== undefined) parts.push(`timeMs=${node.actualTimeMs}`);
  if (node.loops !== undefined) parts.push(`loops=${node.loops}`);
  if (node.indexCondition) parts.push(`indexCond=${node.indexCondition}`);
  if (node.joinCondition) parts.push(`joinCond=${node.joinCondition}`);
  if (node.filter) parts.push(`filter=${node.filter}`);
  if (node.warnings.length > 0) parts.push(`[warnings: ${node.warnings.join(', ')}]`);
  return parts.join(' ');
}

/**
 * Render a normalized plan as compact indented text (one node per line).
 *
 * Intended for prompts and logs: far smaller than the engine's raw JSON and
 * identical in shape across dialects. Output is bounded by node count and
 * character length; a trailing marker states how much was omitted.
 */
export function formatPlanText(plan: ExplainPlan, options: FormatPlanOptions = {}): string {
  const maxNodes = options.maxNodes ?? DEFAULT_FORMAT_MAX_NODES;
  const maxChars = options.maxChars ?? DEFAULT_FORMAT_MAX_CHARS;

  const lines: string[] = [];
  let total = 0;
  let rendered = 0;
  let length = 0;
  let truncated = false;

  const walk = (nodes: readonly ExplainPlanNode[], depth: number): void => {
    for (const node of nodes) {
      total += 1;
      if (!truncated) {
        const line = `${'  '.repeat(depth)}- ${describeNode(node)}`;
        if (rendered >= maxNodes || length + line.length + 1 > maxChars) {
          truncated = true;
        } else {
          lines.push(line);
          rendered += 1;
          length += line.length + 1;
        }
      }
      walk(node.children, depth + 1);
    }
  };
  walk(plan.roots, 0);

  if (plan.warnings.length > 0) lines.unshift(`Plan warnings: ${plan.warnings.join(', ')}`);
  if (truncated) lines.push(`… (${total - rendered} more node(s) omitted)`);
  return lines.join('\n');
}