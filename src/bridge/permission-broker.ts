import crypto from 'node:crypto';
import type { ChannelAdapter, Store } from './interfaces.js';
import type { ApprovalRequestRecord, TaskRunRecord } from './types.js';

export class PermissionBroker {
  constructor(
    private readonly store: Store,
    private readonly adapter: ChannelAdapter,
  ) {}

  async requestApproval(task: TaskRunRecord, riskSummary: string, replyToMessageId?: number): Promise<ApprovalRequestRecord> {
    const approval = this.store.createApprovalRequest({
      id: crypto.randomUUID(),
      taskRunId: task.id,
      chatId: task.chatId,
      riskSummary,
      status: 'pending',
      resolvedBy: null,
    });

    await this.adapter.send({
      chatId: task.targetChatId,
      topicId: task.topicId,
      replyToMessageId,
      text: [
        'Approval required before task execution.',
        `Workspace: ${task.workspaceName}`,
        `Sandbox: ${task.sandbox}`,
        `Risk: ${riskSummary}`,
        '',
        task.prompt,
      ].join('\n'),
      inlineButtons: [
        [
          { text: 'Approve once', callbackData: `approval:approve:${approval.id}` },
          { text: 'Deny', callbackData: `approval:deny:${approval.id}` },
        ],
      ],
    });

    return approval;
  }

  async resolveApproval(id: string, action: 'approve' | 'deny', resolvedBy: string | null): Promise<ApprovalRequestRecord | null> {
    const approval = this.store.getApprovalRequest(id);
    if (!approval || approval.status !== 'pending') {
      return null;
    }

    return this.store.updateApprovalRequest(id, {
      status: action === 'approve' ? 'approved' : 'denied',
      resolvedAt: new Date().toISOString(),
      resolvedBy,
    });
  }
}
