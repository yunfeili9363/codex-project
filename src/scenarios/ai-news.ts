import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import type { AiNewsResult, InboundMessage, WorkspaceRecord } from '../bridge/types.js';
import { aiNewsFilePath, defaultVaultRoot, displayPath } from '../vault/paths.js';
import { VaultWriter } from '../vault/writer.js';
import { parseLightweightIntent } from './intent.js';
import type { ScenarioCompletionResult, ScenarioHandler, ScenarioTaskPlan } from './types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../config/schemas/ai-news.schema.json', import.meta.url));

export class AiNewsScenarioHandler implements ScenarioHandler {
  readonly scenario = 'ai_news' as const;

  constructor(private readonly vaultWriter: VaultWriter = new VaultWriter()) {}

  canHandle(message: InboundMessage): boolean {
    const text = message.text?.trim() || '';
    return text.startsWith('/digest');
  }

  async buildTaskPlan(message: InboundMessage, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null> {
    const rawText = message.text?.trim() || '';
    if (!rawText.startsWith('/digest')) return null;

    const scopeIntent = parseLightweightIntent(rawText.slice('/digest'.length).trim() || '最近 24 小时');
    const scope = scopeIntent.cleanText || '最近 24 小时';
    return {
      scenario: this.scenario,
      inputKind: 'command',
      sourceUrl: null,
      prompt: buildAiNewsPrompt(scope, workspace.name, scopeIntent),
      executionOptions: { outputSchemaPath: SCHEMA_PATH },
      prefaceText: `正在整理 AI 中文日报，范围：${scope}`,
      completionMode: 'ai_news',
    };
  }

  async complete(params: {
    finalMessage: string;
    workspace: WorkspaceRecord;
    bindingVaultRoot: string | null;
    sourceUrl: string | null;
  }): Promise<ScenarioCompletionResult> {
    const parsed = parseAiNewsResult(params.finalMessage);
    const vaultRoot = defaultVaultRoot(params.workspace.path, params.bindingVaultRoot);
    const filePath = aiNewsFilePath(vaultRoot, new Date());
    const markdown = buildAiNewsMarkdown(parsed);
    await this.vaultWriter.appendMarkdown(filePath, markdown);
    const prettyPath = displayPath(params.workspace.path, filePath);

    const preview = parsed.items.slice(0, 5).map((item, index) => {
      return `${index + 1}. ${item.title}\n${item.summary}`;
    });

    const userMessage = [
      '【AI 中文日报】',
      ...preview,
      `归档：${prettyPath}`,
    ].join('\n\n');

    return {
      userMessage,
      outputPath: filePath,
      finalMessageForTask: userMessage,
    };
  }
}

function buildAiNewsPrompt(
  scope: string,
  workspaceName: string,
  intent: ReturnType<typeof parseLightweightIntent>,
): string {
  const hints: string[] = [];
  if (intent.compact) {
    hints.push('用户强调要简洁，请尽量控制在 3 到 4 条高价值内容。');
  }
  if (intent.focusKeyPoints) {
    hints.push('用户更关注重点，请优先给出真正高信号的更新。');
  }
  if (intent.focusContentAngles) {
    hints.push('用户关心内容选题，请把适合内容角度写得更具体。');
  }

  return [
    '你正在为中文创作者整理一份高信号的 AI 中文日报。',
    `当前工作区：${workspaceName}`,
    '',
    '请在给定时间范围内研究最新的 AI 新闻与更新。',
    '只保留最值得看的内容，整体保持短、准、清楚。',
    '优先选择这些类型的信息：官方模型发布、重要产品更新、基础设施变化、值得关注的开源项目，以及适合做中文科普或内容选题的消息。',
    '宁可少而精，也不要凑数。',
    '所有字段内容默认使用简体中文输出，只有专有名词和原始链接保留原文。',
    '请返回符合 schema 的结构化 JSON。',
    ...(hints.length > 0 ? ['', ...hints] : []),
    '',
    `请求范围：${scope}`,
  ].join('\n');
}

function parseAiNewsResult(raw: string): AiNewsResult {
  const parsed = JSON.parse(raw) as Partial<AiNewsResult>;
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .map(item => ({
          title: String(item?.title || '').trim(),
          summary: String(item?.summary || '').trim(),
          why_it_matters: String(item?.why_it_matters || '').trim(),
          content_angle: String(item?.content_angle || '').trim(),
          source_url: String(item?.source_url || '').trim(),
        }))
        .filter(item => item.title && item.summary)
    : [];

  return {
    items,
    daily_digest_markdown: parsed.daily_digest_markdown?.trim() || '',
  };
}

function buildAiNewsMarkdown(result: AiNewsResult): string {
  const lines: string[] = [
    '## AI 中文日报',
    '',
  ];

  if (result.items.length === 0) {
    lines.push('- 本次没有返回有效条目。');
  } else {
    for (const item of result.items) {
      lines.push(`### ${item.title}`);
      lines.push('');
      lines.push(`- 摘要：${item.summary}`);
      lines.push(`- 为什么值得关注：${item.why_it_matters}`);
      lines.push(`- 适合内容角度：${item.content_angle}`);
      lines.push(`- 来源：${item.source_url || 'N/A'}`);
      lines.push('');
    }
  }

  if (result.daily_digest_markdown) {
    lines.push('## 完整日报');
    lines.push(result.daily_digest_markdown);
    lines.push('');
  }

  lines.push(`<!-- ai_digest_id:${crypto.randomUUID()} -->`);
  return lines.join('\n');
}
