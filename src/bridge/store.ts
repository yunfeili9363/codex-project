import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Store, AuditEventRecordInput } from './interfaces.js';
import type {
  ApprovalRequestRecord,
  ApprovalStatus,
  ChatBindingRecord,
  CaptureSourceType,
  ContentItemRecord,
  InputKind,
  ScheduledJobRecord,
  SandboxMode,
  ScenarioType,
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

  isChatAuthorized(chatId: string): boolean {
    const row = this.db.prepare(`
      SELECT chat_id
      FROM authorized_chats
      WHERE chat_id = ?
    `).get(chatId) as { chat_id?: string } | undefined;
    return Boolean(row?.chat_id);
  }

  authorizeChat(chatId: string, addedByUserId: string | null, source: string | null = 'admin_auto_authorize'): void {
    this.db.prepare(`
      INSERT INTO authorized_chats (
        chat_id, added_by_user_id, source, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO NOTHING
    `).run(chatId, addedByUserId, source, nowIso());
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
      SELECT chat_id, target_chat_id, topic_id, channel_type, scenario, scenario_config_json, vault_root, workspace_name, current_thread_id, last_task_id, created_at, updated_at
      FROM chat_bindings
      WHERE chat_id = ? AND channel_type = ?
    `).get(chatId, channelType) as ChatBindingRow | undefined;
    return row ? this.mapBinding(row) : null;
  }

  ensureChatBinding(
    chatId: string,
    channelType: 'telegram',
    defaultWorkspaceName: string,
    targetChatId: string,
    topicId: number | null = null,
  ): ChatBindingRecord {
    const existing = this.getChatBinding(chatId, channelType);
    if (existing) return existing;

    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO chat_bindings (
        chat_id, target_chat_id, topic_id, channel_type, scenario, scenario_config_json, vault_root, workspace_name, current_thread_id, last_task_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'generic', NULL, NULL, ?, NULL, NULL, ?, ?)
    `).run(chatId, targetChatId, topicId, channelType, defaultWorkspaceName, timestamp, timestamp);
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

  updateChatScenario(
    chatId: string,
    channelType: 'telegram',
    scenario: ScenarioType,
    scenarioConfigJson: string | null = null,
    vaultRoot: string | null = null,
  ): ChatBindingRecord {
    this.db.prepare(`
      UPDATE chat_bindings
      SET scenario = ?, scenario_config_json = ?, vault_root = ?, updated_at = ?
      WHERE chat_id = ? AND channel_type = ?
    `).run(scenario, scenarioConfigJson, vaultRoot, nowIso(), chatId, channelType);
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
        id, chat_id, target_chat_id, topic_id, scenario, workspace_name, thread_id, input_kind, source_url, output_path, prompt, status, risk_flags, approval_status,
        sandbox, model, started_at, finished_at, final_message, error_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.chatId,
      input.targetChatId,
      input.topicId,
      input.scenario,
      input.workspaceName,
      input.threadId,
      input.inputKind,
      input.sourceUrl,
      input.outputPath,
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
      SELECT id, chat_id, target_chat_id, topic_id, scenario, workspace_name, thread_id, input_kind, source_url, output_path, prompt, status, risk_flags, approval_status,
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
      SET target_chat_id = ?, topic_id = ?, scenario = ?, thread_id = ?, input_kind = ?, source_url = ?, output_path = ?, status = ?, risk_flags = ?, approval_status = ?, sandbox = ?, model = ?,
          started_at = ?, finished_at = ?, final_message = ?, error_text = ?
      WHERE id = ?
    `).run(
      next.targetChatId,
      next.topicId,
      next.scenario,
      next.threadId,
      next.inputKind,
      next.sourceUrl,
      next.outputPath,
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
      SELECT id, chat_id, target_chat_id, topic_id, scenario, workspace_name, thread_id, input_kind, source_url, output_path, prompt, status, risk_flags, approval_status,
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
      SELECT id, chat_id, target_chat_id, topic_id, scenario, workspace_name, thread_id, input_kind, source_url, output_path, prompt, status, risk_flags, approval_status,
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

  createContentItem(input: Omit<ContentItemRecord, 'createdAt'> & { createdAt?: string }): ContentItemRecord {
    const createdAt = input.createdAt || nowIso();
    this.db.prepare(`
      INSERT INTO content_items (
        id, task_run_id, scenario, title, source_type, source_url, summary, tags_json, file_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.taskRunId,
      input.scenario,
      input.title,
      input.sourceType,
      input.sourceUrl,
      input.summary,
      JSON.stringify(input.tags),
      input.filePath,
      createdAt,
    );
    return this.getContentItem(input.id)!;
  }

  listContentItemsByChat(chatId: string, limit: number): ContentItemRecord[] {
    const rows = this.db.prepare(`
      SELECT ci.id, ci.task_run_id, ci.scenario, ci.title, ci.source_type, ci.source_url, ci.summary, ci.tags_json, ci.file_path, ci.created_at
      FROM content_items ci
      JOIN task_runs tr ON tr.id = ci.task_run_id
      WHERE tr.chat_id = ?
      ORDER BY ci.created_at DESC
      LIMIT ?
    `).all(chatId, limit) as unknown as ContentItemRow[];
    return rows.map(row => this.mapContentItem(row));
  }

  upsertScheduledJob(input: Omit<ScheduledJobRecord, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): ScheduledJobRecord {
    const current = this.getScheduledJob(input.chatId, input.scenario, input.jobType);
    const createdAt = current?.createdAt || input.createdAt || nowIso();
    const updatedAt = input.updatedAt || nowIso();

    this.db.prepare(`
      INSERT INTO scheduled_jobs (
        id, chat_id, target_chat_id, topic_id, channel_type, scenario, job_type, schedule_time, enabled, last_run_at, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, scenario, job_type) DO UPDATE SET
        target_chat_id = excluded.target_chat_id,
        topic_id = excluded.topic_id,
        channel_type = excluded.channel_type,
        schedule_time = excluded.schedule_time,
        enabled = excluded.enabled,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `).run(
      current?.id || input.id,
      input.chatId,
      input.targetChatId,
      input.topicId,
      input.channelType,
      input.scenario,
      input.jobType,
      input.scheduleTime,
      boolToInt(input.enabled),
      input.lastRunAt,
      input.nextRunAt,
      createdAt,
      updatedAt,
    );

    return this.getScheduledJob(input.chatId, input.scenario, input.jobType)!;
  }

  getScheduledJob(chatId: string, scenario: ScheduledJobRecord['scenario'], jobType: ScheduledJobRecord['jobType']): ScheduledJobRecord | null {
    const row = this.db.prepare(`
      SELECT id, chat_id, target_chat_id, topic_id, channel_type, scenario, job_type, schedule_time, enabled, last_run_at, next_run_at, created_at, updated_at
      FROM scheduled_jobs
      WHERE chat_id = ? AND scenario = ? AND job_type = ?
    `).get(chatId, scenario, jobType) as ScheduledJobRow | undefined;
    return row ? this.mapScheduledJob(row) : null;
  }

  listScheduledJobsByChat(chatId: string): ScheduledJobRecord[] {
    const rows = this.db.prepare(`
      SELECT id, chat_id, target_chat_id, topic_id, channel_type, scenario, job_type, schedule_time, enabled, last_run_at, next_run_at, created_at, updated_at
      FROM scheduled_jobs
      WHERE chat_id = ?
      ORDER BY created_at ASC
    `).all(chatId) as unknown as ScheduledJobRow[];
    return rows.map(row => this.mapScheduledJob(row));
  }

  listDueScheduledJobs(nowIso: string): ScheduledJobRecord[] {
    const rows = this.db.prepare(`
      SELECT id, chat_id, target_chat_id, topic_id, channel_type, scenario, job_type, schedule_time, enabled, last_run_at, next_run_at, created_at, updated_at
      FROM scheduled_jobs
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(nowIso) as unknown as ScheduledJobRow[];
    return rows.map(row => this.mapScheduledJob(row));
  }

  markScheduledJobRun(id: string, runAt: string, nextRunAt: string): ScheduledJobRecord {
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET last_run_at = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(runAt, nextRunAt, nowIso(), id);

    const row = this.db.prepare(`
      SELECT id, chat_id, target_chat_id, topic_id, channel_type, scenario, job_type, schedule_time, enabled, last_run_at, next_run_at, created_at, updated_at
      FROM scheduled_jobs
      WHERE id = ?
    `).get(id) as ScheduledJobRow | undefined;
    if (!row) throw new Error(`Scheduled job not found: ${id}`);
    return this.mapScheduledJob(row);
  }

  disableScheduledJob(chatId: string, scenario: ScheduledJobRecord['scenario'], jobType: ScheduledJobRecord['jobType']): ScheduledJobRecord | null {
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET enabled = 0, updated_at = ?
      WHERE chat_id = ? AND scenario = ? AND job_type = ?
    `).run(nowIso(), chatId, scenario, jobType);
    return this.getScheduledJob(chatId, scenario, jobType);
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
        target_chat_id TEXT,
        topic_id INTEGER,
        channel_type TEXT NOT NULL,
        scenario TEXT NOT NULL DEFAULT 'generic',
        scenario_config_json TEXT,
        vault_root TEXT,
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
        target_chat_id TEXT,
        topic_id INTEGER,
        scenario TEXT NOT NULL DEFAULT 'generic',
        workspace_name TEXT NOT NULL,
        thread_id TEXT,
        input_kind TEXT NOT NULL DEFAULT 'text',
        source_url TEXT,
        output_path TEXT,
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

      CREATE TABLE IF NOT EXISTS content_items (
        id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL,
        scenario TEXT NOT NULL,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authorized_chats (
        chat_id TEXT PRIMARY KEY,
        added_by_user_id TEXT,
        source TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        target_chat_id TEXT NOT NULL,
        topic_id INTEGER,
        channel_type TEXT NOT NULL,
        scenario TEXT NOT NULL,
        job_type TEXT NOT NULL,
        schedule_time TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, scenario, job_type)
      );
    `);

    this.ensureColumn('chat_bindings', 'scenario', `TEXT NOT NULL DEFAULT 'generic'`);
    this.ensureColumn('chat_bindings', 'scenario_config_json', 'TEXT');
    this.ensureColumn('chat_bindings', 'vault_root', 'TEXT');
    this.ensureColumn('chat_bindings', 'target_chat_id', 'TEXT');
    this.ensureColumn('chat_bindings', 'topic_id', 'INTEGER');

    this.ensureColumn('task_runs', 'scenario', `TEXT NOT NULL DEFAULT 'generic'`);
    this.ensureColumn('task_runs', 'input_kind', `TEXT NOT NULL DEFAULT 'text'`);
    this.ensureColumn('task_runs', 'source_url', 'TEXT');
    this.ensureColumn('task_runs', 'output_path', 'TEXT');
    this.ensureColumn('task_runs', 'target_chat_id', 'TEXT');
    this.ensureColumn('task_runs', 'topic_id', 'INTEGER');

    this.db.exec(`UPDATE chat_bindings SET target_chat_id = COALESCE(target_chat_id, chat_id)`);
    this.db.exec(`UPDATE task_runs SET target_chat_id = COALESCE(target_chat_id, chat_id)`);
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
      targetChatId: row.target_chat_id || row.chat_id,
      topicId: row.topic_id ?? null,
      channelType: row.channel_type as 'telegram',
      scenario: (row.scenario || 'generic') as ScenarioType,
      scenarioConfigJson: row.scenario_config_json,
      vaultRoot: row.vault_root,
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
      targetChatId: row.target_chat_id || row.chat_id,
      topicId: row.topic_id ?? null,
      scenario: (row.scenario || 'generic') as ScenarioType,
      workspaceName: row.workspace_name,
      threadId: row.thread_id,
      inputKind: (row.input_kind || 'text') as InputKind,
      sourceUrl: row.source_url,
      outputPath: row.output_path,
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

  private getContentItem(id: string): ContentItemRecord | null {
    const row = this.db.prepare(`
      SELECT id, task_run_id, scenario, title, source_type, source_url, summary, tags_json, file_path, created_at
      FROM content_items
      WHERE id = ?
    `).get(id) as ContentItemRow | undefined;
    return row ? this.mapContentItem(row) : null;
  }

  private mapContentItem(row: ContentItemRow): ContentItemRecord {
    return {
      id: row.id,
      taskRunId: row.task_run_id,
      scenario: row.scenario as ScenarioType,
      title: row.title,
      sourceType: row.source_type as CaptureSourceType,
      sourceUrl: row.source_url,
      summary: row.summary,
      tags: parseJsonArray(row.tags_json),
      filePath: row.file_path,
      createdAt: row.created_at,
    };
  }

  private mapScheduledJob(row: ScheduledJobRow): ScheduledJobRecord {
    return {
      id: row.id,
      chatId: row.chat_id,
      targetChatId: row.target_chat_id,
      topicId: row.topic_id ?? null,
      channelType: row.channel_type as 'telegram',
      scenario: row.scenario as ScenarioType,
      jobType: row.job_type as 'digest',
      scheduleTime: row.schedule_time,
      enabled: intToBool(row.enabled),
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some(row => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  target_chat_id: string | null;
  topic_id: number | null;
  channel_type: string;
  scenario: string | null;
  scenario_config_json: string | null;
  vault_root: string | null;
  workspace_name: string;
  current_thread_id: string | null;
  last_task_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRunRow {
  id: string;
  chat_id: string;
  target_chat_id: string | null;
  topic_id: number | null;
  scenario: string | null;
  workspace_name: string;
  thread_id: string | null;
  input_kind: string | null;
  source_url: string | null;
  output_path: string | null;
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

interface ContentItemRow {
  id: string;
  task_run_id: string;
  scenario: string;
  title: string;
  source_type: string;
  source_url: string | null;
  summary: string;
  tags_json: string;
  file_path: string;
  created_at: string;
}

interface ScheduledJobRow {
  id: string;
  chat_id: string;
  target_chat_id: string;
  topic_id: number | null;
  channel_type: string;
  scenario: string;
  job_type: string;
  schedule_time: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}
