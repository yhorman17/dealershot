export interface CleanupOptions {
  execute: boolean;
  projectRef: string;
  confirmation: string;
  backupDir: string;
  manifestPath: string;
  validateTransaction: boolean;
  help: boolean;
}

export interface AuditedRecord {
  readonly id: string;
  readonly name: string;
}

export const TARGET_PROJECT_REF: string;
export const TARGET_PROJECT_NAME: string;
export const EXECUTION_CONFIRMATION: string;
export const OWNER_PROFILE_ID: string;
export const RETAINED_STORE_ID: string;
export const RETAINED_STORE_NAME: string;
export const ACCEPTANCE_ORGANIZATIONS: readonly AuditedRecord[];
export const ACCEPTANCE_PROFILES: readonly AuditedRecord[];

export function parseArgs(argv: string[]): CleanupOptions;
