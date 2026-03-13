import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalMode, SandboxMode, WorkspaceDefinition, WorkspaceRecord } from './bridge/types.js';

const ROOT_DIR = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

export interface AppConfig {
  telegramBotToken: string;
  allowedChatIds: Set<string>;
  pollTimeoutSeconds: number;
  databasePath: string;
  workspacesPath: string;
  defaultApprovalMode: ApprovalMode;
  codexBin?: string;
}

function loadDotEnv(): void {
  const envPath = path.resolve(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseSandbox(value: unknown): SandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  return 'workspace-write';
}

function parseApproval(value: string | undefined): ApprovalMode {
  if (value === 'untrusted' || value === 'on-request' || value === 'never') return value;
  return 'never';
}

function asWorkspaceRecord(def: WorkspaceDefinition): WorkspaceRecord {
  if (!def.name || !def.path) {
    throw new Error('Each workspace entry must define "name" and "path"');
  }

  const resolvedPath = path.resolve(def.path);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Workspace path does not exist: ${resolvedPath}`);
  }

  const extraDirs = (def.allowedAdditionalDirs || []).map(item => path.resolve(item));
  for (const extraDir of extraDirs) {
    if (!fs.existsSync(extraDir)) {
      throw new Error(`Workspace additional dir does not exist: ${extraDir}`);
    }
  }

  return {
    name: def.name,
    path: resolvedPath,
    defaultSandbox: parseSandbox(def.defaultSandbox),
    defaultModel: def.defaultModel?.trim() || null,
    allowedAdditionalDirs: extraDirs,
    enabled: def.enabled !== false,
    highRisk: def.highRisk === true,
  };
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const allowedChatIds = new Set(parseList(process.env.TELEGRAM_ALLOWED_CHAT_IDS));
  if (allowedChatIds.size === 0) {
    throw new Error('TELEGRAM_ALLOWED_CHAT_IDS must contain at least one chat id');
  }

  const databasePath = path.resolve(ROOT_DIR, process.env.DATABASE_PATH || 'data/bridge.db');
  const workspacesPath = path.resolve(ROOT_DIR, process.env.WORKSPACES_CONFIG_PATH || 'config/workspaces.json');

  return {
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedChatIds,
    pollTimeoutSeconds: Number.parseInt(process.env.POLL_TIMEOUT_SECONDS || '30', 10) || 30,
    databasePath,
    workspacesPath,
    defaultApprovalMode: parseApproval(process.env.CODEX_APPROVAL),
    codexBin: process.env.CODEX_BIN?.trim() || undefined,
  };
}

export function loadWorkspaceRegistry(configPath: string): WorkspaceRecord[] {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Workspace config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as WorkspaceDefinition[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Workspace config must be a non-empty JSON array');
  }

  const seen = new Set<string>();
  return parsed.map(entry => {
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate workspace name: ${entry.name}`);
    }
    seen.add(entry.name);
    return asWorkspaceRecord(entry);
  });
}
