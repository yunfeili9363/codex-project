import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBindingKey } from '../bridge/addressing.js';
import { BridgeManager } from '../bridge/manager.js';
import { DefaultRiskEvaluator } from '../bridge/risk.js';
import { SqliteStore } from '../bridge/store.js';
import type { ChannelAdapter, ExecutionCallbacks, ExecutionHandle, Executor } from '../bridge/interfaces.js';
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
  public runs: TaskRunRecord[] = [];

  runTask(task: TaskRunRecord, _workspace: WorkspaceRecord, callbacks?: ExecutionCallbacks): ExecutionHandle {
    this.runs.push(task);
    callbacks?.onThreadId?.(`thread-${this.runs.length}`);
    callbacks?.onProgress?.(`处理中：${task.prompt.slice(0, 40)}`);

    return {
      abort() {},
      done: Promise.resolve({
        threadId: `thread-${this.runs.length}`,
        finalMessage: `已处理：${task.prompt}`,
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
  it('runs /run end-to-end', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('/run 帮我检查当前项目结构'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.status, 'succeeded');
    assert.equal(executor.runs.length, 1);
    assert.match(executor.runs[0]?.prompt || '', /请始终使用简体中文与我沟通/);
    assert.ok(adapter.sent.some(item => item.text.includes('已处理：')));
  });

  it('treats plain text as a generic task', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('帮我总结这个仓库里最重要的入口文件'));

    const latest = store.getLatestTaskRunByChat('chat-1');
    assert.equal(latest?.status, 'succeeded');
    assert.equal(latest?.scenario, 'generic');
    assert.match(executor.runs[0]?.prompt || '', /用户请求：/);
    assert.match(executor.runs[0]?.prompt || '', /帮我总结这个仓库里最重要的入口文件/);
  });

  it('transcribes a voice note before running the generic task', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    adapter.resolvedVoiceTexts.set('voice-1', { text: '帮我整理一下今天的开发目标' });
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('', {
      inputMode: 'voice',
      voiceNote: { fileId: 'voice-1', durationSeconds: 5 },
    }));

    assert.ok(adapter.sent.some(item => item.text.includes('已收到语音，正在转写。')));
    assert.match(executor.runs[0]?.prompt || '', /帮我整理一下今天的开发目标/);
  });

  it('auto-authorizes a new chat for admin users', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    const manager = new BridgeManager(
      adapter,
      store,
      executor,
      new DefaultRiskEvaluator(),
      new Set(['chat-1']),
      new Set(['admin-1']),
    );

    await manager.handleInbound(inbound('帮我看一下当前状态', {
      chatId: '-100-group',
      bindingKey: buildBindingKey('-100-group', null),
      userId: 'admin-1',
    }));

    assert.equal(store.isChatAuthorized('-100-group'), true);
    assert.ok(adapter.sent.some(item => item.text.includes('已自动授权这个对话。')));
    assert.equal(executor.runs.length, 1);
  });

  it('requests approval for a high-risk workspace and starts after approval', async () => {
    const adapter = new FakeAdapter();
    const executor = new FakeExecutor();
    const store = createStore();
    store.ensureChatBinding('chat-1', 'telegram', 'main', 'chat-1', null);
    store.updateChatWorkspace('chat-1', 'telegram', 'prod');
    const manager = new BridgeManager(adapter, store, executor, new DefaultRiskEvaluator(), new Set(['chat-1']));

    await manager.handleInbound(inbound('帮我直接修改生产配置'));

    const pendingTask = store.getLatestTaskRunByChat('chat-1');
    assert.equal(pendingTask?.status, 'pending_approval');
    const approvalMessage = adapter.sent.find(item => item.inlineButtons?.[0]?.[0]?.callbackData?.startsWith('approval:approve:'));
    assert.ok(approvalMessage);

    const approvalId = approvalMessage!.inlineButtons![0][0].callbackData.split(':')[2];
    await manager.handleInbound({
      channelType: 'telegram',
      kind: 'callback',
      chatId: 'chat-1',
      bindingKey: 'chat-1',
      topicId: null,
      callbackData: `approval:approve:${approvalId}`,
      callbackQueryId: 'callback-1',
      userId: 'user-1',
    });

    const finalTask = store.getLatestTaskRunByChat('chat-1');
    assert.equal(finalTask?.status, 'succeeded');
    assert.equal(executor.runs.length, 1);
    assert.ok(adapter.callbackAnswers.includes('已批准'));
  });
});
