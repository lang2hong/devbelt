/**
 * 分块解析器接口。
 *
 * 常驻 sqlite3 进程下，输出不再以「进程 finish」为界，改由哨兵按查询切分窗口后，
 * 直接对窗口调用 `push` 再 `done()`。这里只保留接口定义。
 */
export interface ChunksParser<T> {
  push: (chunk: string) => void;
  done: () => T;
}