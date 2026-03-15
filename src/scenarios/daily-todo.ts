import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
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

    return {
      scenario: this.scenario,
      inputKind: 'text',
      sourceUrl: null,
      prompt: buildDailyTodoPrompt(intent, workspace.name),
      executionOptions: { outputSchemaPath: SCHEMA_PATH },
      prefaceText: '正在整理今天的计划',
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
    const filePath = dailyTodoFilePath(vaultRoot, new Date());
    const markdown = buildDailyTodoMarkdown(parsed);
    await this.vaultWriter.appendMarkdown(filePath, markdown);
    const prettyPath = displayPath(params.workspace.path, filePath);

    const actionItems = parsed.must_do.length > 0
      ? parsed.must_do.slice(0, 3)
      : [parsed.top_priority];

    const userMessage = [
      '【今日待办】',
      ...actionItems.map((item, index) => `${index + 1}、${item}`),
      `归档：${prettyPath}`,
    ].filter(Boolean).join('\n');

    return {
      userMessage,
      outputPath: filePath,
      finalMessageForTask: userMessage,
    };
  }
}

function buildDailyTodoPrompt(intent: ReturnType<typeof parseLightweightIntent>, workspaceName: string): string {
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

  return [
    '你正在帮助用户把口语化、零散的计划整理成清晰的今日待办。',
    `当前工作区：${workspaceName}`,
    '',
    '请返回符合 schema 的结构化 JSON。',
    '请尽量具体、简洁、可执行。',
    '只做轻量整理，不要扩展成顾问式长篇建议。',
    '重点不是分析，而是从原句里抽取“要做什么”的关键信息。',
    '优先给出现实可落地的任务和时间块，不要空泛鼓励。',
    '如果输入不够完整，可以做合理整理，但不要编造不可能确定的细节。',
    '必做事项最多 3 条，可选事项最多 2 条，建议时间安排最多 3 段，备注最多 2 句。',
    '最终应把最核心的待办拆成清晰短句，便于用 1、2、3 列出。',
    '所有字段默认使用简体中文输出。',
    ...(hints.length > 0 ? ['', ...hints] : []),
    '',
    '用户输入：',
    intent.cleanText,
  ].join('\n');
}

function parseDailyTodoResult(raw: string): DailyTodoResult {
  const parsed = JSON.parse(raw) as Partial<DailyTodoResult>;
  const schedule = Array.isArray(parsed.suggested_schedule)
    ? parsed.suggested_schedule
        .map(item => ({
          time_block: String(item?.time_block || '').trim(),
          task: String(item?.task || '').trim(),
        }))
        .filter(item => item.time_block && item.task)
    : [];

  return {
    top_priority: parsed.top_priority?.trim() || '先明确今天最重要的一件事',
    must_do: Array.isArray(parsed.must_do) ? parsed.must_do.map(String).map(item => item.trim()).filter(Boolean) : [],
    optional: Array.isArray(parsed.optional) ? parsed.optional.map(String).map(item => item.trim()).filter(Boolean) : [],
    cut_if_short_on_time: Array.isArray(parsed.cut_if_short_on_time)
      ? parsed.cut_if_short_on_time.map(String).map(item => item.trim()).filter(Boolean)
      : [],
    suggested_schedule: schedule,
    daily_note_markdown: parsed.daily_note_markdown?.trim() || '',
  };
}

function buildDailyTodoMarkdown(result: DailyTodoResult): string {
  const lines: string[] = [
    `## 今日计划更新`,
    '',
    `- 头号重点：${result.top_priority}`,
  ];

  if (result.must_do.length > 0) {
    lines.push('', '### 必做事项', ...result.must_do.map(item => `- [ ] ${item}`));
  }
  if (result.optional.length > 0) {
    lines.push('', '### 可选事项', ...result.optional.map(item => `- [ ] ${item}`));
  }
  if (result.cut_if_short_on_time.length > 0) {
    lines.push('', '### 时间不够时先砍', ...result.cut_if_short_on_time.map(item => `- ${item}`));
  }
  if (result.suggested_schedule.length > 0) {
    lines.push('', '### 建议时间安排', ...result.suggested_schedule.map(item => `- ${item.time_block}: ${item.task}`));
  }
  if (result.daily_note_markdown) {
    lines.push('', '### 备注', result.daily_note_markdown);
  }

  lines.push('', `<!-- daily_todo_id:${crypto.randomUUID()} -->`);
  return lines.join('\n');
}
