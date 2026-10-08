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
 *  3. **含 `\xHH` 的 token 返回 `Buffer`**：`\xE4` 是原始字节 0xE4，若返回 JS 字符串再走
 *     ioredis（UTF-8 编码）会变成 C3 A4。返回 Buffer 后由调用方走 `sendCommandBuffer`。
 */

const HEX_RE = /^[0-9a-fA-F]{2}$/;

function isSpace(ch: string | undefined): boolean {
  // 与上游 isspace 严格一致：含垂直制表 \v 与换页 \f。
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\v' || ch === '\f';
}

/** 将一行命令切分为参数数组（不解析命令名语义）。空行返回 `[]`。 */
export function splitRedisArgs(line: string): (string | Buffer)[] {
  const ret: (string | Buffer)[] = [];
  if (typeof line !== 'string' || line.length === 0) return ret;
  const len = line.length;
  let pos = 0;

  while (pos < len) {
    while (pos < len && isSpace(line[pos])) pos++;
    if (pos >= len) break;

    const current: string[] = [];
    /** 一旦出现 `\xHH` 就切到字节累积（初始为 null）。 */
    let bytes: number[] | null = null;
    const pushChar = (ch: string): void => {
      if (bytes) bytes.push(...Buffer.from(ch, 'utf8'));
      else current.push(ch);
    };
    const pushByte = (b: number): void => {
      if (!bytes) { bytes = [...Buffer.from(current.join(''), 'utf8')]; current.length = 0; }
      bytes.push(b);
    };
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
            case 'n': pushChar('\n'); break;
            case 'r': pushChar('\r'); break;
            case 't': pushChar('\t'); break;
            case 'b': pushChar('\b'); break;
            case 'a': pushChar('\u0007'); break;
            case 'x': {
              const hex = line.substr(pos + 1, 2);
              if (HEX_RE.test(hex)) {
                // 单字节（按码点），而非 utf8 解码：`\xE4` 等 ≥0x80 的字节必须原样发出。
                pushByte(parseInt(hex, 16));
                pos += 2;
              } else {
                pushChar('x');
              }
              break;
            }
            default: pushChar(e); break;
          }
        } else if (c === '"') {
          if (pos + 1 < len && !isSpace(line[pos + 1])) {
            throw new Error(`Expect '"' followed by a space or nothing, got '${line[pos + 1]}'.`);
          }
          done = true;
        } else {
          pushChar(c);
        }
      } else if (inSingle) {
        if (c === '\\' && line[pos + 1] === "'") {
          pos += 1;
          pushChar("'");
        } else if (c === "'") {
          if (pos + 1 < len && !isSpace(line[pos + 1])) {
            throw new Error(`Expect "'" followed by a space or nothing, got "${line[pos + 1]}".`);
          }
          done = true;
        } else {
          pushChar(c);
        }
      } else if (c === '"') {
        inDouble = true;
      } else if (c === "'") {
        inSingle = true;
      } else if (isSpace(c)) {
        done = true;
      } else {
        pushChar(c);
      }

      if (pos < len) pos++;
    }
    ret.push(bytes ? Buffer.from(bytes) : current.join(''));
  }

  return ret;
}