import crypto from 'node:crypto';
import type {
  ChannelAdapter,
  Executor,
  RiskEvaluator,
  Store,
} from './interfaces.js';
import type {
  ChatBindingRecord,
  InboundMessage,
  TaskRunRecord,
  WorkspaceRecord,
} from './types.js';
import { DeliveryLayer } from './delivery.js';
import { PermissionBroker } from './permission-broker.js';
import { SessionRouter } from './router.js';
import { GenericScenarioHandler } from '../scenarios/generic.js';
import type { ScenarioTaskPlan } from '../scenarios/types.js';

interface ActiveTaskState {
  taskId: string;
  statusMessageId?: number;
  lastSummary: string;
  startedAt: number;
  lastEditAt: number;
  heartbeat?: ReturnType<typeof setInterval>;
  abort(): void;
}

export class BridgeManager {
  private readonly delivery: DeliveryLayer;
  private readonly permissionBroker: PermissionBroker;
  private readonly router: SessionRouter;
  private readonly genericHandler: GenericScenarioHandler;
  private readonly chatLocks = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, ActiveTaskState>();
  private stopping = false;

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly store: Store,
    private readonly executor: Executor,
    private readonly riskEvaluator: RiskEvaluator,
    private readonly allowedChatIds: Set<string>,
    private readonly adminUserIds: Set<string> = new Set(),
  ) {
    this.delivery = new DeliveryLayer(adapter, store);
    this.permissionBroker = new PermissionBroker(store, adapter);
    this.router = new SessionRouter(store);
    this.genericHandler = new GenericScenarioHandler();
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.adapter.start(message => this.handleInbound(message));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const active of this.activeTasks.values()) {
      if (active.heartbeat) {
        clearInterval(active.heartbeat);
      }
      try {
        active.abort();
      } catch (error) {
        console.error('[bridge-manager] failed to abort active task during shutdown:', error);
      }
    }

    if (this.adapter.stop) {
      await this.adapter.stop();
    }

    const deadline = Date.now() + 2_000;
    while (this.activeTasks.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  }

  handleInbound(message: InboundMessage): Promise<void> {
    const key = `${message.channelType}:${message.bindingKey}`;
    const prev = this.chatLocks.get(key) || Promise.resolve();
    const next = prev.then(() => this.processInbound(message), () => this.processInbound(message));
    this.chatLocks.set(key, next);
    next.finally(() => {
      if (this.chatLocks.get(key) === next) {
        this.chatLocks.delete(key);
      }
    }).catch(() => {});
    return next;
  }

  private async processInbound(message: InboundMessage): Promise<void> {
    if (this.stopping) return;
    if (!(this.allowedChatIds.has(message.chatId) || this.store.isChatAuthorized(message.chatId))) {
      if (message.userId && this.adminUserIds.has(message.userId)) {
        this.store.authorizeChat(message.chatId, message.userId);
        await this.delivery.send({
          chatId: message.chatId,
          topicId: message.topicId,
          text: [
            '已自动授权这个对话。',
            `chat_id: ${message.chatId}`,
            `topic_id: ${message.topicId ?? 'none'}`,
          ].join('\n'),
        }, { kind: 'chat_authorized' });
      } else {
        await this.delivery.send({
          chatId: message.chatId,
          topicId: message.topicId,
          text: [
            '这个对话还没授权。',
            `chat_id: ${message.chatId}`,
            `topic_id: ${message.topicId ?? 'none'}`,
            '把这个 chat_id 加到 TELEGRAM_ALLOWED_CHAT_IDS 后重启 bot。',
          ].join('\n'),
        }, { kind: 'unauthorized' });
        return;
      }
    }

    this.store.insertAuditEvent({
      chatId: message.bindingKey,
      direction: 'inbound',
      kind: message.kind,
      payload: message.text || message.callbackData || '',
    });

    if (message.kind === 'callback') {
      await this.handleCallback(message);
      return;
    }

    const binding = this.router.resolve(message.bindingKey, message.channelType, message.chatId, message.topicId);
    const workspace = this.resolveWorkspace(binding);
    let normalizedMessage = message;

    if (!normalizedMessage.text?.trim() && normalizedMessage.voiceNote) {
      await this.reply(
        message.chatId,
        message.topicId,
        '已收到语音，正在转写。',
        message.messageId,
      );

      const transcript = await this.adapter.resolveVoiceText?.(normalizedMessage);
      if (!transcript?.text?.trim()) {
        await this.reply(
          message.chatId,
          message.topicId,
          '这条语音暂时没转写成功。你可以重发一次，或者直接发文字。',
          message.messageId,
        );
        return;
      }

      normalizedMessage = {
        ...normalizedMessage,
        text: transcript.text.trim(),
        inputMode: 'voice',
      };
    }

    const text = normalizedMessage.text?.trim() || '';

    if (text === '/help' || text === '/start') {
      await this.reply(message.chatId, message.topicId, helpText(), message.messageId);
      return;
    }

    if (text === '/status') {
      await this.reply(message.chatId, message.topicId, this.renderStatus(message.bindingKey, workspace.name), message.messageId);
      return;
    }

    if (text === '/history') {
      const history = this.store.listTaskRunsByChat(message.bindingKey, 5);
      if (history.length === 0) {
        await this.reply(message.chatId, message.topicId, '还没有任务记录。', message.messageId);
        return;
      }
      const lines = history.map(item => `- ${item.status} ${truncate(item.prompt, 80)}`);
      await this.reply(message.chatId, message.topicId, ['最近任务：', ...lines].join('\n'), message.messageId);
      return;
    }

    if (text === '/abort') {
      const active = this.activeTasks.get(message.bindingKey);
      if (!active) {
        await this.reply(message.chatId, message.topicId, '当前没有运行中的任务。', message.messageId);
        return;
      }
      active.abort();
      await this.reply(message.chatId, message.topicId, '已发送中止请求。', message.messageId);
      return;
    }

    if (text.startsWith('/') && !text.startsWith('/run ')) {
      await this.reply(message.chatId, message.topicId, usageText(), message.messageId);
      return;
    }

    if (this.activeTasks.has(message.bindingKey)) {
      await this.reply(message.chatId, message.topicId, '这个对话已有任务在运行。可用 /status 查看，或用 /abort 中止。', message.messageId);
      return;
    }

    const taskPlan = await this.buildTaskPlan(normalizedMessage, workspace);
    if (!taskPlan) {
      await this.reply(message.chatId, message.topicId, usageText(), message.messageId);
      return;
    }

    const task = this.store.createTaskRun({
      id: crypto.randomUUID(),
      chatId: message.bindingKey,
      targetChatId: message.chatId,
      topicId: message.topicId,
      scenario: 'generic',
      workspaceName: workspace.name,
      threadId: binding.currentThreadId,
      inputKind: taskPlan.inputKind,
      sourceUrl: null,
      outputPath: null,
      prompt: taskPlan.prompt,
      status: 'queued',
      riskFlags: [],
      approvalStatus: 'not_required',
      sandbox: workspace.defaultSandbox,
      model: workspace.defaultModel,
      finalMessage: null,
      errorText: null,
    });

    this.store.updateChatCurrentTask(message.bindingKey, message.channelType, task.id);
    const risk = this.riskEvaluator.evaluate(task, workspace);
    const updatedTask = this.store.updateTaskRun(task.id, {
      status: risk.requiresApproval ? 'pending_approval' : 'queued',
      approvalStatus: risk.requiresApproval ? 'pending' : 'not_required',
      riskFlags: risk.flags,
    });

    if (risk.requiresApproval) {
      await this.permissionBroker.requestApproval(updatedTask, risk.summary, message.messageId);
      await this.reply(message.chatId, message.topicId, `任务已进入审批。\n${risk.summary}`, message.messageId);
      return;
    }

    await this.startTask(updatedTask, taskPlan);
  }

  private async handleCallback(message: InboundMessage): Promise<void> {
    const data = message.callbackData || '';
    const match = /^approval:(approve|deny):(.+)$/.exec(data);
    if (!match) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '不支持这个操作');
      }
      return;
    }

    const [, action, approvalId] = match;
    const approval = this.store.getApprovalRequest(approvalId);
    if (!approval || approval.chatId !== message.bindingKey) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '没找到这条审批记录');
      }
      return;
    }

    const resolved = await this.permissionBroker.resolveApproval(
      approvalId,
      action as 'approve' | 'deny',
      message.userId || null,
    );
    if (!resolved) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '这条审批已经处理过了');
      }
      return;
    }

    const task = this.store.getTaskRun(resolved.taskRunId);
    if (!task) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '没找到对应任务');
      }
      return;
    }

    if (action === 'deny') {
      this.store.updateTaskRun(task.id, {
        status: 'denied',
        approvalStatus: 'denied',
        finishedAt: new Date().toISOString(),
        errorText: 'Denied via Telegram approval',
      });
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '已拒绝');
      }
      await this.reply(message.chatId, message.topicId, '任务已拒绝。', message.messageId);
      return;
    }

    const queuedTask = this.store.updateTaskRun(task.id, {
      status: 'queued',
      approvalStatus: 'approved',
    });

    if (message.callbackQueryId) {
      await this.adapter.answerCallbackQuery(message.callbackQueryId, '已批准');
    }

    await this.reply(message.chatId, message.topicId, '已批准，开始执行。', message.messageId);
    const binding = this.router.resolve(message.bindingKey, 'telegram', message.chatId, message.topicId);
    const workspace = this.resolveWorkspace(binding);
    const taskPlan: ScenarioTaskPlan = {
      scenario: 'generic',
      inputKind: queuedTask.inputKind,
      sourceUrl: null,
      prompt: queuedTask.prompt,
      completionMode: 'generic',
    };
    await this.startTask(queuedTask, taskPlan);
  }

  private async startTask(task: TaskRunRecord, taskPlan: ScenarioTaskPlan): Promise<void> {
    if (this.activeTasks.has(task.chatId)) {
      throw new Error(`Task already running for chat ${task.chatId}`);
    }

    const binding = this.router.resolve(task.chatId, 'telegram');
    const workspace = this.resolveWorkspace(binding);
    const runningTask = this.store.updateTaskRun(task.id, {
      status: 'running',
      errorText: null,
      finalMessage: null,
    });

    const receipt = await this.delivery.send({
      chatId: task.targetChatId,
      topicId: task.topicId,
      text: taskPlan.prefaceText
        ? `${taskPlan.prefaceText}\n工作区：${workspace.name}`
        : `正在执行\n工作区：${workspace.name}`,
    }, { taskRunId: task.id, kind: 'task_status' });

    const handle = this.executor.runTask(runningTask, workspace, {
      onThreadId: threadId => {
        this.store.updateTaskRun(task.id, { threadId });
        this.store.updateChatCurrentThread(task.chatId, 'telegram', threadId);
      },
      onProgress: text => {
        const active = this.activeTasks.get(task.chatId);
        if (!active) return;
        active.lastSummary = truncate(text, 1200);
        const now = Date.now();
        if (active.statusMessageId && now - active.lastEditAt > 4000) {
          active.lastEditAt = now;
          void this.delivery.edit(
            task.targetChatId,
            active.statusMessageId,
            `正在执行\n工作区：${workspace.name}\n\n${active.lastSummary}`,
            { taskRunId: task.id, kind: 'task_progress' },
          ).catch(error => {
            console.error('[bridge-manager] progress edit failed:', error);
          });
        }
      },
    });

    const activeState: ActiveTaskState = {
      taskId: task.id,
      statusMessageId: receipt.messageIds[0],
      lastSummary: '任务已开始',
      startedAt: Date.now(),
      lastEditAt: Date.now(),
      abort: () => handle.abort(),
    };

    activeState.heartbeat = setInterval(() => {
      const active = this.activeTasks.get(task.chatId);
      if (!active || !active.statusMessageId) return;
      const elapsed = Math.floor((Date.now() - active.startedAt) / 1000);
      void this.delivery.edit(
        task.targetChatId,
        active.statusMessageId,
        `正在执行\n工作区：${workspace.name}\n已耗时：${elapsed}s\n\n${active.lastSummary}`,
        { taskRunId: task.id, kind: 'task_heartbeat' },
      ).catch(error => {
        console.error('[bridge-manager] heartbeat edit failed:', error);
      });
    }, 12_000);

    this.activeTasks.set(task.chatId, activeState);

    try {
      const result = await handle.done;
      this.store.updateTaskRun(task.id, {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        finalMessage: result.finalMessage,
        errorText: null,
        threadId: result.threadId ?? runningTask.threadId,
      });

      if (result.threadId) {
        this.store.updateChatCurrentThread(task.chatId, 'telegram', result.threadId);
      }

      if (activeState.statusMessageId) {
        await this.delivery.edit(task.targetChatId, activeState.statusMessageId, '已完成', {
          taskRunId: task.id,
          kind: 'task_finished',
        });
      }

      await this.reply(task.targetChatId, task.topicId, result.finalMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /aborted by user/i.test(message) ? 'aborted' : 'failed';
      this.store.updateTaskRun(task.id, {
        status,
        finishedAt: new Date().toISOString(),
        errorText: message,
      });

      if (activeState.statusMessageId) {
        await this.delivery.edit(task.targetChatId, activeState.statusMessageId, status === 'aborted' ? '已中止' : '执行失败', {
          taskRunId: task.id,
          kind: 'task_failed',
        });
      }

      await this.reply(
        task.targetChatId,
        task.topicId,
        [
          status === 'aborted' ? '【任务已中止】' : '【任务失败】',
          `工作区：${workspace.name}`,
          '',
          message,
        ].join('\n'),
      );
    } finally {
      if (activeState.heartbeat) {
        clearInterval(activeState.heartbeat);
      }
      this.activeTasks.delete(task.chatId);
      this.store.updateChatCurrentTask(task.chatId, 'telegram', task.id);
    }
  }

  private async buildTaskPlan(message: InboundMessage, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan | null> {
    return this.genericHandler.buildTaskPlan(message, workspace);
  }

  private resolveWorkspace(binding: ChatBindingRecord): WorkspaceRecord {
    const workspace = this.store.getWorkspace(binding.workspaceName);
    if (workspace && workspace.enabled) return workspace;

    const fallback = this.store.listEnabledWorkspaces()[0];
    if (!fallback) {
      throw new Error('No enabled workspaces configured');
    }
    return fallback;
  }

  private renderStatus(chatId: string, workspaceName: string): string {
    const active = this.activeTasks.get(chatId);
    if (active) {
      const elapsed = Math.floor((Date.now() - active.startedAt) / 1000);
      return `正在执行 · ${workspaceName} · ${elapsed}s\n${active.lastSummary}`;
    }

    const latest = this.store.getLatestTaskRunByChat(chatId);
    if (!latest) {
      return `当前空闲\n工作区：${workspaceName}`;
    }

    return [
      `最近任务：${latest.status}`,
      `工作区：${latest.workspaceName}`,
      latest.finishedAt ? `结束时间：${formatLocalDateTime(latest.finishedAt)}` : latest.startedAt ? `开始时间：${formatLocalDateTime(latest.startedAt)}` : '',
      latest.errorText ? `错误：${truncate(latest.errorText, 120)}` : '',
      latest.finalMessage ? `结果：${truncate(latest.finalMessage, 120)}` : '',
    ].filter(Boolean).join('\n');
  }

  private async reply(chatId: string, topicId: number | null, text: string, replyToMessageId?: number): Promise<void> {
    await this.delivery.send({ chatId, topicId, text, replyToMessageId });
  }
}

function helpText(): string {
  return [
    '可用命令：',
    '/run <内容>      发送明确任务',
    '/status          查看当前或最近任务',
    '/abort           中止当前任务',
    '/history         查看最近任务',
    '/help            查看帮助',
    '',
    '也可以直接发送文字或语音，机器人会把转写后的内容当成普通请求处理。',
  ].join('\n');
}

function usageText(): string {
  return [
    '当前只保留一个通用机器人入口。',
    '',
    '直接发送任务内容，或使用 /run <内容>。',
    '可用辅助命令：/status、/abort、/history、/help',
  ].join('\n');
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
