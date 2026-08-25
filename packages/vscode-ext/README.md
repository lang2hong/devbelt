# DB Client Pro

**All-in-one database client for MySQL, PostgreSQL and SQLite — right inside VS Code.**

Query, edit and design your databases without leaving the editor. Run SQL with autocomplete, edit data in a grid, design tables visually, draw ER diagrams, import/export, tunnel through SSH, and keep your connections in sync across devices.

## Highlights

- **Multi-database** — MySQL, PostgreSQL, SQLite (Redis, ElasticSearch planned)
- **Smart SQL editing** — context-aware autocomplete in the built-in editor *and* `.sql` files, snippets, formatting, EXPLAIN, run active statement
- **Data editing** — result grid with inline cell editing, pagination, sort/filter, insert/delete, mock data, duplicate
- **Schema & design** — visual table designer, DDL view, ER diagram, schema compare
- **Data transfer** — CSV/JSON import & export with field mapping
- **Connections** — hierarchical groups, connection form, connection test, SSH tunnel
- **Cloud sync** — AES-256-GCM encrypted config sync across devices; your credentials never leave the client
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
| Sync Pull / Sync Push | Encrypted cloud sync of non-credential config |

## Cloud Sync

1. Run **DB Client: Login** and register an account.
2. **Sync Push** encrypts your connection config (excluding passwords) with your master password and uploads it.
3. **Sync Pull** restores it on any device — the master password is never uploaded.

## Settings

| Setting | Default | Description |
|---|---|---|
| `dbclient.sync.auto` | `off` | Cloud sync mode: `reminder` notifies on change, `silent` syncs in the background |
| `dbclient.sync.intervalMin` | `0` | Auto-sync interval in minutes (`0` disables the periodic timer) |
| `dbclient.sync.rememberMaster` | `true` | Remember the master password in OS secure storage for silent sync |
| `dbclient.language` | `auto` | Extension language: `auto` / `zh` / `en` |
| `dbclient.format.indent` | `2` | SQL formatting indent width (spaces) |
| `dbclient.format.keywordCase` | `upper` | SQL keyword case: `preserve` / `upper` / `lower` |

## Roadmap

- Redis and ElasticSearch support
- Team sharing and audit log
- Scheduled backups

## License

MIT