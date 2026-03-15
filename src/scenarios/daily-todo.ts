import { fileURLToPath } from 'node:url';
import type { DailyTodoResult, InboundMessage, WorkspaceRecord } from '../bridge/types.js';
import { dailyTodoFilePath, defaultVaultRoot, displayPath } from '../vault/paths.js';
import { VaultWriter } from '../vault/writer.js';
import { parseLightweightIntent } from './intent.js';
import type { ScenarioCompletionResult, ScenarioHandler, ScenarioTaskPlan } from './types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../config/schemas/daily-todo.schema.json', import.meta.url));

export class DailyTodoScenarioHandler implements ScenarioHandler {
  readonly scenario = 'daily_todo' as const;

  constructor(private readonly vaultWriter: VaultWriter = new VaultWriter()) {}

  canHandle(message: InboundMessage): boolean {
    return Boolean(message.text?.trim());
  }

  async buildTaskPlan(message: InboundMessage, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null> {
    const rawText = message.text?.trim() || '';
    if (!rawText || rawText.startsWith('/')) return null;
    const intent = parseLightweightIntent(rawText);
    const isVoice = message.inputMode === 'voice';

    return {
      scenario: this.scenario,
      inputKind: isVoice ? 'voice' : 'text',
      sourceUrl: null,
      prompt: buildDailyTodoPrompt(intent, workspace.name, isVoice),
      executionOptions: { outputSchemaPath: SCHEMA_PATH },
      prefaceText: isVoice ? '正在整理语音待办' : '正在整理今天的计划',
      completionMode: 'daily_todo',
    };
  }

  async complete(params: {
    finalMessage: string;
    workspace: WorkspaceRecord;
    bindingVaultRoot: string | null;
    sourceUrl: string | null;
  }): Promise<ScenarioCompletionResult> {
    const parsed = parseDailyTodoResult(params.finalMessage);
    const vaultRoot = defaultVaultRoot(params.workspace.path, params.bindingVaultRoot);
    const filePath = dailyTodoFilePath(vaultRoot);
    const appendResult = await this.vaultWriter.appendNumberedTodo(filePath, parsed.normalized_markdown_line);
    const prettyPath = displayPath(params.workspace.path, filePath);

    const userMessage = [
      '【待办已添加】',
      `${appendResult.index}、${parsed.todo_text}`,
      `归档：${prettyPath}`,
    ].filter(Boolean).join('\n');

    return {
      userMessage,
      outputPath: filePath,
      finalMessageForTask: userMessage,
    };
  }
}

function buildDailyTodoPrompt(
  intent: ReturnType<typeof parseLightweightIntent>,
  workspaceName: string,
  isVoice: boolean,
): string {
  const hints: string[] = [];
  if (intent.compact) {
    hints.push('用户强调要简洁，优先提取最关键的动作项，不要展开说明。');
  }
  if (intent.focusPriority) {
    hints.push('用户希望看到优先级或执行顺序，请把最重要、最先做的内容放前面。');
  }
  if (intent.markdown) {
    hints.push('用户明确提到 Markdown，请让 daily_note_markdown 保持简洁、可直接落盘。');
  }
  if (isVoice) {
    hints.push('这段输入来自语音转写，允许你做轻微口语纠正、断句和去噪，但不要改变用户原意。');
    hints.push('如果语音里包含时间、顺序、提醒对象、交付物，请保留下来并转成待办动作。');
  }

  return [
    '你正在帮助用户把一句口语化输入整理成一条待办。',
    `当前工作区：${workspaceName}`,
    '',
    '请返回符合 schema 的结构化 JSON。',
    '每次输入只允许产出一条待办，绝对不要拆成多条。',
    '只做轻度整理，不要扩展成建议、提醒、优先级、复盘、计划分解。',
    '允许你纠正明显转写错误、去掉口头语、合并重复表达、补齐明显缺失的动作主语。',
    '如果原句中包含时间、人名、交付对象、发送对象、地点等关键信息，要保留下来。',
    '不要添加用户没说过的新任务，也不要把一句话拆成多个子任务。',
    'todo_text 必须是一条简洁清晰的待办句子。',
    'normalized_markdown_line 与 todo_text 保持同义，适合直接写入 Markdown 有序列表。',
    `source_mode 固定填 ${isVoice ? 'voice' : 'text'}。`,
    '所有字段默认使用简体中文输出。',
    ...(hints.length > 0 ? ['', ...hints] : []),
    '',
    '用户输入：',
    intent.cleanText,
  ].join('\n');
}

function parseDailyTodoResult(raw: string): DailyTodoResult {
  const parsed = JSON.parse(raw) as Partial<DailyTodoResult>;
  const todoText = parsed.todo_text?.trim() || '补充一条待办';
  return {
    todo_text: todoText,
    source_mode: parsed.source_mode === 'voice' ? 'voice' : 'text',
    normalized_markdown_line: parsed.normalized_markdown_line?.trim() || todoText,
  };
}
