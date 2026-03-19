import type { ExecutionOptions } from '../bridge/interfaces.js';
import type { ContentItemRecord, InboundMessage, ScenarioType, TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

export interface ScenarioTaskPlan {
  scenario: ScenarioType;
  inputKind: TaskRunRecord['inputKind'];
  sourceUrl: string | null;
  prompt: string;
  executionOptions?: ExecutionOptions;
  prefaceText?: string;
  completionMode: 'generic' | 'content_capture' | 'daily_todo' | 'ai_news';
}

export interface ScenarioCompletionResult {
  userMessage: string;
  outputPath?: string;
  contentItem?: Omit<ContentItemRecord, 'id' | 'createdAt'>;
  finalMessageForTask?: string;
}

export interface ScenarioHandler {
  readonly scenario: ScenarioType;
  canHandle(message: InboundMessage): boolean;
  buildTaskPlan(message: InboundMessage, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null>;
  renderList?(params: {
    workspace: WorkspaceRecord;
    bindingVaultRoot: string | null;
  }): Promise<ScenarioCompletionResult>;
  complete?(params: {
    finalMessage: string;
    workspace: WorkspaceRecord;
    bindingVaultRoot: string | null;
    sourceUrl: string | null;
  }): Promise<ScenarioCompletionResult>;
}
