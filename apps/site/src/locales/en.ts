import type { Copy } from '../lib/copy';

export const en: Copy = {
  htmlLang: 'en',
  meta: {
    title: 'DevBelt — Database development inside VS Code',
    description:
      'DevBelt is a VS Code extension that brings MySQL, PostgreSQL, SQLite, Redis, Elasticsearch, an AI assistant, and data monitoring into one editor.',
  },
  nav: {
    features: 'Features',
    new: "What's new",
    install: 'Install',
    docs: 'Docs',
    plans: 'Pricing',
    github: 'GitHub',
    login: 'Sign in',
    register: 'Create account',
    console: 'Console',
    langSwitch: '中文',
  },
  hero: {
    eyebrowLabel: 'v0.4.0',
    eyebrowDesc: 'Data monitoring, AI proposals, multi-window takeover, per-account isolation',
    h1Html: 'Database work, without leaving <span class="accent">VS Code</span>.',
    lead:
      'DevBelt is an open-source VS Code extension: SQL editing and result grids, ER diagrams, Redis, Elasticsearch, an AI assistant, visual EXPLAIN, and end-to-end encrypted sync — all inside your editor.',
    primary: 'Install in VS Code',
    primaryConsole: 'Open console',
    secondary: 'Read the docs',
    login: 'Sign in',
    register: 'Create account',
    alt: 'DevBelt SQL editor and result grid',
    caption: 'SQL editing, context-aware completion, multi-result grids, and charts — all inside VS Code.',
  },
  features: {
    title: 'One extension for most of your database workflow',
    sub: 'From connections to AI diagnosis, Redis, Elasticsearch and scheduled monitoring — DevBelt brings them into one workspace.',
    items: [
      { icon: 'SQL', title: 'SQL workspace', desc: 'Connection groups, SSH tunnels, context-aware completion, formatting, cancel-on-demand, multi-result grids, CSV/JSON/XML/XLSX import & export, DB-to-DB transfer.' },
      { icon: 'ER', title: 'Schema & data', desc: 'ER diagrams, table designer, DDL generation, schema compare & sync, backup/restore, mock data generation, data dictionary export.' },
      { icon: '🔍', title: 'Query insight', desc: 'Visual EXPLAIN for MySQL/PG/SQLite, AI: Explain plan, index suggestions, slow-query analysis, in-editor SQL diagnostics.' },
      { icon: '▶▶', title: 'Redis', desc: 'Standalone / Cluster / Sentinel, SSH tunnels and TLS; collapsible key tree, SCAN paging, five native types, Stream consumer groups.' },
      { icon: 'ES', title: 'Elasticsearch', desc: 'HTTP/HTTPS, Basic/API Key auth, TLS and SSH tunnels; cluster/index/mapping browsers, DSL console, document CRUD.' },
      { icon: '✦', title: 'AI assistant', desc: 'Streaming chat with compressed history and schema context. Agent mode runs read-only SQL and EXPLAIN; writes are only proposed, never applied without your approval.' },
      { icon: '⏱', title: 'Data monitoring', desc: 'Scheduled read-only checks on row count, one numeric metric, or new rows, with VS Code notifications when your condition fires.' },
      { icon: '🔒', title: 'Sync & audit', desc: 'Connections, groups, queries and AI keys sync end-to-end encrypted across devices; per-account data isolation, audit log, backup scheduler, read-only mode.' },
    ],
  },
  showcase: {
    title: 'Designed for the editor workflow',
    sub: 'Not a webview bolted onto VS Code — UI, shortcuts and interactions are built for how you actually work in an editor.',
    items: [
      {
        title: 'ER diagrams you can actually read',
        paras: [
          'Reverse-engineer an ER diagram straight from the database; filter by schema, drag to arrange, export to PNG. The table designer is WYSIWYG and every change is summarized as a DDL preview before you apply it.',
          'PostgreSQL multi-schema writes, multi-database lazy sessions, schema-compare SQL, and data-dictionary export to Markdown / HTML.',
        ],
        bullets: [
          'Auto layout with manual adjustment',
          'Table designer / DDL preview / column, index & FK editing',
          'Schema compare and sync SQL',
          'Data dictionary export to Markdown / HTML',
        ],
        img: '/screenshots/02-er-diagram.png',
        alt: 'ER diagram',
      },
      {
        title: 'An AI assistant that looks at your schema — and never writes without asking',
        paras: [
          'Streaming AI chat brings relevant schema into context automatically. Older messages are summarized instead of being truncated, so long conversations keep their context.',
          'Agent mode is off by default. When enabled, the assistant can inspect schema, run read-only SQL and EXPLAIN plans. Any write (DML/DDL) requires an explicit approval in a native dialog.',
        ],
        bullets: [
          'Generate SQL, explain and optimize, diagnose errors in natural language',
          'Result charts: bar, line, area, pie, stacked, horizontal bar',
          'Agent mode is bounded by step / tool-call / time budgets',
          'BYOK or use the hosted proxy',
        ],
        img: '/screenshots/05-ai-chat.png',
        alt: 'AI Chat',
        reverse: true,
      },
      {
        title: 'Data monitoring: scheduled read-only checks that notify you',
        paras: [
          'Pick a table: watch row count, a single numeric metric, or new rows keyed on an existing integer / timestamp column. AI can propose a monitoring task as a card, but you pick the interval and condition — nothing runs until you confirm.',
          'When multiple VS Code windows are open, monitoring is held by a single instance via a file lock + heartbeat. You can explicitly take over; the previous window pauses its tasks cleanly.',
        ],
        bullets: [
          'Intervals from 5 seconds to 24 hours, or fully custom',
          'Three check types: row count / single metric / new rows (with cursor de-duplication)',
          'Background Tasks drawer: charts, history, next run, failure count',
          'Tasks pause on account switch to avoid cross-account leakage',
        ],
        img: '/screenshots/07-monitor-tasks.png',
        alt: 'Background monitoring tasks',
      },
      {
        title: 'EXPLAIN → chart: send the plan to AI',
        paras: [
          'Visual EXPLAIN for MySQL (FORMAT=JSON), PostgreSQL (FORMAT JSON) and SQLite (EXPLAIN QUERY PLAN): plan tree, node details, warnings (large full scans, filesort, temp tables, risky nested loops, missing indexes).',
          '"AI: Explain plan" sends a compact bounded summary to AI Chat. Index suggestions give you DDL to copy — nothing is executed automatically.',
        ],
        bullets: [
          'Plain EXPLAIN only; statements are planned, never executed',
          'High-risk nodes highlighted with reasons',
          'Index suggestions ordered by equality → range → sort, with confidence and risks',
          'One-click charting of result sets',
        ],
        img: '/screenshots/08-explain.png',
        alt: 'SQL EXPLAIN with AI interpretation',
        reverse: true,
      },
    ],
  },
  news: {
    badge: 'v0.4.0',
    title: "What's new in 0.4.0",
    colon: ': ',
    items: [
      { h: 'Data monitoring', t: 'Scheduled read-only checks (row count / metric / new rows) with VS Code notifications. AI can only propose a task card; you confirm the interval and condition.' },
      { h: 'Multi-window takeover', t: 'Monitoring uses a file lock + 15s heartbeat for single-instance ownership; explicit takeover pauses tasks in the previous window to avoid duplicate runs.' },
      { h: 'Per-account data isolation', t: 'Connections, AI keys, history, audit log and backups are scoped per account; signing out falls back to local; switching accounts closes sessions and offers a one-time local-data copy.' },
      { h: 'Smarter AI history', t: 'Last 8 messages are kept verbatim; older ones are rolled into a summary. Monitoring intents auto-enable Agent mode; tool-call errors fall back to plain chat.' },
      { h: 'Redis & ES polish', t: 'Configurable Redis key-tree page size (default 2000); Elasticsearch has a 45s watchdog and cancelable in-flight requests; IME Enter no longer sends/runs while composing.' },
    ],
    changelog: 'Full changelog →',
  },
  install: {
    title: 'Install',
    sub: 'DevBelt is a VS Code extension and works with VS Code, VSCodium, Cursor, Windsurf and other VS Code-compatible editors.',
    vsc: {
      tag: 'Recommended',
      tagRec: 'rec',
      title: 'VS Code Marketplace',
      desc: "Microsoft's official marketplace. Install directly from VS Code / Cursor by searching for DevBelt.",
      btn: 'Open Marketplace',
    },
    ovsx: {
      tag: 'Open source',
      title: 'Open VSX Registry',
      sub: '',
      desc: 'The Eclipse Foundation open marketplace. Default registry for VSCodium, Gitpod, Eclipse Theia and others.',
      btn: 'Open Open VSX',
    },
    vsix: { title: 'VSIX offline package', desc: 'Download the .vsix from GitHub Releases and install via the command line or "Install from VSIX…" in the Extensions panel.', size: 'v0.4.0 · 6.57 MB', btn: 'GitHub Releases' },
  },
  footer: {
    tagline:
      'DevBelt is an open-source VS Code extension for MySQL, PostgreSQL, SQLite, Redis, Elasticsearch, AI-assisted workflows and data monitoring.',
    productHead: 'Product',
    product: { features: 'Features', new: "What's new", plans: 'Sync pricing' },
    resourcesHead: 'Resources',
    resources: { docs: 'Documentation', changelog: 'Changelog', github: 'GitHub repository' },
    getHead: 'Get it',
    get: { vsc: 'VS Code Marketplace', ovsx: 'Open VSX' },
    ver: (v) => `${v} · Licensed MIT`,
    license: 'MIT',
    rights: '© DevBelt',
  },
};
