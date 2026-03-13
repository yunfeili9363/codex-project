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
  private readonly chatLocks = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, ActiveTaskState>();

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly store: Store,
    private readonly executor: Executor,
    private readonly riskEvaluator: RiskEvaluator,
    private readonly allowedChatIds: Set<string>,
  ) {
    this.delivery = new DeliveryLayer(adapter, store);
    this.permissionBroker = new PermissionBroker(store, adapter);
    this.router = new SessionRouter(store);
  }

  async start(): Promise<void> {
    await this.adapter.start(message => this.handleInbound(message));
  }

  handleInbound(message: InboundMessage): Promise<void> {
    const key = `${message.channelType}:${message.chatId}`;
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
    if (!this.allowedChatIds.has(message.chatId)) {
      await this.delivery.send({ chatId: message.chatId, text: 'Unauthorized chat.' }, { kind: 'unauthorized' });
      return;
    }

    this.store.insertAuditEvent({
      chatId: message.chatId,
      direction: 'inbound',
      kind: message.kind,
      payload: message.text || message.callbackData || '',
    });

    if (message.kind === 'callback') {
      await this.handleCallback(message);
      return;
    }

    const binding = this.router.resolve(message.chatId, message.channelType);
    const workspace = this.resolveWorkspace(binding);
    const text = message.text?.trim() || '';

    if (text === '/help' || text === '/start') {
      await this.reply(message.chatId, helpText(), message.messageId);
      return;
    }

    if (text === '/workspaces') {
      const all = this.store.listEnabledWorkspaces();
      const lines = all.map(item => `${item.name === binding.workspaceName ? '* ' : '- '}${item.name} -> ${item.path}`);
      await this.reply(message.chatId, ['Workspaces:', ...lines].join('\n'), message.messageId);
      return;
    }

    if (text.startsWith('/use ')) {
      const targetName = text.slice(5).trim();
      const nextWorkspace = this.store.getWorkspace(targetName);
      if (!nextWorkspace || !nextWorkspace.enabled) {
        await this.reply(message.chatId, `Unknown workspace: ${targetName}`, message.messageId);
        return;
      }
      const updated = this.router.setWorkspace(message.chatId, message.channelType, targetName);
      await this.reply(message.chatId, `Workspace set to ${updated.workspaceName}`, message.messageId);
      return;
    }

    if (text === '/status') {
      await this.reply(message.chatId, this.renderStatus(message.chatId, workspace.name), message.messageId);
      return;
    }

    if (text === '/history') {
      const history = this.store.listTaskRunsByChat(message.chatId, 5);
      if (history.length === 0) {
        await this.reply(message.chatId, 'No task history yet.', message.messageId);
        return;
      }
      const lines = history.map(item => `- ${item.status} [${item.workspaceName}] ${truncate(item.prompt, 70)}`);
      await this.reply(message.chatId, ['Recent tasks:', ...lines].join('\n'), message.messageId);
      return;
    }

    if (text === '/abort') {
      const active = this.activeTasks.get(message.chatId);
      if (!active) {
        await this.reply(message.chatId, 'No running task.', message.messageId);
        return;
      }
      active.abort();
      await this.reply(message.chatId, 'Abort signal sent.', message.messageId);
      return;
    }

    if (!text.startsWith('/run ')) {
      await this.reply(message.chatId, 'Use /run <instruction>.', message.messageId);
      return;
    }

    if (this.activeTasks.has(message.chatId)) {
      await this.reply(message.chatId, 'A task is already running for this chat. Use /status or /abort.', message.messageId);
      return;
    }

    const prompt = text.slice(5).trim();
    if (!prompt) {
      await this.reply(message.chatId, 'Usage: /run <instruction>', message.messageId);
      return;
    }

    const task = this.store.createTaskRun({
      id: crypto.randomUUID(),
      chatId: message.chatId,
      workspaceName: workspace.name,
      threadId: binding.currentThreadId,
      prompt,
      status: 'queued',
      riskFlags: [],
      approvalStatus: 'not_required',
      sandbox: workspace.defaultSandbox,
      model: workspace.defaultModel,
      finalMessage: null,
      errorText: null,
    });

    this.store.updateChatCurrentTask(message.chatId, message.channelType, task.id);
    const risk = this.riskEvaluator.evaluate(task, workspace);
    const updatedTask = this.store.updateTaskRun(task.id, {
      status: risk.requiresApproval ? 'pending_approval' : 'queued',
      approvalStatus: risk.requiresApproval ? 'pending' : 'not_required',
      riskFlags: risk.flags,
    });

    if (risk.requiresApproval) {
      await this.permissionBroker.requestApproval(updatedTask, risk.summary, message.messageId);
      await this.reply(message.chatId, `Task queued for approval.\n${risk.summary}`, message.messageId);
      return;
    }

    await this.startTask(updatedTask);
  }

  private async handleCallback(message: InboundMessage): Promise<void> {
    const data = message.callbackData || '';
    const match = /^approval:(approve|deny):(.+)$/.exec(data);
    if (!match) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, 'Unsupported action');
      }
      return;
    }

    const [, action, approvalId] = match;
    const approval = this.store.getApprovalRequest(approvalId);
    if (!approval || approval.chatId !== message.chatId) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, 'Approval not found');
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
        await this.adapter.answerCallbackQuery(message.callbackQueryId, 'Already handled');
      }
      return;
    }

    const task = this.store.getTaskRun(resolved.taskRunId);
    if (!task) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, 'Task not found');
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
        await this.adapter.answerCallbackQuery(message.callbackQueryId, 'Denied');
      }
      await this.reply(message.chatId, 'Task denied.', message.messageId);
      return;
    }

    const queuedTask = this.store.updateTaskRun(task.id, {
      status: 'queued',
      approvalStatus: 'approved',
    });

    if (message.callbackQueryId) {
      await this.adapter.answerCallbackQuery(message.callbackQueryId, 'Approved');
    }

    await this.reply(message.chatId, 'Approval received. Starting task.', message.messageId);
    await this.startTask(queuedTask);
  }

  private async startTask(task: TaskRunRecord): Promise<void> {
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
      chatId: task.chatId,
      text: `Running task in ${workspace.name}...\n${truncate(task.prompt, 240)}`,
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
            task.chatId,
            active.statusMessageId,
            `Running task in ${workspace.name}...\n\n${active.lastSummary}`,
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
      lastSummary: 'Task started.',
      startedAt: Date.now(),
      lastEditAt: Date.now(),
      abort: () => handle.abort(),
    };

    activeState.heartbeat = setInterval(() => {
      const active = this.activeTasks.get(task.chatId);
      if (!active || !active.statusMessageId) return;
      const elapsed = Math.floor((Date.now() - active.startedAt) / 1000);
      void this.delivery.edit(
        task.chatId,
        active.statusMessageId,
        `Running task in ${workspace.name}...\nElapsed: ${elapsed}s\n\n${active.lastSummary}`,
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
        await this.delivery.edit(task.chatId, activeState.statusMessageId, 'Task finished.', {
          taskRunId: task.id,
          kind: 'task_finished',
        });
      }

      await this.reply(task.chatId, [
        `Task finished in ${workspace.name}.`,
        result.threadId ? `Thread: ${result.threadId}` : 'Thread: n/a',
        '',
        result.finalMessage,
      ].join('\n'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /aborted by user/i.test(message) ? 'aborted' : 'failed';
      this.store.updateTaskRun(task.id, {
        status,
        finishedAt: new Date().toISOString(),
        errorText: message,
      });

      if (activeState.statusMessageId) {
        await this.delivery.edit(task.chatId, activeState.statusMessageId, `Task ${status}.`, {
          taskRunId: task.id,
          kind: 'task_failed',
        });
      }

      await this.reply(task.chatId, `Task ${status}.\n\n${message}`);
    } finally {
      if (activeState.heartbeat) {
        clearInterval(activeState.heartbeat);
      }
      this.activeTasks.delete(task.chatId);
      this.store.updateChatCurrentTask(task.chatId, 'telegram', task.id);
    }
  }

  private resolveWorkspace(binding: ChatBindingRecord): WorkspaceRecord {
    const workspace = this.store.getWorkspace(binding.workspaceName);
    if (workspace && workspace.enabled) return workspace;

    const fallback = this.store.listEnabledWorkspaces()[0];
    if (!fallback) {
      throw new Error('No enabled workspaces configured');
    }
    return this.router.setWorkspace(binding.chatId, binding.channelType, fallback.name) && fallback;
  }

  private renderStatus(chatId: string, workspaceName: string): string {
    const active = this.activeTasks.get(chatId);
    if (active) {
      const elapsed = Math.floor((Date.now() - active.startedAt) / 1000);
      return `Running for ${elapsed}s in ${workspaceName}.\n${active.lastSummary}`;
    }

    const latest = this.store.getLatestTaskRunByChat(chatId);
    if (!latest) {
      return `Idle.\nWorkspace: ${workspaceName}`;
    }

    return [
      `Latest task: ${latest.status}`,
      `Workspace: ${latest.workspaceName}`,
      latest.finishedAt ? `Finished: ${latest.finishedAt}` : `Started: ${latest.startedAt}`,
      latest.errorText ? `Error: ${truncate(latest.errorText, 120)}` : '',
      latest.finalMessage ? `Result: ${truncate(latest.finalMessage, 120)}` : '',
    ].filter(Boolean).join('\n');
  }

  private async reply(chatId: string, text: string, replyToMessageId?: number): Promise<void> {
    await this.delivery.send({ chatId, text, replyToMessageId });
  }
}

function helpText(): string {
  return [
    'Commands:',
    '/run <instruction>  Run a Codex task',
    '/status             Show current or latest task',
    '/abort              Stop the current task',
    '/workspaces         List available workspaces',
    '/use <name>         Switch current workspace',
    '/history            Show recent tasks',
    '/help               Show this help',
  ].join('\n');
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 3)}...`;
}
