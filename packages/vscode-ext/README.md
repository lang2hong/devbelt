# DB Client Pro

**All-in-one database client for MySQL, PostgreSQL and SQLite — right inside VS Code.**

Query, edit and design your databases without leaving the editor. Run SQL with autocomplete, edit data in a grid, design tables visually, draw ER diagrams, import/export, and tunnel through SSH.

## Highlights

- **Multi-database** — MySQL, PostgreSQL, SQLite (Redis, ElasticSearch planned)
- **Smart SQL editing** — context-aware autocomplete in the built-in editor *and* `.sql` files, snippets, formatting, EXPLAIN, run active statement
- **Data editing** — result grid with inline cell editing, pagination, sort/filter, insert/delete, mock data, duplicate
- **Schema & design** — visual table designer, DDL view, ER diagram, schema compare
- **Data transfer** — CSV/JSON import & export with field mapping
- **Connections** — hierarchical groups, connection form, connection test, SSH tunnel
- **Organization workspaces** — folder/query resource tree with connection templates mapped to local credentials; fixed admin/member model: admin can create/edit/delete, member read-only (Phase 1)
- **Cloud sync** — AES-256-GCM encrypted config sync across devices (§8 暂缓专项，Phase 1 未实现)
- **Users & privileges** — create users, grant/revoke, change password
- **Internationalization** — English / 中文, follows VS Code display language

## Requirements

- VS Code `1.85.0` or newer

## Installation

1. Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **DB Client Pro** and click **Install**.

You can also install from a `.vsix` file: run **Extensions: Install from VSIX…** and select the file.

## Quick Start

1. Open the **DB Client** view in the Activity Bar.
2. Click **+** to add a connection (MySQL / PostgreSQL / SQLite).
3. For SQLite you can use the bundled CLI or point to your own binary.
4. Right-click a table → **View Data** to preview, or **New Query** to run SQL.

## Keyboard Shortcuts

| Shortcut | macOS | Action |
|---|---|---|
| `Ctrl+Enter` | `Cmd+Enter` | Run query / active statement |
| `Ctrl+Alt+Enter` | `Cmd+Ctrl+Enter` | Run in a new panel |
| `Ctrl+Shift+E` | `Cmd+Shift+E` | Explain query |
| `Ctrl+Alt+F` | `Cmd+Alt+F` | Search database objects |
| `Ctrl+Alt+C` | `Cmd+Alt+C` | Search connections |

## Commands

| Command | Description |
|---|---|
| Add / Edit / Delete Connection | Manage saved connections |
| Open / Close Connection | Explicitly open or release a connection |
| New Query / Run Query | Run SQL in the current or a new panel |
| View Data / View DDL / Design Table | Inspect and edit table schemas |
| Import / Export | CSV/JSON transfer with field mapping |
| ER Diagram / Compare Schema | Schema analysis |

## Cloud Sync

> §8.1 个人 E2E 同步服务端已落地（S1–S5），扩展端 V3 同步客户端（B1–B3 原语）正在推进、尚未接入 UI。旧的 V2 分节同步入口已移除；同步命令与界面将在 B4 完成后再暴露。

## Settings

| Setting | Default | Description |
|---|---|---|
| `dbclient.language` | `auto` | Extension language: `auto` / `zh` / `en` |
| `dbclient.format.indent` | `2` | SQL formatting indent width (spaces) |
| `dbclient.format.keywordCase` | `upper` | SQL keyword case: `preserve` / `upper` / `lower` |

## Roadmap

- Redis and ElasticSearch support
- Team sharing and audit log
- Scheduled backups

## License

MIT