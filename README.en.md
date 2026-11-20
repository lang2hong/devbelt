# DevBelt

**Database work, back in one window.**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lang2hong.devbelt-db-client?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client)
[![Open VSX](https://img.shields.io/open-vsx/v/lang2hong/devbelt-db-client?label=Open%20VSX)](https://open-vsx.org/extension/lang2hong/devbelt-db-client)
[![License](https://img.shields.io/badge/license-MIT-3ad29a)](LICENSE)

DevBelt is an open-source VS Code extension for connecting, querying, designing, diagnosing and monitoring seven databases inside the editor you already use. Fewer tools, more focus.

![DevBelt SQL workspace](https://devbelt.l2hi.com/screenshots/01-sql-workbench.png)

**Install**: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client) · [Open VSX](https://open-vsx.org/extension/lang2hong/devbelt-db-client) · [Download VSIX](https://github.com/lang2hong/devbelt/releases/latest)

[中文](https://github.com/lang2hong/devbelt/blob/main/README.md) · [Docs (中文)](https://devbelt.l2hi.com/db/docs) · [Changelog](https://github.com/lang2hong/devbelt/blob/main/CHANGELOG.md)

## Why DevBelt

- **One window, seven databases.** MySQL, PostgreSQL, SQL Server, SQLite, Redis, Elasticsearch and MongoDB share connections, tabs and security settings.
- **Built for the editor.** Run the current statement or selection, cancel long queries, use multi-result grids, completion and native shortcuts.
- **AI with boundaries.** It reads schemas and queries data. Reads are bounded, and data or schema changes are never committed without your approval.
- **Your data stays yours.** Passwords and keys live in the system keychain, sync is readable only by you, and production guards, read-only mode and masked export are built in.

## One window, seven databases

| Type | Databases | What you can do |
|---|---|---|
| Relational | MySQL · PostgreSQL · SQL Server · SQLite | Queries, result grids, table designer, relationship diagrams, execution plans, import/export |
| Cache & search | Redis · Elasticsearch | Browse keys and documents, edit values, use the CLI and query consoles |
| Document | MongoDB | Collections, indexes, paging, aggregation, change streams, GridFS |

One account, one set of shortcuts, one activity record.

## Query, schema and insight

![Relationship diagram](https://devbelt.l2hi.com/screenshots/02-er-diagram.png)

- **Query & results**: connection groups, SSH tunnels, formatting, execution and cancellation, multi-result grids, filtering, sorting, paging and controlled editing.
- **Import/export**: CSV, JSON, XML, XLSX and SQL; database-to-database transfer and optional masked export.
- **Schema & design**: relationship diagrams, table designer, schema comparison, SQL preview and data dictionary. Diagrams are Pro.
- **Insight & diagnosis**: visual execution plans, risk hints, index suggestions, slow-query analysis and risky statement warnings.
- **Backup & data**: scheduled backups, restore and mock data generation.

## AI helps you read the data. It does not make the call for you.

![AI assistant with charts](https://devbelt.l2hi.com/screenshots/05-ai-chat.png)

- **Natural-language queries**: generate, explain, optimize and diagnose with the relevant schema in context.
- **AI assistant** (off by default): inspect schema, run read-only queries and view execution plans, bounded by steps, rows and time.
- **No automatic commits**: reversible data changes first run in a rollback-only trial (tables with triggers are skipped), schema changes are checked, and nothing runs until you approve it in a native dialog.
- **Read-only auto-run**: SQL, Redis reads, Elasticsearch searches, and MongoDB read-only queries with a collection follow one switch.
- **Result charts**: bar, line, area, pie, stacked and horizontal bar.
- **Bring your own model key**: or use the hosted proxy. Keys stay in the system keychain.
- **MCP (Pro)**: expose read-only queries to Claude, Cursor and other external assistants.

## Monitor and alert

- **Three check types**: table row count, a key metric or new data.
- **AI proposes, you confirm**: monitoring tasks arrive as cards; you choose the interval and alert condition.
- **Optional start date**: time columns can start counting from a chosen day.
- **Background tasks**: charts, check history, next check, failure count; edit interval and condition.
- **Single owner**: when multiple VS Code windows are open, one window owns execution; handover is explicit, and switching accounts pauses tasks.

## Free and Pro

**Free**: all seven databases locally, queries and result grids, and the basic AI assistant allowance — for personal local work.

**Pro**: encrypted cross-device sync, relationship diagrams and schema design, connection profile export, MCP read-only queries, and higher device, connection and AI limits.

Local use does not require an account. See the [plans page](https://devbelt.l2hi.com/plans) for exact limits.

## Redis, Elasticsearch, MongoDB

- **Redis**: standalone / Cluster / Sentinel, SSH and TLS, key tree, paging, five common types, Stream consumer groups and a CLI.
- **Elasticsearch**: HTTP/HTTPS, Basic / API key, TLS / SSH, cluster and index browsing, mapping / settings / aliases, query and REST consoles.
- **MongoDB**: `mongodb://` and Atlas, collections and indexes, `_id` paging, read-only aggregation, EJSON / JSONL, Change Streams, batch transactions and GridFS.

AI and Agent use read-only operations for all three; values and document contents are not sent to the model by default.

## Privacy and control

- Connection passwords, model keys and authenticator secrets live in OS secure storage.
- Optional cross-device sync of connections, queries and notes; the server stores ciphertext only.
- Production protection, read-only mode, write activity records and dangerous-command confirmation.
- Sensitive fields are redacted by default; MCP exposes read-only queries only and denies production connections by default.

## Install

| Channel | Best for |
|---|---|
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client) | VS Code, Cursor and compatible editors |
| [Open VSX](https://open-vsx.org/extension/lang2hong/devbelt-db-client) | VSCodium, Gitpod, Eclipse Theia |
| [GitHub Releases](https://github.com/lang2hong/devbelt/releases/latest) | Offline VSIX |

```bash
code --install-extension lang2hong.devbelt-db-client
```

Reload the window, create and test a connection, then open a query editor or ask in the AI assistant.

## Learn more

- [Product docs (中文)](https://devbelt.l2hi.com/db/docs)
- [Changelog](CHANGELOG.md)
- [GitHub Issues](https://github.com/lang2hong/devbelt/issues)
- [Plans and Pro](https://devbelt.l2hi.com/plans)

MIT License · © DevBelt