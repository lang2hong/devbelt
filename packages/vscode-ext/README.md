# DB Client Pro

**All-in-one Database Client for VS Code** — MySQL, PostgreSQL and SQLite. Query, edit, import/export, design, sync — all in one extension.

## Features

- **Multi-database** — MySQL, PostgreSQL, SQLite (Redis, ElasticSearch planned)
- **Connection management** — hierarchical groups, connection form, test connection, SSH tunnel
- **SQL querying** — run in the current panel or a new one, query history, SQL formatting, result grid with inline cell editing, pagination
- **SQL intelligence** — context-aware autocomplete in the built-in query editor *and* `.sql` files (tables, columns, functions, keywords), snippets, EXPLAIN, run-statement
- **Table tools** — data preview, sort/filter, inline edit, insert/delete, mock data, duplicate, dump/export
- **Schema & design** — visual table designer, view DDL, ER diagram, schema compare
- **Data transfer** — CSV/JSON import & export with field mapping
- **Cloud sync** — account login, AES-256-GCM encrypted config sync across devices (credentials never leave the client)
- **Users & privileges** — create users, grant/revoke, change password
- **Internationalization** — 中文 / English, follows VS Code display language by default

## Requirements

- VS Code `^1.85.0`

## Quick Start

1. Open the **DB Client** activity bar.
2. Click **+** to add a connection (MySQL / PostgreSQL / SQLite).
3. For SQLite, you can use the bundled `sqlite3` CLI or point to your own binary.
4. Right-click a table → **View Data** to preview, or **New Query** to run SQL.

## Usage Tips

- **Ctrl+Enter** (macOS `Cmd+Enter`) — run query / active statement
- **Ctrl+Alt+Enter** (macOS `Cmd+Ctrl+Enter`) — run in a new panel
- **Ctrl+Shift+E** (macOS `Cmd+Shift+E`) — EXPLAIN
- Autocomplete in the query editor: tables, columns, functions, keywords — select with **Enter**, dismiss with **Esc**.
- Destructive statements (DELETE without WHERE / DDL) ask for confirmation; read-only connections are enforced.

## Commands

| Command | Description |
|---|---|
| Add Connection / Edit / Delete | Manage saved connections |
| Open / Close Connection | Explicitly open or release a connection |
| New Query / Run Query | Run SQL in current or new panel |
| View Data / View DDL / Design Table | Inspect and edit table schema |
| Import / Export | CSV, JSON transfer with mapping |
| Compare Schema / ER Diagram | Schema analysis |
| Sync Pull / Sync Push | Cloud sync of non-credential config |

## Cloud Sync

1. Run **DB Client: Login** (`dbclient.login`) and register.
2. Configure the sync server URL: `dbclient.sync.serverUrl` (default `http://localhost:3000`).
3. **Sync Push** encrypts your connection config (excluding passwords) with your master password and uploads; **Sync Pull** restores it.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `dbclient.sync.serverUrl` | `http://localhost:3000` | Cloud sync server URL |
| `dbclient.language` | `auto` | Extension language: `auto` / `zh` / `en` |

## License

MIT