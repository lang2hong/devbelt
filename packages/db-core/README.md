# @db-client/core

纯数据库连接/查询/元数据核心层，**无 vscode 依赖**，可独立测试与复用。

## 分层架构

```
types      领域模型（ConnectionConfig / FieldInfo / QueryResult）
  ↓
dialect    方言行为（策略模式 + 注册表）
  ↓
connection 连接适配（适配器模式：mysql2 / pg / sqlite3）
  ↓
factory    连接工厂（工厂模式）
  ↓
query      查询 / 分页 / 元数据 / 数据编辑
```

## 设计模式

| 模式 | 落点 |
|------|------|
| 工厂 | `ConnectionFactory.createWithDialect()` |
| 策略 | `SqlDialect` 隔离方言差异 |
| 适配器 | `MysqlConnection` 等适配底层驱动 |
| 模板方法 | `IConnection.convertToDump()` |
| 注册表 | `DialectRegistry` 按类型取方言 |

## 使用

```ts
import { ConnectionFactory, QueryService } from '@db-client/core';

const { connection, dialect } = ConnectionFactory.createWithDialect(
  DatabaseType.MYSQL,
  { host, port, user, password, database },
);
await new Promise((res, rej) => connection.connect((e) => (e ? rej(e) : res())));

const query = new QueryService(connection, dialect);
const result = await query.query('SELECT * FROM users');
```

## 测试

```bash
pnpm test
```

## 扩展新数据库

实现 1 个 `SqlDialect` + 1 个 `Connection`，在工厂与注册表各加一行即可，零侵入现有代码。