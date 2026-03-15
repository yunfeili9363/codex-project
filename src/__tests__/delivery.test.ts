import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryLayer } from '../bridge/delivery.js';
import type { ChannelAdapter, Store } from '../bridge/interfaces.js';
import type { ApprovalRequestRecord, ChatBindingRecord, DeliveryReceipt, OutboundMessage, ScheduledJobRecord, TaskRunRecord, WorkspaceRecord } from '../bridge/types.js';

class FakeAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const;
  public sent: OutboundMessage[] = [];

  async start(): Promise<void> {
    throw new Error('not used');
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.sent.push(message);
    return { messageIds: [this.sent.length] };
  }

  async editMessage(): Promise<void> {}

  async answerCallbackQuery(): Promise<void> {}
}

class FakeStore implements Store {
  bootstrap(): void {}
  markRunningTasksInterrupted(): void {}
  isChatAuthorized(): boolean { return false; }
  authorizeChat(): void {}
  listEnabledWorkspaces(): WorkspaceRecord[] { return []; }
  getWorkspace(): WorkspaceRecord | null { return null; }
  getChatBinding(): ChatBindingRecord | null { return null; }
  ensureChatBinding(): ChatBindingRecord { throw new Error('not used'); }
  updateChatWorkspace(): ChatBindingRecord { throw new Error('not used'); }
  updateChatScenario(): ChatBindingRecord { throw new Error('not used'); }
  updateChatCurrentTask() {}
  updateChatCurrentThread() {}
  createTaskRun(): TaskRunRecord { throw new Error('not used'); }
  getTaskRun(): TaskRunRecord | null { return null; }
  updateTaskRun(): TaskRunRecord { throw new Error('not used'); }
  listTaskRunsByChat(): TaskRunRecord[] { return []; }
  getLatestTaskRunByChat(): TaskRunRecord | null { return null; }
  createApprovalRequest(): ApprovalRequestRecord { throw new Error('not used'); }
  getApprovalRequest(): ApprovalRequestRecord | null { return null; }
  updateApprovalRequest(): ApprovalRequestRecord { throw new Error('not used'); }
  createContentItem(): any { throw new Error('not used'); }
  listContentItemsByChat() { return []; }
  upsertScheduledJob(): ScheduledJobRecord { throw new Error('not used'); }
  getScheduledJob(): ScheduledJobRecord | null { return null; }
  listScheduledJobsByChat(): ScheduledJobRecord[] { return []; }
  listDueScheduledJobs(): ScheduledJobRecord[] { return []; }
  markScheduledJobRun(): ScheduledJobRecord { throw new Error('not used'); }
  disableScheduledJob(): ScheduledJobRecord | null { return null; }
  insertAuditEvent(): void {}
}

describe('delivery layer', () => {
  it('chunks large telegram messages', async () => {
    const adapter = new FakeAdapter();
    const delivery = new DeliveryLayer(adapter, new FakeStore());
    await delivery.send({
      chatId: 'chat-1',
      text: 'a'.repeat(5000),
    });

    assert.equal(adapter.sent.length, 2);
    assert.equal(adapter.sent[0].text.length, 4096);
  });
});
