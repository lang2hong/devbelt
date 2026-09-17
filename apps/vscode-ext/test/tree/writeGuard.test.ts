import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const COMMANDS_DIR = path.resolve(__dirname, '../../src/commands');

/**
 * 写命令必须过闸的守门测试。
 *
 * `ensureWritable` 是「只读连接」这个能力边界的唯一实现点，`confirmSqlExecution`
 * 在其之上再加危险语句 / 生产环境确认。树右键的 DDL 命令刻意不弹确认框（产品
 * 决定），于是只读拦截全靠 handler 里那一行调用 —— 一旦漏写，只读连接上照样
 * 能 DROP TABLE / DROP DATABASE，而且没有任何机制会报错。
 *
 * 本测试机械扫描源码：清单里的每个写命令，其 handler 体内（或它直接调用的同
 * 文件辅助函数体内）必须出现两个守卫之一。新增写命令漏加守卫时这里会直接红。
 *
 * 为什么用静态扫描而不是行为测试：这些 handler 依赖 vscode 交互（QuickPick /
 * InputBox / 模态）与真实连接，行为测试要 mock 的东西远多于被验证的那一行；
 * 同类做法见 menuWhen.test.ts（扫 package.json）与 i18nMigration.test.ts。
 */

const GUARDS = ['ensureWritable', 'confirmSqlExecution'];

/** 会真正落库的命令 → 所在文件。仅列「直接执行」的，不含只打开 SQL 模板的。 */
const WRITE_COMMANDS: Record<string, string[]> = {
  'table.ts': [
    'devbelt.dropTable',
    'devbelt.renameTable',
    'devbelt.renameView',
    'devbelt.truncateTable',
    'devbelt.dupTable',
    'devbelt.copyTable',
    'devbelt.mockData',
    'devbelt.dropView',
    'devbelt.dropRoutine',
    'devbelt.dropEvent',
    'devbelt.addColumn',
    'devbelt.modifyColumn',
    'devbelt.renameColumn',
    'devbelt.dropColumn',
  ],
  'database.ts': [
    'devbelt.createDatabase',
    'devbelt.dropDatabase',
    'devbelt.restoreDatabase',
    'devbelt.importData',
    'devbelt.importTable',
    // 写目标连接而非 node.conn，守卫参数是 target.value
    'devbelt.syncDatabase',
  ],
  'ddl.ts': [
    'devbelt.addIndex',
    'devbelt.modifyIndex',
    'devbelt.dropIndex',
    'devbelt.dropTrigger',
    'devbelt.addForeignKey',
    'devbelt.dropForeignKey',
  ],
  // query.ts 原本不在扫描范围内 —— 这正是 devbelt.updateCell 长期漏掉守卫的原因。
  // 它是个已注册命令，任何 executeCommand 调用方（其他扩展、webview 消息）都能
  // 直接触发，绕过 RowEditor 那条带确认的路径。
  'query.ts': [
    'devbelt.updateCell',
  ],
};

/**
 * 已知缺口，尚未处理。
 * 列在这里而不是清单里，是为了让缺口显式可见而非静默漏掉。
 * 当前为空 —— 新发现的缺口在修掉之前先登记到这里。
 */
const KNOWN_UNGUARDED: Record<string, string> = {};

function read(file: string): string {
  return fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
}

/**
 * 从 `start` 处的 `(` 开始做括号配平，返回配平结束的下标（不含）。
 * 跳过字符串（'"`）与注释，避免里面的括号干扰计数。
 */
function matchParen(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return text.length;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

/** 跳过一个字符串字面量（含反斜杠转义与模板串的 ${} 嵌套）。 */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      // 模板插值里可能再嵌字符串/括号，配平花括号后继续
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '\'' || c === '"' || c === '`') { i = skipString(text, i); continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return text.length;
}

/** 取出 `sub('cmd', ...)` 整个调用的源码文本。 */
function handlerBody(text: string, command: string): string | undefined {
  const marker = `sub('${command}'`;
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const paren = text.indexOf('(', at);
  return text.slice(paren, matchParen(text, paren));
}

/** 同文件内 `export async function name(` / `async function name(` 的函数体。 */
function topLevelFunctions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  for (const m of text.matchAll(re)) {
    const paren = m.index! + m[0].length - 1;
    const afterArgs = matchParen(text, paren);
    const brace = text.indexOf('{', afterArgs);
    if (brace < 0) continue;
    out.set(m[1], text.slice(brace, findBlockEnd(text, brace)));
  }
  return out;
}

/** 从 `{` 起配平花括号。 */
function findBlockEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return text.length;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { i = skipString(text, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

function hasGuard(body: string): boolean {
  return GUARDS.some((g) => body.includes(g));
}

describe('写命令必须调用只读/危险语句闸门', () => {
  for (const [file, commands] of Object.entries(WRITE_COMMANDS)) {
    describe(file, () => {
      const text = read(file);
      const helpers = topLevelFunctions(text);

      for (const command of commands) {
        it(`${command} 过闸`, () => {
          const body = handlerBody(text, command);
          expect(body, `${file} 里找不到 ${command} 的注册（命令被改名或删除？）`).toBeTruthy();
          if (hasGuard(body!)) return;

          // 一层间接：handler 委托给同文件的辅助函数（如 importSqlScript）
          const delegated = [...helpers.entries()]
            .filter(([name]) => new RegExp(`\\b${name}\\s*\\(`).test(body!))
            .some(([, helperBody]) => hasGuard(helperBody));

          expect(
            delegated,
            `${command} 的 handler 既没直接调用 ${GUARDS.join('/')}，`
            + '委托的同文件辅助函数里也没有。只读连接将不受保护。',
          ).toBe(true);
        });
      }
    });
  }

  it('清单覆盖了所有会落库的命令（新增写命令须同步本清单）', () => {
    // 反向校验：源码里出现 session.table.<写方法> 或 session.query.query( 的命令，
    // 必须出现在 WRITE_COMMANDS 或 KNOWN_UNGUARDED 中。
    const listed = new Set([
      ...Object.values(WRITE_COMMANDS).flat(),
      ...Object.keys(KNOWN_UNGUARDED),
    ]);
    const missing: string[] = [];

    for (const file of Object.keys(WRITE_COMMANDS)) {
      const text = read(file);
      for (const m of text.matchAll(/sub\('(devbelt\.\w+)'/g)) {
        const command = m[1];
        if (listed.has(command)) continue;
        const body = handlerBody(text, command);
        if (!body) continue;
        // 只打开编辑器模板的命令不算写；判据是是否真的调用了执行入口
        const executes = /session\.query\.query\(|session\.table\.(?!getC|getColumnDefinition)/.test(body);
        if (executes) missing.push(`${file}: ${command}`);
      }
    }

    expect(missing, `未登记的写命令:\n${missing.join('\n')}`).toEqual([]);
  });

  it('已知缺口清单不为空时必须有说明（防止悄悄塞进来）', () => {
    for (const [command, reason] of Object.entries(KNOWN_UNGUARDED)) {
      expect(reason.length, `${command} 缺少缺口说明`).toBeGreaterThan(10);
    }
  });
});
