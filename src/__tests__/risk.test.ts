import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultRiskEvaluator } from '../bridge/risk.js';
import type { TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

function createTask(prompt: string): TaskRunRecord {
  return {
    id: 'task-1',
    chatId: 'chat-1',
    workspaceName: 'main',
    threadId: null,
    prompt,
    status: 'queued',
    riskFlags: [],
    approvalStatus: 'not_required',
    sandbox: 'workspace-write',
    model: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    finalMessage: null,
    errorText: null,
  };
}

function createWorkspace(overrides?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    name: 'main',
    path: process.cwd(),
    defaultSandbox: 'workspace-write',
    defaultModel: null,
    allowedAdditionalDirs: [],
    enabled: true,
    highRisk: false,
    ...overrides,
  };
}

describe('risk evaluator', () => {
  it('does not require approval for a normal prompt', () => {
    const evaluator = new DefaultRiskEvaluator();
    const risk = evaluator.evaluate(createTask('fix the failing test'), createWorkspace());
    assert.equal(risk.requiresApproval, false);
    assert.deepEqual(risk.flags, []);
  });

  it('requires approval for dangerous prompt patterns', () => {
    const evaluator = new DefaultRiskEvaluator();
    const risk = evaluator.evaluate(createTask('please delete the entire project and remove all files'), createWorkspace());
    assert.equal(risk.requiresApproval, true);
    assert.ok(risk.flags.includes('mass_delete_intent'));
  });

  it('requires approval for high-risk workspaces', () => {
    const evaluator = new DefaultRiskEvaluator();
    const risk = evaluator.evaluate(createTask('small change'), createWorkspace({ highRisk: true }));
    assert.equal(risk.requiresApproval, true);
    assert.ok(risk.flags.includes('workspace_marked_high_risk'));
  });
});
