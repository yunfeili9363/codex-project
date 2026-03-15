import type { InboundMessage, ScenarioType, WorkspaceRecord } from '../bridge/types.js';
import { AiNewsScenarioHandler } from './ai-news.js';
import { ContentCaptureScenarioHandler } from './content-capture.js';
import { DailyTodoScenarioHandler } from './daily-todo.js';
import { GenericScenarioHandler } from './generic.js';
import type { ScenarioHandler, ScenarioTaskPlan } from './types.js';

export class ScenarioRouter {
  private readonly handlers = new Map<ScenarioType, ScenarioHandler>();

  constructor(handlers?: ScenarioHandler[]) {
    const defaults = handlers || [
      new GenericScenarioHandler(),
      new ContentCaptureScenarioHandler(),
      new DailyTodoScenarioHandler(),
      new AiNewsScenarioHandler(),
    ];
    for (const handler of defaults) {
      this.handlers.set(handler.scenario, handler);
    }
  }

  getScenarioNames(): ScenarioType[] {
    return ['generic', 'content_capture', 'daily_todo', 'ai_news'];
  }

  async buildTaskPlan(
    scenario: ScenarioType,
    message: InboundMessage,
    workspace: WorkspaceRecord,
  ): Promise<ScenarioTaskPlan | null> {
    const handler = this.handlers.get(scenario);
    if (!handler || !handler.canHandle(message)) return null;
    return handler.buildTaskPlan(message, workspace);
  }

  getHandler(scenario: ScenarioType): ScenarioHandler | null {
    return this.handlers.get(scenario) || null;
  }
}
