import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import type { CaptureSourceType, ContentCaptureResult, InboundMessage, WorkspaceRecord } from '../bridge/types.js';
import { defaultVaultRoot, displayPath, inboxFilePath } from '../vault/paths.js';
import { VaultWriter } from '../vault/writer.js';
import { fetchReadableUrlText } from '../ingestion/url-content.js';
import { fetchVideoTranscript, type VideoTranscript } from '../ingestion/video-transcript.js';
import { parseLightweightIntent } from './intent.js';
import type { ScenarioCompletionResult, ScenarioHandler, ScenarioTaskPlan } from './types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../config/schemas/content-capture.schema.json', import.meta.url));

export class ContentCaptureScenarioHandler implements ScenarioHandler {
  readonly scenario = 'content_capture' as const;

  constructor(
    private readonly vaultWriter: VaultWriter = new VaultWriter(),
    private readonly transcriptFetcher: (url: string) => Promise<VideoTranscript | null> = fetchVideoTranscript,
    private readonly pageTextFetcher: (url: string) => Promise<string | null> = fetchReadableUrlText,
  ) {}

  canHandle(message: InboundMessage): boolean {
    return Boolean(message.text?.trim());
  }

  async buildTaskPlan(message: InboundMessage, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null> {
    const rawText = message.text?.trim() || '';
    if (!rawText || rawText.startsWith('/')) return null;
    const intent = parseLightweightIntent(rawText);

    const urls = extractUrls(intent.cleanText);
    const sourceUrl = urls[0] || null;
    const inputKind = sourceUrl ? (intent.cleanText.replace(sourceUrl, '').trim() ? 'mixed' : 'url') : 'text';
    const inferredSourceType = inferCaptureSourceType(sourceUrl, inputKind === 'mixed');
    const videoTranscript = inferredSourceType === 'video' && sourceUrl
      ? await this.tryFetchTranscript(sourceUrl)
      : null;
    const pageText = sourceUrl && inferredSourceType !== 'video'
      ? await this.tryFetchPageText(sourceUrl)
      : null;
    const prompt = buildContentCapturePrompt(intent, sourceUrl, workspace.name, inferredSourceType, videoTranscript, pageText);

    return {
      scenario: this.scenario,
      inputKind,
      sourceUrl,
      prompt,
      executionOptions: { outputSchemaPath: SCHEMA_PATH },
      prefaceText: sourceUrl
        ? inferredSourceType === 'video'
          ? videoTranscript
            ? '正在提取视频脚本并整理内容'
            : `正在整理视频内容，暂未拿到脚本：${sourceUrl}`
          : pageText
            ? '正在提取网页正文并整理内容'
            : `正在沉淀内容，来源：${sourceUrl}`
          : `正在沉淀内容，来源：${sourceUrl}`
        : '正在把内容沉淀到知识库',
      completionMode: 'content_capture',
    };
  }

  async complete(params: {
    finalMessage: string;
    workspace: WorkspaceRecord;
    bindingVaultRoot: string | null;
    sourceUrl: string | null;
  }): Promise<ScenarioCompletionResult> {
    const parsed = parseCaptureResult(params.finalMessage, params.sourceUrl);
    const vaultRoot = defaultVaultRoot(params.workspace.path, params.bindingVaultRoot);
    const filePath = path.resolve(
      parsed.suggested_path
        ? path.join(vaultRoot, parsed.suggested_path)
        : inboxFilePath(vaultRoot, new Date(), parsed.title),
    );

    const markdown = buildCaptureMarkdown(parsed);
    await this.vaultWriter.writeMarkdown(filePath, markdown);
    const prettyPath = displayPath(params.workspace.path, filePath);

    const userMessage = [
      '【内容沉淀】',
      parsed.title,
      parsed.summary,
      parsed.source_type === 'video' && parsed.reusable_note_markdown ? '已附完整脚本' : '',
      parsed.source_type !== 'video' && parsed.reusable_note_markdown ? '已附全文整理' : '',
      parsed.tags.length > 0 ? `标签：${parsed.tags.join(' / ')}` : '',
      `归档：${prettyPath}`,
    ].filter(Boolean).join('\n');

    return {
      userMessage,
      outputPath: filePath,
      finalMessageForTask: userMessage,
      contentItem: {
        taskRunId: '',
        scenario: this.scenario,
        title: parsed.title,
        sourceType: parsed.source_type,
        sourceUrl: parsed.source_url || params.sourceUrl,
        summary: parsed.summary,
        tags: parsed.tags,
        filePath,
      },
    };
  }

  private async tryFetchTranscript(url: string): Promise<VideoTranscript | null> {
    try {
      return await this.transcriptFetcher(url);
    } catch (error) {
      console.error('[content-capture] transcript fetch failed:', error);
      return null;
    }
  }

  private async tryFetchPageText(url: string): Promise<string | null> {
    try {
      return await this.pageTextFetcher(url);
    } catch (error) {
      console.error('[content-capture] page text fetch failed:', error);
      return null;
    }
  }
}

function buildContentCapturePrompt(
  intent: ReturnType<typeof parseLightweightIntent>,
  sourceUrl: string | null,
  workspaceName: string,
  inferredSourceType: CaptureSourceType,
  videoTranscript: VideoTranscript | null,
  pageText: string | null,
): string {
  const urlSection = sourceUrl
    ? [
        '主要链接：',
        sourceUrl,
        '',
        `优先将 source_type 填为：${inferredSourceType}`,
        '',
        isVideoUrl(sourceUrl)
          ? videoTranscript
            ? [
                `已获取视频脚本，脚本语言：${videoTranscript.languageCode}`,
                `脚本来源：${videoTranscript.source}`,
                '请基于这份脚本工作，不要脱离脚本自行脑补内容。',
                'reusable_note_markdown 请写成完整的中文脚本全文，尽量保留原始顺序和段落，不要只给摘要。',
                '',
                '视频脚本：',
                videoTranscript.transcript,
              ].join('\n')
            : '这是一个视频链接，但当前没有拿到视频脚本。如果你无法直接访问视频页面、字幕、音频或转录内容，必须明确说明信息不足，不得编造标题、观点、案例、时间戳、讲者原话或结论。'
          : pageText
            ? [
                '已获取网页正文。',
                '请基于正文工作，不要只看链接标题。',
                'reusable_note_markdown 请写成完整的中文整理稿或全文译文，尽量保留原始顺序。',
                '',
                '网页正文：',
                pageText,
              ].join('\n')
            : '如果你无法直接访问链接内容，只能基于用户提供的上下文谨慎推断，明确避免编造细节。',
      ].join('\n')
    : '本次没有提供主要链接。';
  const hints: string[] = [];
  if (intent.compact) {
    hints.push('用户强调要简洁，请优先输出短摘要和最关键的信息。');
  }
  if (intent.focusKeyPoints) {
    hints.push('用户希望提炼重点，请优先把 summary 和 core_points 压清楚。');
  }
  if (intent.markdown) {
    hints.push('用户明确提到 Markdown，请让可复用笔记更适合直接归档。');
  }
  if (intent.focusContentAngles) {
    hints.push('用户想看内容选题方向，请把 content_angles 写得更实用。');
  }
  if (inferredSourceType === 'video') {
    hints.push('这是视频内容。如果已经提供脚本，优先完整保留脚本内容，再补摘要和要点。');
  }
  if (pageText) {
    hints.push('这是正文提取任务，优先保留全文信息，再做中文整理。');
  }

  return [
    '你正在帮助用户把有价值的内容沉淀进知识库。',
    `当前工作区：${workspaceName}`,
    '',
    '请返回符合 schema 的结构化 JSON。',
    '只做轻量提炼和整理，不要写成长篇分析。',
    '重点提炼：核心观点、可复用笔记、可能的内容角度。',
    '所有字段默认使用简体中文输出，只有链接和必要专有名词保留原文。',
    ...(hints.length > 0 ? ['', ...hints] : []),
    '',
    urlSection,
    '',
    '用户输入：',
    intent.cleanText,
  ].join('\n');
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s]+/g);
  return matches ? matches.map(item => item.trim()) : [];
}

function parseCaptureResult(raw: string, sourceUrl: string | null): ContentCaptureResult {
  const parsed = JSON.parse(raw) as Partial<ContentCaptureResult>;
  const fallbackSourceType = inferCaptureSourceType(parsed.source_url || sourceUrl, false);
  return {
    title: parsed.title?.trim() || '未命名沉淀',
    source_type: isCaptureSourceType(parsed.source_type) ? parsed.source_type : fallbackSourceType,
    source_url: parsed.source_url || null,
    summary: parsed.summary?.trim() || '未提供摘要。',
    core_points: Array.isArray(parsed.core_points) ? parsed.core_points.map(String) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    content_angles: Array.isArray(parsed.content_angles) ? parsed.content_angles.map(String) : [],
    quick_card_markdown: parsed.quick_card_markdown?.trim() || '',
    reusable_note_markdown: parsed.reusable_note_markdown?.trim() || '',
    suggested_path: sanitizeSuggestedPath(parsed.suggested_path),
  };
}

function inferCaptureSourceType(sourceUrl: string | null, hasExtraText: boolean): CaptureSourceType {
  if (!sourceUrl) return 'text';
  if (isVideoUrl(sourceUrl)) return 'video';
  return hasExtraText ? 'mixed' : 'url';
}

function isCaptureSourceType(value: unknown): value is CaptureSourceType {
  return value === 'text' || value === 'url' || value === 'mixed' || value === 'video';
}

function isVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com'
      || host === 'm.youtube.com'
      || host === 'youtu.be'
      || host === 'vimeo.com'
      || host === 'player.vimeo.com'
      || host === 'bilibili.com';
  } catch {
    return false;
  }
}

function sanitizeSuggestedPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) return '';
  return normalized;
}

function buildCaptureMarkdown(result: ContentCaptureResult): string {
  const lines: string[] = [
    `# ${result.title}`,
    '',
    `- 来源类型：${result.source_type}`,
    `- 来源链接：${result.source_url || 'N/A'}`,
    result.tags.length > 0 ? `- 标签：${result.tags.join(', ')}` : '- 标签：',
    '',
    '## 摘要',
    result.summary,
  ];

  if (result.core_points.length > 0) {
    lines.push('', '## 核心要点', ...result.core_points.map(item => `- ${item}`));
  }
  if (result.content_angles.length > 0) {
    lines.push('', '## 内容角度', ...result.content_angles.map(item => `- ${item}`));
  }
  if (result.quick_card_markdown) {
    lines.push('', '## 速记卡片', result.quick_card_markdown);
  }
  if (result.reusable_note_markdown) {
    lines.push('', result.source_type === 'video' ? '## 完整脚本' : '## 可复用笔记', result.reusable_note_markdown);
  }

  lines.push('', `<!-- capture_id:${crypto.randomUUID()} -->`);
  return lines.join('\n');
}
