import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BridgeManager } from '../bridge/manager.js';
import { DefaultRiskEvaluator } from '../bridge/risk.js';
import { SqliteStore } from '../bridge/store.js';
import type { ChannelAdapter, ExecutionCallbacks, ExecutionHandle, Executor } from '../bridge/interfaces.js';
import type { DeliveryReceipt, InboundMessage, OutboundMessage, TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

const tempFiles: string[] = [];

class FakeAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const;
  public sent: OutboundMessage[] = [];
  public callbackAnswers: string[] = [];

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
}

class FakeExecutor implements Executor {
  public runs: string[] = [];

  runTask(task: TaskRunRecord, _workspace: WorkspaceRecord, callbacks?: ExecutionCallbacks): ExecutionHandle {
    this.runs.push(task.prompt);
    callbacks?.onThreadId?.(`thread-${this.runs.length}`);
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
  tempFiles.push(dbPath);
  const store = new SqliteStore(dbPath);
  store.bootstrap([
    {
      name: 'main',
      path: process.cwd(),
      defaultSandbox: 'workspace-write',
      defaultModel: null,
      allowedAdditionalDirs: [],
      enabled: true,
      highRisk: false,
    },
    {
      name: 'prod',
      path: process.cwd(),
      defaultSandbox: 'workspace-write',
      defaultModel: null,
      allowedAdditionalDirs: [],
      enabled: true,
      highRisk: true,
    },
  ]);
  return store;
}

function inbound(text: string): InboundMessage {
  return {
    channelType: 'telegram',
    kind: 'message',
    chatId: 'chat-1',
    messageId: 1,
    userId: 'user-1',
    text,
  };
}

afterEach(() => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
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
    assert.ok(adapter.sent.some(item => item.text.includes('Task finished')));
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
      messageId: 99,
      userId: 'user-1',
      callbackData: approvalMessage,
      callbackQueryId: 'cb-1',
    });

    const approved = store.getLatestTaskRunByChat('chat-1');
    assert.equal(approved?.status, 'succeeded');
    assert.equal(executor.runs.length, 1);
    assert.deepEqual(adapter.callbackAnswers, ['Approved']);
  });
});
