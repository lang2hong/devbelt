/**
 * Redis 控制台命令行切分。
 *
 * 按 ARDM 使用的 `@qii404/redis-splitargs` v1.0.1（MIT；原作者 Zihua Li，qii404 fork）
 * 的用户可见语义移植，保证 DevBelt 控制台的引号/转义行为与 ARDM 一致：
 *  - 空白（空格 / \n / \r / \t / \v / \f）分隔参数；
 *  - 双引号内支持 `\n \r \t \b \a`、`\xHH`（hex）与任意 `\c` 转义；闭合双引号后必须是空白或行尾；
 *  - 单引号内 `\'` 表示字面单引号；闭合单引号后必须是空白或行尾；
 *  - 引号未闭合抛错。
 *
 * 与上游的有意差异（修正上游缺陷）：
 *  1. 上游单引号转义分支用 `current += "'"`，在数组上做 `+=` 会把 token 退化为字符串，
 *     后续 `push` 会失败；这里统一用数组累积。
 *  2. 上游 `case 'a': c = '\a'`——JS 无 `\a` 转义，实际产出字面 `a`；这里用 `\x07`（BEL），
 *     即上游本意。
 */

const HEX_RE = /^[0-9a-fA-F]{2}$/;

function isSpace(ch: string | undefined): boolean {
  // 与上游 isspace 严格一致：含垂直制表 \v 与换页 \f。
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\v' || ch === '\f';
}

/** 将一行命令切分为参数数组（不解析命令名语义）。空行返回 `[]`。 */
export function splitRedisArgs(line: string): string[] {
  const ret: string[] = [];
  if (typeof line !== 'string' || line.length === 0) return ret;
  const len = line.length;
  let pos = 0;

  while (pos < len) {
    while (pos < len && isSpace(line[pos])) pos++;
    if (pos >= len) break;

    const current: string[] = [];
    let inDouble = false;
    let inSingle = false;
    let done = false;

    while (!done) {
      if (pos >= len) {
        if (inDouble || inSingle) throw new Error('Unterminated quotes.');
        break;
      }
      const c = line[pos];

      if (inDouble) {
        if (c === '\\' && pos + 1 < len) {
          pos += 1;
          const e = line[pos];
          switch (e) {
            case 'n': current.push('\n'); break;
            case 'r': current.push('\r'); break;
            case 't': current.push('\t'); break;
            case 'b': current.push('\b'); break;
            case 'a': current.push('\x07'); break;
            case 'x': {
              const hex = line.substr(pos + 1, 2);
              if (HEX_RE.test(hex)) {
                current.push(Buffer.from(hex, 'hex').toString('utf8'));
                pos += 2;
              } else {
                current.push('x');
              }
              break;
            }
            default: current.push(e); break;
          }
        } else if (c === '"') {
          if (pos + 1 < len && !isSpace(line[pos + 1])) {
            throw new Error(`Expect '"' followed by a space or nothing, got '${line[pos + 1]}'.`);
          }
          done = true;
        } else {
          current.push(c);
        }
      } else if (inSingle) {
        if (c === '\\' && line[pos + 1] === "'") {
          pos += 1;
          current.push("'");
        } else if (c === "'") {
          if (pos + 1 < len && !isSpace(line[pos + 1])) {
            throw new Error(`Expect "'" followed by a space or nothing, got "${line[pos + 1]}".`);
          }
          done = true;
        } else {
          current.push(c);
        }
      } else if (c === '"') {
        inDouble = true;
      } else if (c === "'") {
        inSingle = true;
      } else if (isSpace(c)) {
        done = true;
      } else {
        current.push(c);
      }

      if (pos < len) pos++;
    }
    ret.push(current.join(''));
  }

  return ret;
}
