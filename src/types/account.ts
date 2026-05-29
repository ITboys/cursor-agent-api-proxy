/**
 * Account configuration types for multi-account support.
 */

export interface AccountConfig {
  /** Human-readable label (e.g. "personal", "work") */
  name: string;
  /** Cursor API Key. Omit to use `agent login` global auth. */
  api_key?: string;
  /** Mark as default account (first one or explicitly set) */
  default?: boolean;
  /** Optional model allowlist — restrict which models this account can use */
  models?: string[];
}

export interface AccountSummary {
  id: string;
  name: string;
  default: boolean;
  hasApiKey: boolean;
  modelCount: number | null;
}

export interface AccountsFile {
  accounts: Record<string, AccountConfig>;
  /** Which account is the default (key into `accounts`). Falls back to first entry. */
  default?: string;
}
