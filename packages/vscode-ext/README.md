# vscode-ext

VS Code 数据库客户端扩展。对 `@db-client/core` 单向依赖。

## 功能

- 连接树（层级分组、添加/重命名/删除分组、移动连接）
- 连接表单（webview，测试连接 / 保存）
- SQL 查询（运行、结果表格、查询历史、格式化、单元格编辑）
- 云同步（登录/注册、加密拉取/推送）
- 国际化（中英，跟随 VSCode 或手动覆盖）

## 开发调试

用 VS Code 打开仓库根目录，按 F5 启动 Extension Development Host（esbuild 自动 watch）。

## 构建

```bash
pnpm build      # esbuild 打包（db-core/驱动打入单 bundle）
pnpm package    # 生成 .vsix
```

## 打包策略

esbuild 把 `@db-client/core`、`mysql2`、`pg` 等全部打进 `out/extension.js`，
运行时仅 external `vscode`。发布时 `dependencies` 为空，用户只需安装单个 .vsix。

## 设置

| 键 | 说明 |
|----|------|
| `dbclient.sync.serverUrl` | 同步服务地址 |
| `dbclient.language` | auto / zh / en