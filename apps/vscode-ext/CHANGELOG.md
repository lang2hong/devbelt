# Changelog

All notable changes to this extension are documented in this file.

## [Unreleased]

### Added

- **Redis client (P7)**: full Redis support alongside MySQL/PostgreSQL/SQLite — connect (standalone / Cluster / Sentinel, including over SSH with NAT-map tunnels), key browser and per-type editors, CLI console (history, completion, dangerous-command confirmation), server info/slowlog, read-only mode, audit logging, and per-connection `requestTimeout` for command timeouts. Binary-safe key/member handling and byte-level `\xHH` CLI arguments.
- **PostgreSQL multi-schema (P7.1)**: browse and operate across all schemas (schema tree layer, schema-qualified write/DDL/export/data-edit, cross-schema foreign-key navigation, schema-aware backup/restore). Temporary host-side write protection for non-default schemas is lifted now that qualification is in place.
- **PostgreSQL multi-database**: enumerate visible databases (CONNECT-filtered), lazily create derived per-database sessions (cap 4 + LRU), reuse a single SSH tunnel with reference counting, and "execute in that database".
- **Authenticator (2FA/TOTP)**: local dynamic codes in a webview panel (does not occupy the activity bar). Paste `otpauth://` links or add a single entry from a QR image; groups, colored tags, search/edit/delete, copy-to-clipboard, and plaintext export (modal warning, `0600`). Secrets are stored only in the OS keychain (VS Code `SecretStorage`) and never sent to the webview — only `code + secondsLeft` are pushed each tick.

### Changed

- Organization (team collaboration) feature fully removed across extension, console, and server.
- Strict base32 / `otpauth` input validation (reject Unicode-confusable characters and invalid `digits`/`period`).
- Audit log panel now shows the PostgreSQL schema alongside connection/database, and restore / SQL-script import are audited.
- Idle health-check no longer closes a session with an open transaction; `BEGIN` failure resets transaction tracking so the session can be evicted.

### Fixed

- SSH tunnel acquisition now registers in-flight requests before any await and uses a lease token on release (no duplicate tunnels / no closing a rebuilt tunnel).
- Redis Cluster node-level retry/offline-queue options are set on the top-level `Cluster` options (previously placed in `redisOptions`, where ioredis ignores them); command timeouts also cover `nodes().call` and destructive-command timeouts report "result unknown".
- Scoped PostgreSQL backup reads the target schema's tables (previously could silently read a same-named `public` table).

### Notes

- Personal connection sync (P2) and multi-device authenticator sync (P6) remain **in development** and are not part of this release.
- Known limitations for the Redis/PG work are listed in `docs/阶段/P7-Redis客户端.md` §十一 (including 15s default command timeout, 30s cluster node backoff, and schema-scoped dumps retaining source-schema references in function/trigger/view definitions).

## [0.2.0] - 2026-08-12

### Added

- **Result chart visualization**: Bar, line, pie, and scatter charts from query results (Chart.js integration).
- **Data-level sync**: Compare and sync row data between two databases with the new `DataDiffService` and `DataDiffView`.
- **Excel (.xlsx) import/export**: Full support for Excel files in addition to CSV/JSON.
- **XML import/export**: Parse and serialize XML data files.
- **Database backup**: Full database dump with `BackupService`, including scheduled backups.
- **Connection pool management**: LRU eviction, idle timeout, and health check for connection sessions.
- **Wizard component**: Reusable step-by-step wizard UI for guided workflows.
- **CI/CD pipeline**: GitHub Actions workflow for build, typecheck, and test on push/PR.

### Improved

- **Menu filtering by database type**: Menu items now hide automatically for unsupported databases (e.g., no events/routines for SQLite).
- **Completion engine optimization**: Contexts that don't need metadata (e.g., `where_operator`) skip DB queries.
- **Diagnostic logging**: New `diagnostics.ts` output channel captures silent errors for debugging.

## [0.1.0] - 2026-08-10

### Added

- Multi-database support: MySQL, PostgreSQL, SQLite.
- Connection management: hierarchical groups, connection form, SSH tunnel.
- SQL querying with result grid, inline cell editing, pagination, query history.
- Context-aware SQL autocomplete (tables, columns, functions, keywords) in the query editor and `.sql` files.
- Table tools: sort/filter, mock data, duplicate, dump/export, DDL viewer, designer, ER diagram, schema compare.
- Result grid: inline cell edit, insert new row, delete rows, copy current dataset as INSERT statements.
- CSV/JSON import & export with field mapping.
- Cloud sync: account login, AES-256-GCM encrypted config sync (credentials remain client-side).
- Internationalization (中文 / English).

### Engineering

- Unified SQL completion engine (`sqlCompletionEngine.ts`) shared by the webview query editor and the `.sql` `CompletionProvider`.
- WHERE-clause completion: `where_operator` (compare operators after a field) and `where_value` (values/functions after an operator); `after_table` no longer mixes statement keywords.
- Shared single-source constants: SQL operators (`utils/sqlOperators.ts`) and filter operators (`utils/filterOps.ts`) reused by completion + filter SQL builder + webview grid.
- Unified identifier wrapping / string escaping in `utils/sql.ts` (core `wrapIdent(dbType,…)` + `wrapIdentForConn`, `escapeSqlString`).
- Dialect comparisons use the `DatabaseType` enum instead of `'MYSQL'`/`'PG'` string literals.
- Connection sessions auto-release when the last query/preview panel closes (explicitly opened connections are preserved).
- Query serialization per view to prevent session-state races; multi-slot query cancellation.
- Parameterized, atomic row deletion / insertion (`DELETE … IN`, `INSERT`) via `DataService`.
- Table preview profile now persists only column layout — sort/filter reset on each open (no residual query/filter).
- SQLite child-process cleanup on connection close.
- MySQL `multipleStatements` disabled by default.
- Server password hashing upgraded to scrypt with per-user random salt (legacy hashes still verified).