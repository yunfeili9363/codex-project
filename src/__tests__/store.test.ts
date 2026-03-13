import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from '../bridge/store.js';
import type { WorkspaceRecord } from '../bridge/types.js';

const tempFiles: string[] = [];

function createStore(): SqliteStore {
  const dbPath = path.join(os.tmpdir(), `bridge-store-${Date.now()}-${Math.random()}.db`);
  tempFiles.push(dbPath);
  return new SqliteStore(dbPath);
}

function workspace(name: string): WorkspaceRecord {
  return {
    name,
    path: process.cwd(),
    defaultSandbox: 'workspace-write',
    defaultModel: null,
    allowedAdditionalDirs: [],
    enabled: true,
    highRisk: false,
  };
}

afterEach(() => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

describe('sqlite store', () => {
  it('bootstraps workspaces and creates chat bindings', () => {
    const store = createStore();
    store.bootstrap([workspace('main')]);

    const binding = store.ensureChatBinding('chat-1', 'telegram', 'main');
    assert.equal(binding.workspaceName, 'main');
    assert.equal(store.listEnabledWorkspaces().length, 1);
  });

  it('persists task runs and approvals', () => {
    const store = createStore();
    store.bootstrap([workspace('main')]);

    const task = store.createTaskRun({
      id: 'task-1',
      chatId: 'chat-1',
      workspaceName: 'main',
      threadId: null,
      prompt: 'test prompt',
      status: 'pending_approval',
      riskFlags: ['mass_delete_intent'],
      approvalStatus: 'pending',
      sandbox: 'workspace-write',
      model: null,
      finalMessage: null,
      errorText: null,
    });

    const approval = store.createApprovalRequest({
      id: 'approval-1',
      taskRunId: task.id,
      chatId: task.chatId,
      riskSummary: 'Approval required',
      status: 'pending',
      resolvedBy: null,
    });

    assert.equal(store.getTaskRun(task.id)?.status, 'pending_approval');
    assert.equal(store.getApprovalRequest(approval.id)?.status, 'pending');
  });

  it('marks running tasks as interrupted on startup recovery', () => {
    const store = createStore();
    store.bootstrap([workspace('main')]);

    store.createTaskRun({
      id: 'task-1',
      chatId: 'chat-1',
      workspaceName: 'main',
      threadId: null,
      prompt: 'test prompt',
      status: 'running',
      riskFlags: [],
      approvalStatus: 'not_required',
      sandbox: 'workspace-write',
      model: null,
      finalMessage: null,
      errorText: null,
    });

    store.markRunningTasksInterrupted('restart');
    assert.equal(store.getTaskRun('task-1')?.status, 'interrupted');
    assert.equal(store.getTaskRun('task-1')?.errorText, 'restart');
  });
});
