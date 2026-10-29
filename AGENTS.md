# DevBelt 项目规则

本文件补充全局规则（`~/.config/opencode/AGENTS.md`）中的项目细节。
全局规则优先；这里只记录 devbelt 特有的远端、发布路径与数据边界。

## 远端

| 名称 | 地址 | 用途 |
|---|---|---|
| `origin` | gitee `lang2hong/devbelt` | 主开发分支 |
| `cigit` | `github.com:wfxhy/devbelt` | **付费 CI**，推送即触发流水线 |
| `github` | `lang2hong/devbelt` | 公开门面仓库（README / 截图 / issue 模板） |

## 发布与部署（均需用户明确指令，见全局规则 §7）

- **VS Code Marketplace**：`pnpm -C apps/vscode-ext package` → `vsce publish`
  - publisher：`lang2hong`，扩展 ID：`lang2hong.devbelt-db-client`
- **Open VSX**：`ovsx publish <vsix>`（新扩展名首次发布需 Eclipse 基金会人工审核）
- **官网与后端**：`apps/server/deploy.sh`
  - ssh Host 别名：`crewai`
  - 部署目录：`/usr/local/l2h/devbelt/{server,db-ui,auth-ui,admin-ui,site}`
  - systemd 服务：`devbelt-server`
  - 对外域名：`devbelt.l2hi.com`
- **版本标签**：`git tag vX.Y.Z`

## 数据安全

- 生产的 `db_client` 库**禁止任何写入**（读也要谨慎）
- 集成测试与验证只使用 `db_client_verify`
- 不得打印连接密码、API Key、token、`.env` 内容

## 代码约定

- 工作区包：`apps/{vscode-ext,server,site,db-ui,auth-ui,admin-ui,e2e}`、`packages/{db-core,db-host,ai-core,agent-core,explain-core,masking-core}`
- 公开页面外壳：`apps/server/src/publicChrome.ts`（文档中心与套餐页共用，与 `apps/site` 的 Vue 组件保持一致）
- 账号数据隔离统一走 `apps/vscode-ext/src/sync/accountScope.ts` 的 `scopedMemento` / `readScoped` / `writeScoped`，新建存储必须使用它

## 已知限制

- MCP 连接配置与 AI 的 `LAST_CONN_KEY` 仍是全局的
- 跨窗口账号切换（另一窗口切号）不会自动同步到本窗口：本窗口会停止个人同步并提示重新加载窗口，面板、连接树等仍按旧账号加载，重新加载前不要操作
- Open VSX 上 `lang2hong.devbelt-db-client` 仍在首次审核