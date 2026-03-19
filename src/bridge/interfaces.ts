import type {
  ApprovalRequestRecord,
  ChatBindingRecord,
  DeliveryReceipt,
  InboundMessage,
  OutboundMessage,
  RiskEvaluation,
  TaskRunRecord,
  WorkspaceRecord,
} from './types.js';

export interface ChannelAdapter {
  readonly channelType: 'telegram';
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
  editMessage(chatId: string, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  resolveVoiceText?(message: InboundMessage): Promise<{ text: string; languageCode?: string | null } | null>;
}

export interface ExecutionCallbacks {
  onThreadId?: (threadId: string) => void;
  onProgress?: (text: string) => void;
}

export interface ExecutionHandle {
  abort(): void;
  done: Promise<{
    threadId?: string;
    finalMessage: string;
  }>;
}

export interface ExecutionOptions {
  outputSchemaPath?: string;
}

export interface Executor {
  runTask(
    task: TaskRunRecord,
    workspace: WorkspaceRecord,
    callbacks?: ExecutionCallbacks,
    options?: ExecutionOptions,
  ): ExecutionHandle;
}

export interface Store {
  bootstrap(workspaces: WorkspaceRecord[]): void;
  markRunningTasksInterrupted(reason: string): void;
  isChatAuthorized(chatId: string): boolean;
  authorizeChat(chatId: string, addedByUserId: string | null, source?: string | null): void;

  listEnabledWorkspaces(): WorkspaceRecord[];
  getWorkspace(name: string): WorkspaceRecord | null;

  getChatBinding(chatId: string, channelType: 'telegram'): ChatBindingRecord | null;
  ensureChatBinding(
    chatId: string,
    channelType: 'telegram',
    defaultWorkspaceName: string,
    targetChatId: string,
    topicId?: number | null,
  ): ChatBindingRecord;
  updateChatWorkspace(chatId: string, channelType: 'telegram', workspaceName: string): ChatBindingRecord;
  updateChatCurrentTask(chatId: string, channelType: 'telegram', taskId: string | null): void;
  updateChatCurrentThread(chatId: string, channelType: 'telegram', threadId: string | null): void;

  createTaskRun(input: Omit<TaskRunRecord, 'startedAt' | 'finishedAt'> & { startedAt?: string; finishedAt?: string | null }): TaskRunRecord;
  getTaskRun(id: string): TaskRunRecord | null;
  updateTaskRun(id: string, updates: Partial<Omit<TaskRunRecord, 'id' | 'chatId' | 'workspaceName' | 'prompt'>>): TaskRunRecord;
  listTaskRunsByChat(chatId: string, limit: number): TaskRunRecord[];
  getLatestTaskRunByChat(chatId: string): TaskRunRecord | null;

  createApprovalRequest(input: Omit<ApprovalRequestRecord, 'createdAt' | 'resolvedAt'> & { createdAt?: string; resolvedAt?: string | null }): ApprovalRequestRecord;
  getApprovalRequest(id: string): ApprovalRequestRecord | null;
  updateApprovalRequest(id: string, updates: Partial<Omit<ApprovalRequestRecord, 'id' | 'taskRunId' | 'chatId' | 'createdAt'>>): ApprovalRequestRecord;

  insertAuditEvent(input: AuditEventRecordInput): void;
}

export interface AuditEventRecordInput {
  chatId: string;
  taskRunId?: string | null;
  direction: 'inbound' | 'outbound' | 'system';
  kind: string;
  payload: string;
}

export interface RiskEvaluator {
  evaluate(task: TaskRunRecord, workspace: WorkspaceRecord): RiskEvaluation;
}
