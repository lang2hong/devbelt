/**
 * 把不可信文本安全地放进 SQL 注释。
 *
 * dump/导出里的「连接名、host、库名、表名」是可变文本，被写进 `/* ... *\/`
 * 块注释或 `--` 行注释。若不处理：
 *  - 文本含 `*\/` 会提前结束块注释，其后的内容成为可执行 SQL；
 *  - 文本含换行会终止 `--` 行注释，下一行同样成为可执行 SQL。
 * 这两种都让「制品看起来只是注释」变成注入面。这里统一移除控制字符/换行、
 * 并把 `*\/` 拆开，使内容无法逃出注释上下文。
 */
export function sqlCommentSafe(text: unknown): string {
  return String(text ?? '')
    // 控制字符（含 \r\n）会终止 `--` 行注释或改变行结构
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    // `*/` 会提前结束块注释
    .replace(/\*\//g, '* /');
}