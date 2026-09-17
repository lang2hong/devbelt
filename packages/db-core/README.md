# @devkit/db-core

数据库驱动、SQL 方言、连接、查询和元数据核心，不依赖 VS Code 或服务端领域。

## 结构

```text
types       领域类型
dialect     数据库专属 SQL 和类型行为
connection  MySQL、PostgreSQL、SQLite 驱动适配
factory     连接与方言构造
query       查询、分页、元数据、编辑和导出
sync        与服务端共享的签名与 JCS 测试向量（有意例外，经 ./testing 导出公开向量）
utils       SQL 语句切分与标识符校验
```

> 例外说明：`sync` 向量非数据库核心职责，但需在 vscode-ext 与 server 测试两侧共用，故寄居本包并经 `./testing` 子路径导出（仅公开向量，无私钥）。它与 `./sql` 一样属显式公共面，不应被当作深链使用。

新增数据库类型时实现 `SqlDialect` 和连接适配器，再注册到 factory。驱动差异只留在适配器和方言中，调用方使用统一领域类型。

```bash
pnpm -C packages/db-core build
pnpm -C packages/db-core test
```
