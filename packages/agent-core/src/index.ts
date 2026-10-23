export type {
  AgentEngine,
  AgentSettings,
  AgentSurface,
  ConnectionFacts,
  RiskClass,
  TargetBinding,
  ToolDefinition,
} from './types.js';
export { READ_CLASSES, WRITE_CLASSES } from './types.js';

export {
  ToolRegistryError,
  defineToolRegistry,
  evaluatePolicy,
  mcpTools,
} from './policy.js';
export type { PolicyDecision, PolicyDenyReason, PolicyInput } from './policy.js';

export {
  ProposalError,
  approveProposal,
  authorizeExecution,
  completeProposal,
  computeSqlHash,
  createProposal,
  isExpired,
  rejectProposal,
  revokeProposal,
  toProposalView,
} from './proposal.js';
export type {
  AuthorizeDenyReason,
  AuthorizeRequest,
  AuthorizeResult,
  CreateProposalInput,
  CreateProposalOptions,
  DryRunOutcome,
  Proposal,
  ProposalErrorCode,
  ProposalStatus,
  ProposalView,
  WriteRiskClass,
} from './proposal.js';

export {
  LedgerError,
  TERMINAL_STATES,
  canTransition,
  reduceLedger,
  validateLedgerEvent,
} from './ledger.js';
export type {
  ExecutionLedger,
  LedgerErrorCode,
  LedgerEvent,
  LedgerEventInput,
  LedgerState,
  ProposalLedgerState,
} from './ledger.js';

export { JsonlExecutionLedger } from './jsonlLedger.js';
export type { JsonlLedgerOptions, LoadReport } from './jsonlLedger.js';

export {
  DEFAULT_METADATA_BUDGET,
  DEFAULT_QUERY_BUDGET,
  DEFAULT_TEXT_LIMIT,
  redactSecrets,
  sanitizeMetadata,
  sanitizePlanSummary,
  sanitizeQueryResult,
  sanitizeToolError,
} from './sanitizer.js';
export type {
  MetadataBudget,
  MetadataColumnInput,
  MetadataColumnView,
  MetadataTableInput,
  MetadataTableView,
  QueryBudget,
  QueryColumnSummary,
  QueryResultView,
  SanitizeQueryOptions,
  ToolResultEnvelope,
} from './sanitizer.js';

export { RESERVED_ARGUMENTS, guardToolCall, validateArguments } from './guard.js';
export type { GuardDenyReason, GuardResult, ToolCallRequest } from './guard.js';

export { checkReadOnlySql, scanOptionsForEngine } from './readOnlySql.js';
export type { ReadOnlySqlCheck, ReadOnlySqlRejectReason } from './readOnlySql.js';

export { explainReadOnly, runReadOnlyQuery } from './readOnlyRuntime.js';
export type {
  ReadOnlyQuerySession,
  ReadOnlyRunResult,
  ReadOnlySessionTarget,
  RunReadOnlyOptions,
  RuntimeRejectReason,
} from './readOnlyRuntime.js';
