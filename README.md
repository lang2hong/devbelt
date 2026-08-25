# DB Client Pro

**All-in-one database client for MySQL, PostgreSQL and SQLite — right inside VS Code.**

Query, edit and design your databases without leaving the editor. Run SQL with autocomplete, edit data in a grid, design tables visually, draw ER diagrams, import/export, tunnel through SSH, and keep your connections in sync across devices.

![License](https://img.shields.io/badge/license-MIT-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.85.0-blue)

## Highlights

- **Multi-database** — MySQL, PostgreSQL, SQLite (Redis, ElasticSearch planned)
- **Smart SQL editing** — context-aware autocomplete in the built-in editor *and* `.sql` files, snippets, formatting, EXPLAIN, run active statement
- **Data editing** — result grid with inline cell editing, pagination, sort/filter, insert/delete, mock data, duplicate
- **Schema & design** — visual table designer, DDL view, ER diagram, schema compare
- **Data transfer** — CSV/JSON/Excel/XML import & export with field mapping
- **Connections** — hierarchical groups, connection form, connection test, SSH tunnel
- **Cloud sync** — AES-256-GCM encrypted config sync across devices; your credentials never leave the client
- **Users & privileges** — create users, grant/revoke, change password
- **Internationalization** — English / 中文, follows VS Code display language

## Installation

1. Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **DB Client Pro** and click **Install**.

You can also install from a `.vsix` file: run **Extensions: Install from VSIX…** and select the file.

## Documentation

- **Quick start**: open the **DB Client** view in the Activity Bar → **+** to add a connection → right-click a table to **View Data** or **New Query**.
- **Run SQL**: `Ctrl+Enter` runs the query / active statement; `Ctrl+Alt+Enter` opens a new panel.
- **Cloud sync**: log in with **DB Client: Login**, then **Sync Push** / **Sync Pull**.
- Full changelog: [CHANGELOG.md](./CHANGELOG.md)

## Issues & Feedback

Found a bug or have a feature idea? Please open an issue:

- [Report a bug](https://github.com/lang2hong/vscode-db-client/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/lang2hong/vscode-db-client/issues/new?template=feature_request.md)
- [Browse all issues](https://github.com/lang2hong/vscode-db-client/issues)

## License

[MIT](./LICENSE)