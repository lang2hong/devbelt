import type { ChatMessage } from '../chat.js';
import { dialectLine, joinSections, section, withSystem } from './render.js';

export interface Nl2SqlInput {
  /** 用户的自然语言请求。 */
  request: string;
  /** `serializeSchema` 输出。 */
  schemaText?: string;
  dbType?: string;
  /** 已选定的数据库 / schema（prompt 声明不得跨库/跨 schema 猜测）。 */
  database?: string;
  schema?: string;
  /** `referencedTables[]`：用户显式 @ 引用的表，prompt 声明优先使用。 */
  referencedTables?: string[];
  /** 连接级域上下文（业务术语映射）；仅 nl2sql/chat/data-qa 注入。 */
  domainContext?: string;
  /** 连接级默认业务指令（D21）；user-role 区块 + "列存在才适用"约束。 */
  defaultDirectives?: string;
}

const SCHEMA_LINKING =
  'Task: translate the user request into SQL for the connected database. ' +
  'First map the user\'s words to concrete tables and columns from the schema below (schema linking), then write the SQL. ' +
  'Use exactly one statement when possible.';

const ENUM_MAPPING =
  'When filtering on status/type/kind/state/code columns, strictly use values explicitly listed in column ENUM ' +
  'definitions or column comments. Do NOT guess enum values from world knowledge.';

/**
 * 业务术语 / 默认业务规则的 user 区块标题（NL2SQL 与 Chat/数据问答共用，避免措辞漂移）：
 * 术语“优先于模型先验”；规则“仅当涉及的表/列存在时适用，不得编造”。
 */
export const DOMAIN_CONTEXT_HEADER =
  'User-provided domain context (business terminology mapping; treat as authoritative over model priors):';
export const BUSINESS_RULES_HEADER =
  'User-provided business rules (apply ONLY when the tables/columns they mention exist in the provided schema; ' +
  'never invent columns or tables):';

const ALIAS_CONSISTENCY =
  'Table aliases: every alias prefix used on column references (e.g. t.col, f.id) must be declared as a table alias ' +
  'in FROM/JOIN. Never invent a prefix that is not bound there; with a single table, use unqualified column names.';

const NO_PLACEHOLDER_SQL =
  'If schema information is missing or incomplete, do NOT emit SQL containing placeholder identifiers ' +
  '(such as angle-bracket tokens); ask the user for the real table/column names in plain text instead.';

const RESERVED_IDENTIFIER_QUOTING =
  'Wrap table/column identifiers that collide with SQL reserved words in the dialect identifier quote ' +
  '(MySQL/SQLite: backticks, PostgreSQL: double quotes). Example: for a column named condition, write it ' +
  'backtick-quoted in MySQL. Never emit a reserved word as a bare identifier.';

/**
 * NL2SQL prompt 契约（P9 v5，§6.7.1）：
 * - schema-linking 显式映射指令；
 * - ENUM/字典严格映射（解决"谓词猜错 → 0 行"）；
 * - 输出契约：意图复述行 + ```sql 代码块 + Assumptions 区（≤3 条，无则 none）；
 * - 引用表优先 / 已选库 schema 绑定 / 域上下文与业务规则 user-role 区块。
 */
export function buildNl2SqlMessages(input: Nl2SqlInput): ChatMessage[] {
  const referenced = input.referencedTables?.length
    ? `The user explicitly referenced these tables: ${input.referencedTables.join(', ')}. Prefer them when applicable.`
    : undefined;
  const scope =
    input.database || input.schema
      ? `Connected scope: ${[
          input.database ? `database "${input.database}"` : undefined,
          input.schema ? `schema "${input.schema}"` : undefined,
        ]
          .filter(Boolean)
          .join(', ')}. Do not guess tables from other databases or schemas.`
      : undefined;
  const domainContext = section(DOMAIN_CONTEXT_HEADER, input.domainContext);
  const businessRules = section(BUSINESS_RULES_HEADER, input.defaultDirectives);

  return withSystem(
    joinSections([
      SCHEMA_LINKING,
      scope,
      referenced,
      section('Schema:', input.schemaText),
      dialectLine(input.dbType),
      domainContext,
      businessRules,
      section('Request:', input.request),
      ENUM_MAPPING,
      ALIAS_CONSISTENCY,
      NO_PLACEHOLDER_SQL,
      RESERVED_IDENTIFIER_QUOTING,
      'Output format (strict order):\n' +
        '1. A single line starting with "**意图理解：**" (intent paraphrase: restate the metric scope, filters and key assumptions in one plain-language sentence, same language as the user);\n' +
        '2. The SQL in a ```sql code block (keep the block clean; append `LIMIT 10` to SELECTs unless the user asks for all rows or a specific count);\n' +
        '3. An optional "Assumptions:" section with at most 3 bullet points (which ambiguous words you mapped, the basis, remaining uncertainty). If there are no assumptions, output "Assumptions: none".\n' +
        'If the schema is missing something needed, say so in the Assumptions section instead of guessing.',
    ]),
  );
}