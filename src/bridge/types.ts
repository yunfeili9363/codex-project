export type ChannelType = 'telegram';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalMode = 'untrusted' | 'on-request' | 'never';
export type ScenarioType = 'generic';
export type InputKind = 'text' | 'url' | 'mixed' | 'command' | 'voice';

export interface WorkspaceDefinition {
  name: string;
  path: string;
  defaultSandbox: SandboxMode;
  defaultModel?: string;
  allowedAdditionalDirs?: string[];
  enabled?: boolean;
  highRisk?: boolean;
}

export interface WorkspaceRecord {
  name: string;
  path: string;
  defaultSandbox: SandboxMode;
  defaultModel: string | null;
  allowedAdditionalDirs: string[];
  enabled: boolean;
  highRisk: boolean;
}

export interface ChatBindingRecord {
  chatId: string;
  targetChatId: string;
  topicId: number | null;
  channelType: ChannelType;
  scenario: ScenarioType;
  scenarioConfigJson: string | null;
  vaultRoot: string | null;
  workspaceName: string;
  currentThreadId: string | null;
  lastTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | 'pending_approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'denied';

export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'denied';

export interface TaskRunRecord {
  id: string;
  chatId: string;
  targetChatId: string;
  topicId: number | null;
  scenario: ScenarioType;
  workspaceName: string;
  threadId: string | null;
  inputKind: InputKind;
  sourceUrl: string | null;
  outputPath: string | null;
  prompt: string;
  status: TaskStatus;
  riskFlags: string[];
  approvalStatus: ApprovalStatus;
  sandbox: SandboxMode;
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  finalMessage: string | null;
  errorText: string | null;
}

export interface ApprovalRequestRecord {
  id: string;
  taskRunId: string;
  chatId: string;
  riskSummary: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface AuditEventRecord {
  id: string;
  chatId: string;
  taskRunId: string | null;
  direction: 'inbound' | 'outbound' | 'system';
  kind: string;
  payload: string;
  createdAt: string;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface OutboundMessage {
  chatId: string;
  topicId?: number | null;
  text: string;
  replyToMessageId?: number;
  inlineButtons?: InlineButton[][];
}

export interface DeliveryReceipt {
  messageIds: number[];
}

export interface InboundMessage {
  channelType: ChannelType;
  kind: 'message' | 'callback';
  chatId: string;
  bindingKey: string;
  topicId: number | null;
  messageId?: number;
  userId?: string;
  userDisplayName?: string;
  text?: string;
  inputMode?: 'text' | 'voice';
  voiceNote?: {
    fileId: string;
    mimeType?: string | null;
    durationSeconds?: number | null;
  };
  callbackData?: string;
  callbackQueryId?: string;
}

export interface RiskEvaluation {
  requiresApproval: boolean;
  flags: string[];
  summary: string;
}

export interface CommandContext {
  inbound: InboundMessage;
  binding: ChatBindingRecord;
  workspace: WorkspaceRecord;
}
