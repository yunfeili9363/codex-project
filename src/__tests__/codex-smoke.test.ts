import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexExecutor } from '../codex.js';
import type { TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

const runRealSmoke = process.env.RUN_REAL_CODEX_SMOKE === '1';

const maybeIt = runRealSmoke ? it : it.skip;

describe('codex executor smoke', () => {
  maybeIt('runs a real codex task', async () => {
    const executor = new CodexExecutor({ approvalMode: 'never' });
    const task: TaskRunRecord = {
      id: 'task-1',
      chatId: 'chat-1',
      targetChatId: 'chat-1',
      topicId: null,
      scenario: 'generic',
      workspaceName: 'main',
      threadId: null,
      inputKind: 'text',
      sourceUrl: null,
      outputPath: null,
      prompt: '请只回复 SMOKE_OK',
      status: 'running',
      riskFlags: [],
      approvalStatus: 'not_required',
      sandbox: 'workspace-write',
      model: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      finalMessage: null,
      errorText: null,
    };
    const workspace: WorkspaceRecord = {
      name: 'main',
      path: process.cwd(),
      defaultSandbox: 'workspace-write',
      defaultModel: null,
      allowedAdditionalDirs: [],
      enabled: true,
      highRisk: false,
    };

    const result = await executor.runTask(task, workspace).done;
    assert.match(result.finalMessage, /SMOKE_OK/);
  });
});
