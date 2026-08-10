# Changelog

All notable changes to this extension are documented in this file.

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