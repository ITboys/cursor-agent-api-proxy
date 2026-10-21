/**
 * Account Manager — loads, saves, and resolves multi-account configurations.
 *
 * Accounts are stored in ~/.cursor-agent-api/accounts.json.
 * Backward-compatible: if no accounts file exists, falls back to CURSOR_API_KEY
 * env var or `agent login` global auth (original behaviour).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AccountConfig, AccountSummary, AccountsFile } from "../types/account.js";

const STATE_DIR = join(homedir(), ".cursor-agent-api");
const ACCOUNTS_FILE = join(STATE_DIR, "accounts.json");

export class AccountsManager {
  private accounts: Record<string, AccountConfig> = {};
  private defaultId: string | null = null;

  /** Load accounts from disk. Returns self for chaining. */
  load(): this {
    if (!existsSync(ACCOUNTS_FILE)) {
      this.accounts = {};
      this.defaultId = null;
      return this;
    }

    try {
      const raw = readFileSync(ACCOUNTS_FILE, "utf-8");
      const data: AccountsFile = JSON.parse(raw);
      this.accounts = data.accounts || {};

      // Resolve default
      if (data.default && this.accounts[data.default]) {
        this.defaultId = data.default;
      } else {
        // Find the one marked default=true, or use first entry
        const marked = Object.entries(this.accounts).find(
          ([, c]) => c.default === true
        );
        this.defaultId = marked ? marked[0] : (Object.keys(this.accounts)[0] ?? null);
      }
    } catch (err) {
      console.error(`[Accounts] Failed to load ${ACCOUNTS_FILE}:`, err);
      this.accounts = {};
      this.defaultId = null;
    }

    return this;
  }

  /** Persist current accounts to disk. */
  save(): void {
    mkdirSync(STATE_DIR, { recursive: true });

    const data: AccountsFile = {
      accounts: this.accounts,
      default: this.defaultId ?? undefined,
    };

    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  }

  /** Get account config by id. Returns null if not found. */
  get(id: string): AccountConfig | null {
    return this.accounts[id] ?? null;
  }

  /** Get the default account config. Returns null if none configured. */
  getDefault(): AccountConfig | null {
    if (this.defaultId) return this.accounts[this.defaultId] ?? null;
    const first = Object.values(this.accounts)[0];
    return first ?? null;
  }

  /** Get default account id. */
  getDefaultId(): string | null {
    return this.defaultId;
  }

  /** Resolve account by id. Falls back to default. */
  resolve(id?: string): { id: string; config: AccountConfig } | null {
    if (id && this.accounts[id]) {
      return { id, config: this.accounts[id] };
    }
    if (this.defaultId && this.accounts[this.defaultId]) {
      return { id: this.defaultId, config: this.accounts[this.defaultId] };
    }
    return null;
  }

  /**
   * List all accounts as summaries (safe for API responses).
   * @param activeId When set (e.g. CURSOR_INSTANCE_ACCOUNT), marks that id as default in the list.
   */
  list(activeId?: string | null): AccountSummary[] {
    const effectiveDefault = activeId ?? this.defaultId;
    return Object.entries(this.accounts).map(([id, config]) => ({
      id,
      name: config.name,
      default: effectiveDefault ? id === effectiveDefault : false,
      hasApiKey: !!config.api_key,
      modelCount: config.models ? config.models.length : null,
    }));
  }

  /** Add or update an account. */
  set(id: string, config: AccountConfig): void {
    this.accounts[id] = config;
    if (config.default || !this.defaultId) {
      this.defaultId = id;
    }
    this.save();
  }

  /** Remove an account. */
  remove(id: string): boolean {
    if (!this.accounts[id]) return false;
    delete this.accounts[id];
    if (this.defaultId === id) {
      this.defaultId = Object.keys(this.accounts)[0] ?? null;
    }
    this.save();
    return true;
  }

  /** Whether any accounts are configured. */
  hasAccounts(): boolean {
    return Object.keys(this.accounts).length > 0;
  }

  /** Get the api_key for a given account id. */
  resolveApiKey(id?: string): string | undefined {
    const resolved = this.resolve(id);
    return resolved?.config.api_key;
  }
}

/** Singleton instance, lazily loaded. */
let _instance: AccountsManager | null = null;

export function getAccountsManager(): AccountsManager {
  if (!_instance) {
    _instance = new AccountsManager().load();
  }
  return _instance;
}

export function resetAccountsManager(): void {
  _instance = null;
}
