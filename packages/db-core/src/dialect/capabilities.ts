import type { DatabaseType } from '../types/connection';

/** Operations that must be explicitly implemented by a database dialect. */
export type DatabaseOperation =
  | 'createDatabase'
  | 'dropDatabase'
  | 'renameTable'
  | 'duplicateTable'
  | 'truncateTable'
  | 'getTableDefinition'
  | 'alterTable'
  | 'manageIndexes'
  | 'manageRoutines'
  | 'manageEvents'
  | 'manageUsers'
  | 'dumpTable'
  | 'schemaSync';

/**
 * A dialect's UI and service contract. New database support must declare every
 * capability instead of inheriting MySQL behaviour accidentally.
 */
export interface DatabaseCapabilities {
  /** The connection can enumerate and switch among databases in its explorer. */
  readonly multiDatabaseExplorer: boolean;
  readonly databases: boolean;
  readonly views: boolean;
  readonly routines: boolean;
  readonly events: boolean;
  readonly users: boolean;
  readonly operations: readonly DatabaseOperation[];
}

export function supportsOperation(
  capabilities: DatabaseCapabilities,
  operation: DatabaseOperation,
): boolean {
  return capabilities.operations.includes(operation);
}

export function unsupportedOperationMessage(dbType: DatabaseType, operation: DatabaseOperation): string {
  return `${dbType} does not support ${operation} in DB Client`;
}
