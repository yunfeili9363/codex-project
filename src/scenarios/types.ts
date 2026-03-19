import type { ExecutionOptions } from '../bridge/interfaces.js';
import type { InboundMessage, ScenarioType, TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

export interface ScenarioTaskPlan {
  scenario: ScenarioType;
  inputKind: TaskRunRecord['inputKind'];
  sourceUrl: string | null;
  prompt: string;
  executionOptions?: ExecutionOptions;
  prefaceText?: string;
  completionMode: 'generic';
}

export interface ScenarioCompletionResult {
  userMessage: string;
  outputPath?: string;
  finalMessageForTask?: string;
}

export interface ScenarioHandler {
  readonly scenario: ScenarioType;
  canHandle(message: InboundMessage): boolean;
  buildTaskPlan(message: InboundMessage, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null>;
}
