# vscode-db-client

VSCode 数据库客户端扩展，对标 Navicat / database-client.com。

## 功能

### 树视图（参考 Navicat 层级）
- 连接 → 数据库 → 表/视图/函数/事件/查询/用户 6 分类
- 表可展开显示列（PK 用 🔑 图标，显示行数和类型）
- 连接关闭：无箭头 → 双击重连
- 全部使用 VSCode 内置 ThemeIcon（无需 SVG 资源）

### 数据查询（Vue3 webview）
- SQL 编辑器 + 结果网格
- 排序（点击表头 ASC/DESC/取消）
- 过滤（列下拉 + 输入 → WHERE LIKE）
- 内联编辑（双击单元格 → UPDATE）
- 行删除（checkbox → DELETE FROM）
- 导出 CSV / SQL INSERT / JSON
- 多条 SQL 分号拆分执行
- 分页（Prev / Next，每页 100 行）

### 表设计（Vue3 webview）
- Columns Tab：列名/类型/可空/主键/默认值/Extra
- Indexes Tab：索引名/列/唯一/主键
- DDL Tab：SHOW CREATE TABLE 原文

### SQL 编辑器集成
- 自动补全（表名/列名/关键字，FROM/JOIN 后补表名，`table.` 后补列名）
- Code Lens（每段 SQL 上方显示 ▶ Run 按钮）
- SQL 格式化
- Run SQL File（右键 .sql 文件 → 选连接执行）
- 查询历史

### 表操作
- 新建/删除/重命名/清空/复制表
- 查看 DDL（SHOW CREATE TABLE）
- 结构导出 dump（DDL + INSERT 语句）
- Mock 数据生成（按列名/类型智能生成：email/name/phone/address/IP/date 等）

### 视图/函数/事件
- 视图：查看数据 / 删除
- 函数：查看定义（SHOW CREATE FUNCTION/PROCEDURE）/ 删除
- 事件：查看定义（SHOW CREATE EVENT）/ 删除

### 数据库操作
- 新建数据库 / 删除数据库
- 结构差异同步（比对两个 DB → 生成 ALTER/CREATE/DROP SQL）

### 用户管理
- 创建用户（CREATE USER）
- 删除用户（DROP USER）
- 修改密码（ALTER USER）
- 授权 / 撤销（GRANT / REVOKE）

### Server 状态面板（Vue3 webview）
- Process List（MySQL: SHOW PROCESSLIST / PG: pg_stat_activity）
- Status Variables（MySQL: SHOW GLOBAL STATUS）
- Server Variables（MySQL: SHOW VARIABLES / PG: pg_settings）
- 内置搜索过滤

### ER 图（Vue3 webview）
- SVG 渲染表关系图
- 外键连线（虚线 + 端点圆圈）
- PK 列用黄色 🔑 标识
- 网格布局

### SSH 隧道
- 支持 SSH 密码认证和私钥认证
- 本地端口转发（local:random → ssh → remote DB）
- 连接表单可折叠 SSH 配置区

### Terminal 集成
- 右键连接 → 打开数据库 CLI（mysql / psql / sqlite3）
- 密码通过环境变量传递（MYSQL_PWD / PGPASSWORD），不在命令行暴露

### 云同步
- 登录 / 注册 / 登出
- 推送本地连接配置到云端（AES-256-GCM 加密）
- 从云端拉取并合并

### 其他
- i18n：中文 / 英文双语，跟随 VSCode 显示语言
- 架构：Vue3 + Vite（webview UI）+ esbuild（扩展主体）双管线构建
- db-core：方言策略模式（MySQL / PostgreSQL / SQLite），17 个单元测试

## 支持的数据库
- MySQL（含 SSH 隧道）
- PostgreSQL
- SQLite

## 构建
```bash
# 安装依赖
pnpm install

# 构建 db-core
cd packages/db-core && pnpm build

# 构建扩展（esbuild + Vite 双管线）
cd packages/vscode-ext && pnpm build

# 打包 .vsix
cd packages/vscode-ext && npx @vscode/vsce package --no-yarn
```

## 调试
```bash
# F5 启动调试
cd packages/vscode-ext && pnpm dev   # esbuild watch
# 另一个终端：
cd packages/vscode-ext/webview && npx vite build --watch  # Vite watch
```
