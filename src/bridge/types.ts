export type ChannelType = 'telegram';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalMode = 'untrusted' | 'on-request' | 'never';
export type ScenarioType = 'generic' | 'content_capture' | 'daily_todo' | 'ai_news';
export type InputKind = 'text' | 'url' | 'mixed' | 'command' | 'voice';
export type CaptureSourceType = 'text' | 'url' | 'mixed' | 'video';

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

export interface ContentItemRecord {
  id: string;
  taskRunId: string;
  scenario: ScenarioType;
  title: string;
  sourceType: CaptureSourceType;
  sourceUrl: string | null;
  summary: string;
  tags: string[];
  filePath: string;
  createdAt: string;
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

export interface ContentCaptureResult {
  title: string;
  source_type: CaptureSourceType;
  source_url: string | null;
  summary: string;
  core_points: string[];
  tags: string[];
  content_angles: string[];
  quick_card_markdown: string;
  reusable_note_markdown: string;
  suggested_path: string;
}

export interface DailyTodoResult {
  top_priority: string;
  must_do: string[];
  optional: string[];
  cut_if_short_on_time: string[];
  suggested_schedule: Array<{
    time_block: string;
    task: string;
  }>;
  daily_note_markdown: string;
}

export interface AiNewsResult {
  items: Array<{
    title: string;
    summary: string;
    why_it_matters: string;
    content_angle: string;
    source_url: string;
  }>;
  daily_digest_markdown: string;
}

export interface ScheduledJobRecord {
  id: string;
  chatId: string;
  targetChatId: string;
  topicId: number | null;
  channelType: ChannelType;
  scenario: ScenarioType;
  jobType: 'digest';
  scheduleTime: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}
