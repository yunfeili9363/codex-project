import type { InboundMessage, WorkspaceRecord } from '../bridge/types.js';
import type { ScenarioHandler, ScenarioTaskPlan } from './types.js';

export class GenericScenarioHandler implements ScenarioHandler {
  readonly scenario = 'generic' as const;

  canHandle(message: InboundMessage): boolean {
    const text = message.text?.trim() || '';
    return Boolean(text);
  }

  async buildTaskPlan(message: InboundMessage, _workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null> {
    const text = message.text?.trim() || '';
    if (!text) return null;

    if (text.startsWith('/run ')) {
      const prompt = text.slice(5).trim();
      if (!prompt) return null;
      return {
        scenario: this.scenario,
        inputKind: 'command',
        sourceUrl: null,
        prompt: buildGenericPrompt(prompt, _workspace.name),
        completionMode: 'generic',
      };
    }

    if (text.startsWith('/')) return null;

    const labeled = parseLabeledTaskRequest(text);
    if (labeled) {
      return {
        scenario: this.scenario,
        inputKind: 'text',
        sourceUrl: null,
        prompt: buildGenericPrompt(labeled.prompt, _workspace.name),
        completionMode: 'generic',
      };
    }

    return {
      scenario: this.scenario,
      inputKind: 'text',
      sourceUrl: null,
      prompt: buildGenericPrompt(text, _workspace.name),
      completionMode: 'generic',
    };
  }
}

function buildGenericPrompt(text: string, workspaceName: string): string {
  return [
    '请始终使用简体中文与我沟通。',
    '除了代码、命令、路径、配置键名、API 名称和必要的专有名词外，其余说明、分析、结论、报错解释都使用中文。',
    '如果用户输入有歧义，先用中文指出你理解到的含义，再继续给出最合理的处理结果。',
    `当前工作区：${workspaceName}`,
    '',
    '用户请求：',
    text,
  ].join('\n');
}

export function parseLabeledTaskRequest(text: string): { prompt: string; workspaceName: string } | null {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let prompt: string | null = null;
  let workspaceName: string | null = null;

  for (const line of lines) {
    const match = /^(scenario|workspace|场景|工作区)\s*[:：]\s*(.+)$/i.exec(line);
    if (!match) continue;

    const [, rawKey, rawValue] = match;
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    if (!value) continue;

    if (key === 'scenario' || key === '场景') {
      prompt = value;
    } else if (key === 'workspace' || key === '工作区') {
      workspaceName = value;
    }
  }

  if (!prompt || !workspaceName) {
    return null;
  }

  return { prompt, workspaceName };
}
