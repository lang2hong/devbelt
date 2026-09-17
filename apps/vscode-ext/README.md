# DevBelt

运行在 VS Code 内的 MySQL、PostgreSQL 和 SQLite 客户端。

## 功能

- 连接分组、连接测试和 SSH 隧道。
- SQL 编辑、补全、格式化、执行和 EXPLAIN。
- 结果编辑、导入导出、表设计、DDL、ER 图和 Schema 对比。
- 组织 Workspace、共享查询和连接模板。

个人连接同步：底层密码学、协议与运行时/UI 均已实现（`devbelt.syncNow` 等命令已注册），待双设备安装版验证；本地连接不走权益门禁。

## SSH 主机密钥校验

SSH 隧道按 `devbelt.ssh.hostKeyPolicy` 校验服务端主机密钥：

- `tofu`（默认）：未知主机弹出 **SHA256 指纹**确认，接受后写入插件自管 `known_hosts`，之后静默信任；
- `strict`：只信任 `known_hosts` 中已有主机，未知主机直接拒绝。

**密钥变更或 `@revoked` 一律硬失败**（不会 TOFU 覆盖）。也可先把主机加入系统 `known_hosts`：

```bash
ssh-keyscan db.example.com >> ~/.ssh/known_hosts
# 非标准端口：
ssh-keyscan -p 2222 db.example.com >> ~/.ssh/known_hosts
```

可用环境变量 `SSH_KNOWN_HOSTS` 指定其它 `known_hosts` 文件。

## 个人同步本地重置

远端不可达或本机状态陈旧时，命令面板执行 **Reset Local Sync**：仅清本机加密同步数据与密钥（连接配置保留），不联系服务器；之后重新初始化或解锁即可。

## 要求

- VS Code 1.85.0 或更高版本。

## 快捷键

| 快捷键 | macOS | 操作 |
|---|---|---|
| `Ctrl+Enter` | `Cmd+Enter` | 运行查询或当前语句 |
| `Ctrl+Alt+Enter` | `Cmd+Ctrl+Enter` | 在新面板运行 |
| `Ctrl+Shift+E` | `Cmd+Shift+E` | EXPLAIN |
| `Ctrl+Alt+F` | `Cmd+Alt+F` | 搜索数据库对象 |
| `Ctrl+Alt+C` | `Cmd+Alt+C` | 搜索连接 |

项目架构和开发状态见[文档中心](../../docs/README.md)。

## 许可

MIT
