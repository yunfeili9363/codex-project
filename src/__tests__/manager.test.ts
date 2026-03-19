import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildBindingKey } from '../bridge/addressing.js';
import { BridgeManager } from '../bridge/manager.js';
import { DefaultRiskEvaluator } from '../bridge/risk.js';
import { SqliteStore } from '../bridge/store.js';
import type { ChannelAdapter, ExecutionCallbacks, ExecutionHandle, ExecutionOptions, Executor } from '../bridge/interfaces.js';
import type { DeliveryReceipt, InboundMessage, OutboundMessage, TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

const tempFiles: string[] = [];
const tempDirs: string[] = [];

class FakeAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const;
  public sent: OutboundMessage[] = [];
  public callbackAnswers: string[] = [];
  public resolvedVoiceTexts = new Map<string, { text: string; languageCode?: string | null }>();

  async start(): Promise<void> {
    throw new Error('not used');
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.sent.push(message);
    return { messageIds: [this.sent.length] };
  }

  async editMessage(_chatId: string, _messageId: number, text: string): Promise<void> {
    this.sent.push({ chatId: 'edit', text });
  }

  async answerCallbackQuery(_callbackQueryId: string, text?: string): Promise<void> {
    this.callbackAnswers.push(text || '');
  }

  async resolveVoiceText(message: InboundMessage): Promise<{ text: string; languageCode?: string | null } | null> {
    const fileId = message.voiceNote?.fileId;
    if (!fileId) return null;
    return this.resolvedVoiceTexts.get(fileId) || null;
  }
}

class FakeExecutor implements Executor {
  public runs: string[] = [];

  runTask(task: TaskRunRecord, _workspace: WorkspaceRecord, callbacks?: ExecutionCallbacks, options?: ExecutionOptions): ExecutionHandle {
    this.runs.push(task.prompt);
    callbacks?.onThreadId?.(`thread-${this.runs.length}`);
    if (task.scenario === 'content_capture' && options?.outputSchemaPath) {
      callbacks?.onProgress?.('capturing content');
      const isYouTubeCapture = task.prompt.includes('youtube.com/watch?v=5_JN4kfr-9o');
      return {
        abort() {},
        done: Promise.resolve({
          threadId: `thread-${this.runs.length}`,
          finalMessage: JSON.stringify({
            title: isYouTubeCapture ? 'Sample Video Capture' : 'Sample Capture',
            source_type: isYouTubeCapture ? 'video' : 'url',
            source_url: isYouTubeCapture ? 'https://www.youtube.com/watch?v=5_JN4kfr-9o' : 'https://example.com/post',
            summary: isYouTubeCapture ? 'A concise video summary.' : 'A concise summary.',
            core_points: ['Point one', 'Point two'],
            tags: ['ai', 'creator'],
            content_angles: ['Angle one'],
            quick_card_markdown: 'Quick card',
            reusable_note_markdown: 'Reusable note',
            suggested_path: isYouTubeCapture ? 'inbox/2026-03-14/sample-video-capture.md' : 'inbox/2026-03-14/sample-capture.md',
          }),
        }),
      };
    }

    if (task.scenario === 'daily_todo' && options?.outputSchemaPath) {
      callbacks?.onProgress?.('structuring daily todo');
      const suffix = this.runs.length;
      const isVoice = task.inputKind === 'voice';
      return {
        abort() {},
        done: Promise.resolve({
          threadId: `thread-${suffix}`,
          finalMessage: JSON.stringify({
            todo_text: isVoice
              ? '今天先把待办窗口整理好，再把海报发给 Ken，晚上复盘一下进度'
              : suffix === 1
                ? '把 Telegram bot 的 daily_todo 场景做完，并回复测试群消息'
                : '下午补一个复盘和整理动作',
            source_mode: isVoice ? 'voice' : 'text',
            normalized_markdown_line: isVoice
              ? '今天先把待办窗口整理好，再把海报发给 Ken，晚上复盘一下进度'
              : suffix === 1
                ? '把 Telegram bot 的 daily_todo 场景做完，并回复测试群消息'
                : '下午补一个复盘和整理动作',
          }),
        }),
      };
    }

    if (task.scenario === 'ai_news' && options?.outputSchemaPath) {
      callbacks?.onProgress?.('researching ai news');
      return {
        abort() {},
        done: Promise.resolve({
          threadId: `thread-${this.runs.length}`,
          finalMessage: JSON.stringify({
            items: [
              {
                title: 'OpenAI ships a new reasoning model',
                summary: 'A new model improves long-horizon planning and tool use.',
                why_it_matters: 'This changes what solo creators can automate with a single agent loop.',
                content_angle: 'Explain how better planning changes agent product design.',
                source_url: 'https://example.com/openai-reasoning',
              },
              {
                title: 'Anthropic adds safer code execution controls',
                summary: 'New controls make approvals and tool boundaries easier to manage.',
                why_it_matters: 'Safer execution is one of the blockers for real-world agent deployment.',
                content_angle: 'Compare approval systems across coding agents.',
                source_url: 'https://example.com/anthropic-controls',
              },
            ],
            daily_digest_markdown: 'Two high-signal items stood out today: a stronger reasoning model and better execution controls.',
          }),
        }),
      };
    }

    callbacks?.onProgress?.(`progress-${this.runs.length}`);
    return {
      abort() {},
      done: Promise.resolve({
        threadId: `thread-${this.runs.length}`,
        finalMessage: `done:${task.prompt}`,
      }),
    };
  }
}

function createStore(): SqliteStore {
  const dbPath = path.join(os.tmpdir(), `bridge-manager-${Date.now()}-${Math.random()}.db`);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-workspace-'));
  tempFiles.push(dbPath);
  tempDirs.push(workspaceDir);
  const store = new SqliteStore(dbPath);
  store.bootstrap([
    {
      name: 'main',
      path: workspaceDir,
      defaultSandbox: 'workspace-write',
      defaultModel: null,
      allowedAdditionalDirs: [],
      enabled: true,
      highRisk: false,
    },
    {
      name: 'prod',
      path: workspaceDir,
      defaultSandbox: 'workspace-write',
      defaultModel: null,
      allowedAdditionalDirs: [],
      enabled: true,
      highRisk: true,
    },
  ]);
  return store;
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  const chatId = overrides.chatId || 'chat-1';
  const topicId = overrides.topicId ?? null;
  return {
    channelType: 'telegram',
    kind: 'message',
    chatId,
    bindingKey: overrides.bindingKey || buildBindingKey(chatId, topicId),
    topicId,
    messageId: overrides.messageId ?? 1,
    userId: overrides.userId || 'user-1',
    userDisplayName: overrides.userDisplayName,
    text,
    inputMode: overrides.inputMode,
    voiceNote: overrides.voiceNote,
  };
}

afterEach(() => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('bridge manager', () => {
  it('runs a normal task end-to-end', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/run fix the lint issue'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.status, 'succeeded');
    assert.equal(executor.runs.length, 1);
    assert.ok(adapter.sent.some(item => item.text.includes('done:请始终使用简体中文与我沟通。')));
  });

  it('runs a chat task with scenario and workspace labels', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('scenario: fix the lint issue\nworkspace: main'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.status, 'succeeded');
    assert.equal(latest?.workspaceName, 'main');
    assert.match(executor.runs[0] || '', /用户请求：\s*fix the lint issue/);
  });

  it('runs plain text in the current workspace', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/use main'));
    await manager.handleInbound(inbound('check the project structure'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.status, 'succeeded');
    assert.equal(latest?.workspaceName, 'main');
    assert.match(executor.runs[0] || '', /用户请求：\s*check the project structure/);
  });

  it('runs /待办 as a lightweight daily_todo shortcut without changing chat binding', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/待办 只要最简版 排一下优先级 今天先收集资源，再整理成 markdown'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    const binding = store.getChatBinding('chat-1', 'telegram');
    assert.equal(latest?.scenario, 'daily_todo');
    assert.equal(binding?.scenario, 'generic');
    assert.match(executor.runs.at(-1) || '', /用户强调要简洁，优先提取最关键的动作项/);
    assert.match(executor.runs.at(-1) || '', /用户希望看到优先级或执行顺序/);
    assert.match(executor.runs.at(-1) || '', /用户输入：\s*今天先收集资源，再/);
  });

  it('runs /收集 as a lightweight content_capture shortcut', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/收集 顺便提炼重点，并整理成 markdown https://example.com/post 这篇内容值得留档'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'content_capture');
    assert.match(executor.runs.at(-1) || '', /用户希望提炼重点/);
    assert.match(executor.runs.at(-1) || '', /用户明确提到 Markdown/);
    assert.ok(adapter.sent.some(item => item.text.includes('【内容归档】')));
  });

  it('auto-routes a bare video url in generic chat to content_capture', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('youtube.com/watch')) {
        return new Response(`
          <html><script>
          var ytInitialPlayerResponse = {"videoDetails":{"title":"Mock Video"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions?lang=en","languageCode":"en"}]}}};
          </script></html>
        `, { status: 200 });
      }
      if (url.includes('example.com/captions')) {
        return new Response(JSON.stringify({
          events: [{ segs: [{ utf8: 'Transcript body.' }] }],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    };

    try {
      await manager.handleInbound(inbound('https://www.youtube.com/watch?v=5_JN4kfr-9o'));
      const latest = store.getLatestTaskRunByChat('chat-1');
      const binding = store.getChatBinding('chat-1', 'telegram');
      assert.equal(latest?.scenario, 'content_capture');
      assert.equal(binding?.scenario, 'generic');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs /日报 as an ai_news shortcut', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/日报 只要最简版 3d'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'ai_news');
    assert.match(executor.runs.at(-1) || '', /用户强调要简洁/);
    assert.match(executor.runs.at(-1) || '', /请求范围：3d/);
    assert.ok(adapter.sent.some(item => item.text.includes('【AI 中文日报】')));
  });

  it('requires approval for high-risk workspaces and starts after approval', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/use prod'));
    await manager.handleInbound(inbound('/run make a change'));

    const pending = store.getLatestTaskRunByChat('chat-1');
    assert.equal(pending?.status, 'pending_approval');
    assert.ok(adapter.sent.some(item => item.text.includes('Approval required before task execution.')));

    const approvalMessage = adapter.sent.find(item => item.inlineButtons)?.inlineButtons?.[0]?.[0]?.callbackData;
    assert.ok(approvalMessage);

    await manager.handleInbound({
      channelType: 'telegram',
      kind: 'callback',
      chatId: 'chat-1',
      bindingKey: buildBindingKey('chat-1', null),
      topicId: null,
      messageId: 99,
      userId: 'user-1',
      callbackData: approvalMessage,
      callbackQueryId: 'cb-1',
    });

    const approved = store.getLatestTaskRunByChat('chat-1');
    assert.equal(approved?.status, 'succeeded');
    assert.equal(executor.runs.length, 1);
    assert.deepEqual(adapter.callbackAnswers, ['已批准']);
  });

  it('routes plain text in content_capture scenario into vault capture flow', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario content_capture'));
    await manager.handleInbound(inbound('https://example.com/post 这是一个值得沉淀的观点'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'content_capture');
    assert.equal(latest?.status, 'succeeded');
    assert.ok(latest?.outputPath?.includes('sample-capture.md'));

    const contentItems = store.listContentItemsByChat('chat-1', 5);
    assert.equal(contentItems.length, 1);
    assert.equal(contentItems[0]?.title, 'Sample Capture');
    assert.ok(adapter.sent.some(item => item.text.includes('【内容归档】')));
    assert.ok(adapter.sent.some(item => item.text.includes('归档：vault/inbox/2026-03-14/sample-capture.md')));
  });

  it('treats a YouTube link in content_capture as a video source', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('youtube.com/watch')) {
        return new Response(`
          <html><script>
          var ytInitialPlayerResponse = {"videoDetails":{"title":"Mock Video"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions?lang=en","languageCode":"en"}]}}};
          </script></html>
        `, { status: 200 });
      }
      if (url.includes('example.com/captions')) {
        return new Response(JSON.stringify({
          events: [
            { segs: [{ utf8: 'Hello world. ' }] },
            { segs: [{ utf8: 'This is the full transcript.' }] },
          ],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    };

    try {
      await manager.handleInbound(inbound('/bindscenario content_capture'));
      await manager.handleInbound(inbound('https://www.youtube.com/watch?v=5_JN4kfr-9o'));

      const latest = store.getLatestTaskRunByChat('chat-1');
      assert.equal(latest?.scenario, 'content_capture');
      assert.equal(latest?.status, 'succeeded');
      assert.match(executor.runs.at(-1) || '', /优先将 source_type 填为：video/);
      assert.match(executor.runs.at(-1) || '', /已获取视频脚本，脚本语言：en/);
      assert.match(executor.runs.at(-1) || '', /视频脚本：/);
      assert.match(executor.runs.at(-1) || '', /Hello world\. This is the full transcript\./);
      assert.ok(latest?.outputPath?.includes('sample-video-capture.md'));

      const contentItems = store.listContentItemsByChat('chat-1', 5);
      assert.equal(contentItems[0]?.sourceType, 'video');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('extracts webpage text for x links in content_capture', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://r.jina.ai/http://x.com/demo/status/123') {
        assert.equal((init?.headers as Record<string, string> | undefined)?.['x-return-format'], 'markdown');
        return new Response('Thread title\n\nHere is the full thread body in English.', { status: 200 });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    };

    try {
      await manager.handleInbound(inbound('/bindscenario content_capture'));
      await manager.handleInbound(inbound('https://x.com/demo/status/123'));

      const latest = store.getLatestTaskRunByChat('chat-1');
      assert.equal(latest?.scenario, 'content_capture');
      assert.equal(latest?.status, 'succeeded');
      assert.match(executor.runs.at(-1) || '', /已获取网页正文/);
      assert.match(executor.runs.at(-1) || '', /网页正文：/);
      assert.match(executor.runs.at(-1) || '', /Here is the full thread body in English\./);
      assert.ok(adapter.sent.some(item => item.text.includes('【内容归档】')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps scenario bindings isolated across telegram topics in the same chat', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario content_capture', { topicId: 101 }));
    await manager.handleInbound(inbound('/scenario', { topicId: 101 }));
    await manager.handleInbound(inbound('/scenario', { topicId: 202 }));

    const topic101 = store.getChatBinding(buildBindingKey('chat-1', 101), 'telegram');
    const topic202 = store.getChatBinding(buildBindingKey('chat-1', 202), 'telegram');

    assert.equal(topic101?.scenario, 'content_capture');
    assert.equal(topic101?.targetChatId, 'chat-1');
    assert.equal(topic101?.topicId, 101);
    assert.equal(topic202?.scenario, 'generic');
    assert.equal(topic202?.targetChatId, 'chat-1');
    assert.equal(topic202?.topicId, 202);

    const replies = adapter.sent
      .filter(item => item.text.startsWith('当前场景：'))
      .map(item => ({ topicId: item.topicId ?? null, text: item.text }));

    assert.deepEqual(replies, [
      { topicId: 101, text: '当前场景：content_capture\n当前工作区：main' },
      { topicId: 202, text: '当前场景：generic\n当前工作区：main' },
    ]);
  });

  it('writes and appends daily_todo items into the persistent todo list', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario daily_todo'));
    await manager.handleInbound(inbound('今天最重要的是把 Telegram bot 的 daily_todo 场景做完，并回复测试群消息'));
    await manager.handleInbound(inbound('下午再帮我补一个复盘和整理动作'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'daily_todo');
    assert.equal(latest?.status, 'succeeded');
    assert.ok(latest?.outputPath?.includes(path.join('vault', 'todo-list.md')));

    const filePath = latest?.outputPath;
    assert.ok(filePath);
    const markdown = fs.readFileSync(filePath!, 'utf8');
    assert.match(markdown, /# 待办清单/);
    assert.match(markdown, /1\. 把 Telegram bot 的 daily_todo 场景做完，并回复测试群消息/);
    assert.match(markdown, /2\. 下午补一个复盘和整理动作/);
    assert.ok(!markdown.includes('---'));
    assert.ok(adapter.sent.some(item => item.text.includes('【待办清单】')));
    assert.ok(adapter.sent.some(item => item.text.includes('1、把 Telegram bot 的 daily_todo 场景做完，并回复测试群消息')));
    assert.ok(adapter.sent.some(item => item.text.includes('2、下午补一个复盘和整理动作')));
    assert.ok(adapter.sent.some(item => item.text.includes('已添加：2、下午补一个复盘和整理动作')));
    assert.ok(adapter.sent.some(item => item.text.includes(`归档：${path.relative(store.getWorkspace('main')!.path, filePath!).replace(/\\/g, '/')}`)));
  });

  it('transcribes a voice note in daily_todo before structuring the list', async () => {
    const adapter = new FakeAdapter();
    adapter.resolvedVoiceTexts.set('voice-1', {
      text: '今天先把待办窗口整理好，再把海报发给 Ken，晚上复盘一下进度',
      languageCode: 'zh',
    });
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario daily_todo'));
    await manager.handleInbound(inbound('', {
      inputMode: 'voice',
      voiceNote: {
        fileId: 'voice-1',
        mimeType: 'audio/ogg',
        durationSeconds: 11,
      },
    }));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'daily_todo');
    assert.equal(latest?.inputKind, 'voice');
    assert.match(executor.runs.at(-1) || '', /这段输入来自语音转写/);
    assert.match(executor.runs.at(-1) || '', /今天先把待办窗口整理好/);
    assert.ok(adapter.sent.some(item => item.text.includes('已收到语音，正在转写并整理待办。')));
    assert.ok(adapter.sent.some(item => item.text.includes('【待办清单】')));
  });

  it('shows the current todo list without adding a new item when asked to list it', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario daily_todo'));
    await manager.handleInbound(inbound('把海报做出来发给 Ken'));
    await manager.handleInbound(inbound('列出来当前的待办清单'));

    const tasks = store.listTaskRunsByChat('chat-1', 10);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.scenario, 'daily_todo');
    assert.ok(adapter.sent.some(item => item.text.includes('【待办清单】')));
    assert.ok(adapter.sent.some(item => item.text.includes('1、把 Telegram bot 的 daily_todo 场景做完，并回复测试群消息')));
    assert.ok(!adapter.sent.some(item => item.text.includes('已添加：2、列出来当前的待办清单')));
  });

  it('captures a manual ai_news digest into the daily news note', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario ai_news'));
    await manager.handleInbound(inbound('/digest 3d'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'ai_news');
    assert.equal(latest?.status, 'succeeded');
    assert.ok(latest?.outputPath?.includes(path.join('vault', 'ai-news')));

    const filePath = latest?.outputPath;
    assert.ok(filePath);
    const markdown = fs.readFileSync(filePath!, 'utf8');
    assert.match(markdown, /## AI 中文日报/);
    assert.match(markdown, /OpenAI ships a new reasoning model/);
    assert.match(markdown, /Anthropic adds safer code execution controls/);
    assert.ok(adapter.sent.some(item => item.text.includes('【AI 中文日报】')));
    assert.ok(adapter.sent.some(item => item.text.includes(`归档：${path.relative(store.getWorkspace('main')!.path, filePath!).replace(/\\/g, '/')}`)));
  });

  it('schedules and runs a daily ai_news digest automatically', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario ai_news'));
    await manager.handleInbound(inbound('/schedule digest 09:15'));

    const scheduled = store.getScheduledJob('chat-1', 'ai_news', 'digest');
    assert.ok(scheduled);
    assert.equal(scheduled?.enabled, true);
    assert.equal(scheduled?.scheduleTime, '09:15');

    store.upsertScheduledJob({
      ...(scheduled!),
      nextRunAt: '2026-03-14T09:14:00.000Z',
      updatedAt: '2026-03-14T09:00:00.000Z',
    });

    await manager.runDueScheduledJobs(new Date('2026-03-14T09:15:00.000Z'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.scenario, 'ai_news');
    assert.equal(latest?.status, 'succeeded');
    assert.ok(adapter.sent.some(item => item.text.includes('已设置 AI 日报定时任务：每天 09:15')));
    assert.ok(adapter.sent.some(item => item.text.includes('【AI 中文日报】')));
    assert.equal(store.getScheduledJob('chat-1', 'ai_news', 'digest')?.lastRunAt, '2026-03-14T09:15:00.000Z');
  });

  it('disables a scheduled ai_news digest', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/bindscenario ai_news'));
    await manager.handleInbound(inbound('/schedule digest 09:15'));
    await manager.handleInbound(inbound('/unschedule digest'));

    assert.equal(store.getScheduledJob('chat-1', 'ai_news', 'digest')?.enabled, false);
    assert.ok(adapter.sent.some(item => item.text.includes('已关闭这个窗口的 AI 日报定时任务。')));
  });

  it('auto-authorizes a new chat when a configured admin user sends the first message', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(
      adapter,
      store,
      executor,
      new DefaultRiskEvaluator(),
      new Set(['chat-1']),
      new Set(['admin-user']),
    );

    await manager.handleInbound(inbound('/scenario', {
      chatId: '-100-new-group',
      userId: 'admin-user',
    }));

    assert.equal(store.isChatAuthorized('-100-new-group'), true);
    assert.ok(adapter.sent.some(item => item.text.includes('已自动授权这个对话。')));
    assert.ok(adapter.sent.some(item => item.text.includes('当前场景：generic')));
  });
});
