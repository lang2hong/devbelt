# DevBelt

**数据库工作，回到一个窗口。**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lang2hong.devbelt-db-client?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client)
[![Open VSX](https://img.shields.io/open-vsx/v/lang2hong/devbelt-db-client?label=Open%20VSX)](https://open-vsx.org/extension/lang2hong/devbelt-db-client)
[![License](https://img.shields.io/badge/license-MIT-3ad29a)](LICENSE)

DevBelt 是一款开源 VS Code 扩展：连接、查询、设计、诊断和监控八种数据库，都在你每天使用的编辑器里。少开几个工具，多留一点专注。

![DevBelt SQL 工作台](https://devbelt.l2hi.com/screenshots/01-sql-workbench.png)

**安装**：[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client) · [Open VSX](https://open-vsx.org/extension/lang2hong/devbelt-db-client) · [下载 VSIX](https://github.com/lang2hong/devbelt/releases/latest)

[English](https://github.com/lang2hong/devbelt/blob/main/README.en.md) · [文档](https://devbelt.l2hi.com/db/docs) · [更新日志](https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md)

## 为什么是 DevBelt

- **一个窗口，八种数据库。** MySQL、MariaDB、PostgreSQL、SQL Server、SQLite、Redis、Elasticsearch 和 MongoDB 共用连接、页签与安全设置。
- **按编辑器的方式工作。** 当前语句执行、选中执行、取消长查询、多结果表格、补全和快捷键，都是 VS Code 原生体验。
- **AI 有边界。** 能看结构、能查数据；读操作有上限，改数据、改结构不会自动提交，必须由你批准。
- **数据留在你这边。** 密码和 Key 进入系统密钥库；同步只有你能读；生产保护、只读模式和脱敏导出默认可用。

## 一个窗口，八种数据库

| 类型 | 数据库 | 你可以做什么 |
|---|---|---|
| 关系型 | MySQL · MariaDB · PostgreSQL · SQL Server · SQLite | 查询、结果表格、表设计、关系图、执行计划、导入导出 |
| 缓存与搜索 | Redis · Elasticsearch | 浏览键和文档、直接编辑、命令行与查询控制台 |
| 文档型 | MongoDB | 集合与索引、分页、聚合、实时变更、GridFS |

一个账号、一套快捷键、一份操作记录。

## 查询、结构与洞察

![关系图](https://devbelt.l2hi.com/screenshots/02-er-diagram.png)

- **查询与结果**：连接分组、SSH 隧道、格式化、执行与取消、多结果表格、筛选排序、分页和受控编辑。
- **导入导出**：CSV、JSON、XML、XLSX、SQL；支持库到库传输和可选脱敏导出。
- **结构与设计**：关系图、表设计器、结构对比、SQL 预览和数据字典。关系图属于 Pro。
- **洞察与诊断**：可视化执行计划、风险提示、索引建议、慢查询分析和风险语句提示。
- **备份与数据**：定时备份、恢复和模拟数据生成。

## DevBelt AI：帮你看数据，但不会替你拍板

![DevBelt AI 与图表](https://devbelt.l2hi.com/screenshots/05-ai-chat.png)

- **自然语言查询**：生成、解释、优化和诊断；自动带上相关表结构。
- **Agent 模式**（默认关闭）：逐步查看结构、执行只读查询和查看执行计划，受步数、行数和时间上限约束。
- **不会自动提交修改**：可回滚的改数据操作会先在事务里试执行并回滚（有触发器的表跳过），改结构只做检查；只有你在原生确认框里批准后才会真正执行。
- **只读结果自动执行**：SQL、Redis 读命令、Elasticsearch 搜索，以及带集合名的 MongoDB 只读查询，遵循同一个开关。
- **结果图表**：柱状、折线、面积、饼、堆叠和横向条形图。
- **自带模型 Key**：也可以使用服务端代理；Key 保存在系统密钥库。
- **MCP（Pro）**：把只读查询能力提供给 Claude、Cursor 等外部 AI 客户端。

## 监控与提醒

- **三种检查**：表行数、关键指标或新数据。
- **AI 只提案**：监控任务以卡片形式提出，间隔和提醒条件由你确认。
- **指定开始日期**：时间列可以从某一天开始统计。
- **后台任务**：图表、检查历史、下次检查时间、失败次数；间隔与条件可编辑。
- **单实例执行**：多窗口打开时只有一个执行者，可显式接管；切换账号自动暂停。

## 免费与 Pro

**Free**：八种数据库本地使用、查询与结果表格、基础 DevBelt AI 额度，适合个人本地开发。

**Pro**：跨设备加密同步、关系图与结构设计、连接配置导出、MCP 只读查询，以及更高的设备、连接和 AI 额度。

本地使用不需要注册。具体额度以[套餐页](https://devbelt.l2hi.com/plans)为准。

## Redis、Elasticsearch、MongoDB

- **Redis**：单机 / Cluster / Sentinel、SSH 与 TLS、键树折叠、分页浏览、五种常用类型、Stream 消费组和命令行。
- **Elasticsearch**：HTTP/HTTPS、Basic / API Key、TLS / SSH、集群与索引浏览、mapping / settings / aliases、查询与 REST 控制台。
- **MongoDB**：`mongodb://` 与 Atlas、集合与索引、`_id` 分页、只读聚合、EJSON / JSONL、Change Streams、批量事务和 GridFS。

AI 与 Agent 对这三种数据库只做只读操作；值和文档内容默认不发送给模型。

## 隐私与掌控

- 连接密码、模型 Key、验证码密钥保存在操作系统安全存储。
- 可选跨设备同步连接、查询和注记，服务端只保存密文。
- 生产保护、只读模式、写操作记录和危险命令确认。
- 敏感字段默认打码；MCP 只提供只读查询，生产连接默认拒绝。

## 安装

| 渠道 | 适合 |
|---|---|
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client) | VS Code、Cursor 等 |
| [Open VSX](https://open-vsx.org/extension/lang2hong/devbelt-db-client) | VSCodium、Gitpod、Eclipse Theia |
| [GitHub Releases](https://github.com/lang2hong/devbelt/releases/latest) | 离线 VSIX |

```bash
code --install-extension lang2hong.devbelt-db-client
```

安装后重新加载窗口，新建连接并测试；然后打开查询编辑器，或直接在 DevBelt AI 里提问。

## 了解更多

- [产品文档](https://devbelt.l2hi.com/db/docs)
- [更新日志](CHANGELOG.md)
- [GitHub Issues](https://github.com/lang2hong/devbelt/issues)
- [套餐与 Pro](https://devbelt.l2hi.com/plans)

MIT License · © DevBelt