import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Store, AuditEventRecordInput } from './interfaces.js';
import type {
  ApprovalRequestRecord,
  ApprovalStatus,
  ChatBindingRecord,
  SandboxMode,
  TaskRunRecord,
  TaskStatus,
  WorkspaceRecord,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function intToBool(value: number): boolean {
  return value === 1;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  bootstrap(workspaces: WorkspaceRecord[]): void {
    const insert = this.db.prepare(`
      INSERT INTO workspaces (
        name, path, default_sandbox, default_model, allowed_additional_dirs, enabled, high_risk
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        path = excluded.path,
        default_sandbox = excluded.default_sandbox,
        default_model = excluded.default_model,
        allowed_additional_dirs = excluded.allowed_additional_dirs,
        enabled = excluded.enabled,
        high_risk = excluded.high_risk
    `);

    for (const workspace of workspaces) {
      insert.run(
        workspace.name,
        workspace.path,
        workspace.defaultSandbox,
        workspace.defaultModel,
        JSON.stringify(workspace.allowedAdditionalDirs),
        boolToInt(workspace.enabled),
        boolToInt(workspace.highRisk),
      );
    }
  }

  markRunningTasksInterrupted(reason: string): void {
    const interruptedAt = nowIso();
    this.db.prepare(`
      UPDATE task_runs
      SET status = 'interrupted',
          error_text = ?,
          finished_at = COALESCE(finished_at, ?)
      WHERE status = 'running'
    `).run(reason, interruptedAt);
  }

  listEnabledWorkspaces(): WorkspaceRecord[] {
    const rows = this.db.prepare(`
      SELECT name, path, default_sandbox, default_model, allowed_additional_dirs, enabled, high_risk
      FROM workspaces
      WHERE enabled = 1
      ORDER BY name ASC
    `).all() as unknown as WorkspaceRow[];
    return rows.map(row => this.mapWorkspace(row));
  }

  getWorkspace(name: string): WorkspaceRecord | null {
    const row = this.db.prepare(`
      SELECT name, path, default_sandbox, default_model, allowed_additional_dirs, enabled, high_risk
      FROM workspaces
      WHERE name = ?
    `).get(name) as WorkspaceRow | undefined;
    return row ? this.mapWorkspace(row) : null;
  }

  getChatBinding(chatId: string, channelType: 'telegram'): ChatBindingRecord | null {
    const row = this.db.prepare(`
      SELECT chat_id, channel_type, workspace_name, current_thread_id, last_task_id, created_at, updated_at
      FROM chat_bindings
      WHERE chat_id = ? AND channel_type = ?
    `).get(chatId, channelType) as ChatBindingRow | undefined;
    return row ? this.mapBinding(row) : null;
  }

  ensureChatBinding(chatId: string, channelType: 'telegram', defaultWorkspaceName: string): ChatBindingRecord {
    const existing = this.getChatBinding(chatId, channelType);
    if (existing) return existing;

    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO chat_bindings (
        chat_id, channel_type, workspace_name, current_thread_id, last_task_id, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?)
    `).run(chatId, channelType, defaultWorkspaceName, timestamp, timestamp);
    return this.getChatBinding(chatId, channelType)!;
  }

  updateChatWorkspace(chatId: string, channelType: 'telegram', workspaceName: string): ChatBindingRecord {
    this.db.prepare(`
      UPDATE chat_bindings
      SET workspace_name = ?, updated_at = ?
      WHERE chat_id = ? AND channel_type = ?
    `).run(workspaceName, nowIso(), chatId, channelType);
    return this.getChatBinding(chatId, channelType)!;
  }

  updateChatCurrentTask(chatId: string, channelType: 'telegram', taskId: string | null): void {
    this.db.prepare(`
      UPDATE chat_bindings
      SET last_task_id = ?, updated_at = ?
      WHERE chat_id = ? AND channel_type = ?
    `).run(taskId, nowIso(), chatId, channelType);
  }

  updateChatCurrentThread(chatId: string, channelType: 'telegram', threadId: string | null): void {
    this.db.prepare(`
      UPDATE chat_bindings
      SET current_thread_id = ?, updated_at = ?
      WHERE chat_id = ? AND channel_type = ?
    `).run(threadId, nowIso(), chatId, channelType);
  }

  createTaskRun(input: Omit<TaskRunRecord, 'startedAt' | 'finishedAt'> & { startedAt?: string; finishedAt?: string | null }): TaskRunRecord {
    const startedAt = input.startedAt || nowIso();
    const finishedAt = input.finishedAt ?? null;
    this.db.prepare(`
      INSERT INTO task_runs (
        id, chat_id, workspace_name, thread_id, prompt, status, risk_flags, approval_status,
        sandbox, model, started_at, finished_at, final_message, error_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.chatId,
      input.workspaceName,
      input.threadId,
      input.prompt,
      input.status,
      JSON.stringify(input.riskFlags),
      input.approvalStatus,
      input.sandbox,
      input.model,
      startedAt,
      finishedAt,
      input.finalMessage,
      input.errorText,
    );
    return this.getTaskRun(input.id)!;
  }

  getTaskRun(id: string): TaskRunRecord | null {
    const row = this.db.prepare(`
      SELECT id, chat_id, workspace_name, thread_id, prompt, status, risk_flags, approval_status,
             sandbox, model, started_at, finished_at, final_message, error_text
      FROM task_runs
      WHERE id = ?
    `).get(id) as TaskRunRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  updateTaskRun(id: string, updates: Partial<Omit<TaskRunRecord, 'id' | 'chatId' | 'workspaceName' | 'prompt'>>): TaskRunRecord {
    const current = this.getTaskRun(id);
    if (!current) {
      throw new Error(`Task run not found: ${id}`);
    }

    const next: TaskRunRecord = {
      ...current,
      ...updates,
      riskFlags: updates.riskFlags ?? current.riskFlags,
      finishedAt: updates.finishedAt === undefined ? current.finishedAt : updates.finishedAt,
      finalMessage: updates.finalMessage === undefined ? current.finalMessage : updates.finalMessage,
      errorText: updates.errorText === undefined ? current.errorText : updates.errorText,
    };

    this.db.prepare(`
      UPDATE task_runs
      SET thread_id = ?, status = ?, risk_flags = ?, approval_status = ?, sandbox = ?, model = ?,
          started_at = ?, finished_at = ?, final_message = ?, error_text = ?
      WHERE id = ?
    `).run(
      next.threadId,
      next.status,
      JSON.stringify(next.riskFlags),
      next.approvalStatus,
      next.sandbox,
      next.model,
      next.startedAt,
      next.finishedAt,
      next.finalMessage,
      next.errorText,
      id,
    );
    return this.getTaskRun(id)!;
  }

  listTaskRunsByChat(chatId: string, limit: number): TaskRunRecord[] {
    const rows = this.db.prepare(`
      SELECT id, chat_id, workspace_name, thread_id, prompt, status, risk_flags, approval_status,
             sandbox, model, started_at, finished_at, final_message, error_text
      FROM task_runs
      WHERE chat_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(chatId, limit) as unknown as TaskRunRow[];
    return rows.map(row => this.mapTask(row));
  }

  getLatestTaskRunByChat(chatId: string): TaskRunRecord | null {
    const row = this.db.prepare(`
      SELECT id, chat_id, workspace_name, thread_id, prompt, status, risk_flags, approval_status,
             sandbox, model, started_at, finished_at, final_message, error_text
      FROM task_runs
      WHERE chat_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(chatId) as TaskRunRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  createApprovalRequest(input: Omit<ApprovalRequestRecord, 'createdAt' | 'resolvedAt'> & { createdAt?: string; resolvedAt?: string | null }): ApprovalRequestRecord {
    const createdAt = input.createdAt || nowIso();
    this.db.prepare(`
      INSERT INTO approval_requests (
        id, task_run_id, chat_id, risk_summary, status, created_at, resolved_at, resolved_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.taskRunId,
      input.chatId,
      input.riskSummary,
      input.status,
      createdAt,
      input.resolvedAt ?? null,
      input.resolvedBy,
    );
    return this.getApprovalRequest(input.id)!;
  }

  getApprovalRequest(id: string): ApprovalRequestRecord | null {
    const row = this.db.prepare(`
      SELECT id, task_run_id, chat_id, risk_summary, status, created_at, resolved_at, resolved_by
      FROM approval_requests
      WHERE id = ?
    `).get(id) as ApprovalRequestRow | undefined;
    return row ? this.mapApproval(row) : null;
  }

  updateApprovalRequest(id: string, updates: Partial<Omit<ApprovalRequestRecord, 'id' | 'taskRunId' | 'chatId' | 'createdAt'>>): ApprovalRequestRecord {
    const current = this.getApprovalRequest(id);
    if (!current) throw new Error(`Approval request not found: ${id}`);

    const next: ApprovalRequestRecord = {
      ...current,
      ...updates,
      resolvedAt: updates.resolvedAt === undefined ? current.resolvedAt : updates.resolvedAt,
      resolvedBy: updates.resolvedBy === undefined ? current.resolvedBy : updates.resolvedBy,
    };

    this.db.prepare(`
      UPDATE approval_requests
      SET risk_summary = ?, status = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ?
    `).run(next.riskSummary, next.status, next.resolvedAt, next.resolvedBy, id);

    return this.getApprovalRequest(id)!;
  }

  insertAuditEvent(input: AuditEventRecordInput): void {
    this.db.prepare(`
      INSERT INTO audit_events (
        id, chat_id, task_run_id, direction, kind, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      input.chatId,
      input.taskRunId ?? null,
      input.direction,
      input.kind,
      input.payload,
      nowIso(),
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        default_sandbox TEXT NOT NULL,
        default_model TEXT,
        allowed_additional_dirs TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        high_risk INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_bindings (
        chat_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        current_thread_id TEXT,
        last_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, channel_type)
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        thread_id TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_flags TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        sandbox TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        final_message TEXT,
        error_text TEXT
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        risk_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        task_run_id TEXT,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
    return {
      name: row.name,
      path: row.path,
      defaultSandbox: row.default_sandbox as SandboxMode,
      defaultModel: row.default_model,
      allowedAdditionalDirs: parseJsonArray(row.allowed_additional_dirs),
      enabled: intToBool(row.enabled),
      highRisk: intToBool(row.high_risk),
    };
  }

  private mapBinding(row: ChatBindingRow): ChatBindingRecord {
    return {
      chatId: row.chat_id,
      channelType: row.channel_type as 'telegram',
      workspaceName: row.workspace_name,
      currentThreadId: row.current_thread_id,
      lastTaskId: row.last_task_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapTask(row: TaskRunRow): TaskRunRecord {
    return {
      id: row.id,
      chatId: row.chat_id,
      workspaceName: row.workspace_name,
      threadId: row.thread_id,
      prompt: row.prompt,
      status: row.status as TaskStatus,
      riskFlags: parseJsonArray(row.risk_flags),
      approvalStatus: row.approval_status as ApprovalStatus,
      sandbox: row.sandbox as SandboxMode,
      model: row.model,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      finalMessage: row.final_message,
      errorText: row.error_text,
    };
  }

  private mapApproval(row: ApprovalRequestRow): ApprovalRequestRecord {
    return {
      id: row.id,
      taskRunId: row.task_run_id,
      chatId: row.chat_id,
      riskSummary: row.risk_summary,
      status: row.status as 'pending' | 'approved' | 'denied',
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
    };
  }
}

interface WorkspaceRow {
  name: string;
  path: string;
  default_sandbox: string;
  default_model: string | null;
  allowed_additional_dirs: string;
  enabled: number;
  high_risk: number;
}

interface ChatBindingRow {
  chat_id: string;
  channel_type: string;
  workspace_name: string;
  current_thread_id: string | null;
  last_task_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRunRow {
  id: string;
  chat_id: string;
  workspace_name: string;
  thread_id: string | null;
  prompt: string;
  status: string;
  risk_flags: string;
  approval_status: string;
  sandbox: string;
  model: string | null;
  started_at: string;
  finished_at: string | null;
  final_message: string | null;
  error_text: string | null;
}

interface ApprovalRequestRow {
  id: string;
  task_run_id: string;
  chat_id: string;
  risk_summary: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
