import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  ChannelAdapter,
  Executor,
  RiskEvaluator,
  Store,
} from './interfaces.js';
import type {
  ChatBindingRecord,
  InboundMessage,
  ScheduledJobRecord,
  TaskRunRecord,
  WorkspaceRecord,
} from './types.js';
import { DeliveryLayer } from './delivery.js';
import { PermissionBroker } from './permission-broker.js';
import { SessionRouter } from './router.js';
import { ScenarioRouter } from '../scenarios/router.js';
import { GenericScenarioHandler, parseLabeledTaskRequest } from '../scenarios/generic.js';
import type { ScenarioTaskPlan } from '../scenarios/types.js';

interface ActiveTaskState {
  taskId: string;
  statusMessageId?: number;
  lastSummary: string;
  startedAt: number;
  lastEditAt: number;
  heartbeat?: ReturnType<typeof setInterval>;
  taskScenario: TaskRunRecord['scenario'];
  abort(): void;
}

export class BridgeManager {
  private readonly delivery: DeliveryLayer;
  private readonly permissionBroker: PermissionBroker;
  private readonly router: SessionRouter;
  private readonly scenarioRouter: ScenarioRouter;
  private readonly chatLocks = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, ActiveTaskState>();
  private schedulerTimer?: ReturnType<typeof setInterval>;
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
    this.scenarioRouter = new ScenarioRouter();
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.schedulerTimer = setInterval(() => {
      void this.runDueScheduledJobs().catch(error => {
        console.error('[bridge-manager] scheduled job tick failed:', error);
      });
    }, 30_000);
    await this.runDueScheduledJobs();
    await this.adapter.start(message => this.handleInbound(message));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }

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

  async runDueScheduledJobs(now: Date = new Date()): Promise<void> {
    if (this.stopping) return;
    const runAt = now.toISOString();
    const jobs = this.store.listDueScheduledJobs(runAt);
    for (const job of jobs) {
      const nextRunAt = computeNextRunAt(job.scheduleTime, new Date(now.getTime() + 60_000));
      this.store.markScheduledJobRun(job.id, runAt, nextRunAt);
      await this.runScheduledJob(job);
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
      if (binding.scenario !== 'daily_todo') {
        await this.reply(
          message.chatId,
          message.topicId,
          '当前只有 daily_todo 场景支持直接发送语音待办。先切到 /bindscenario daily_todo 再试。',
          message.messageId,
        );
        return;
      }

      await this.reply(
        message.chatId,
        message.topicId,
        '已收到语音，正在转写并整理待办。',
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
    const shortcut = parseScenarioShortcut(text);
    const autoScenario = !shortcut && binding.scenario === 'generic' ? inferAutoScenario(text) : null;
    const effectiveScenario = shortcut?.scenario ?? autoScenario ?? binding.scenario;
    const effectiveMessage: InboundMessage = shortcut
      ? { ...normalizedMessage, text: shortcut.text }
      : normalizedMessage;

    if (text === '/help' || text === '/start') {
      await this.reply(message.chatId, message.topicId, helpText(), message.messageId);
      return;
    }

    if (text === '/scenario') {
        await this.reply(
          message.chatId,
          message.topicId,
          `当前场景：${binding.scenario}\n当前工作区：${binding.workspaceName}`,
          message.messageId,
        );
        return;
      }

    if (text.startsWith('/bindscenario ')) {
      const scenario = text.slice('/bindscenario '.length).trim() as ChatBindingRecord['scenario'];
      if (!this.scenarioRouter.getScenarioNames().includes(scenario)) {
        await this.reply(
          message.chatId,
          message.topicId,
          `未知场景：${scenario}\n可用场景：${this.scenarioRouter.getScenarioNames().join(', ')}`,
          message.messageId,
        );
        return;
      }

      const updated = this.router.setScenario(message.bindingKey, message.channelType, scenario);
      await this.reply(
        message.chatId,
        message.topicId,
        `已切换场景：${updated.scenario}\n工作区：${updated.workspaceName}`,
        message.messageId,
      );
      return;
    }

    if (text === '/workspaces') {
      const all = this.store.listEnabledWorkspaces();
      const lines = all.map(item => `${item.name === binding.workspaceName ? '* ' : '- '}${item.name} -> ${item.path}`);
      await this.reply(message.chatId, message.topicId, ['可用工作区：', ...lines].join('\n'), message.messageId);
      return;
    }

    if (text.startsWith('/use ')) {
      const targetName = text.slice(5).trim();
      const nextWorkspace = this.store.getWorkspace(targetName);
      if (!nextWorkspace || !nextWorkspace.enabled) {
        await this.reply(message.chatId, message.topicId, `未知工作区：${targetName}`, message.messageId);
        return;
      }
      const updated = this.router.setWorkspace(message.bindingKey, message.channelType, targetName);
      await this.reply(message.chatId, message.topicId, `已切换工作区：${updated.workspaceName}`, message.messageId);
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
      const lines = history.map(item => `- ${item.status} [${item.workspaceName}] ${truncate(item.prompt, 70)}`);
      await this.reply(message.chatId, message.topicId, ['最近任务：', ...lines].join('\n'), message.messageId);
      return;
    }

    if (text === '/schedule') {
      const jobs = this.store.listScheduledJobsByChat(message.bindingKey).filter(item => item.enabled);
      if (jobs.length === 0) {
        await this.reply(message.chatId, message.topicId, '这个窗口还没有启用定时任务。', message.messageId);
        return;
      }
      const lines = jobs.map(item => `- ${item.jobType} · 每天 ${item.scheduleTime} · 下次 ${formatLocalDateTime(item.nextRunAt)}`);
      await this.reply(message.chatId, message.topicId, ['当前定时任务：', ...lines].join('\n'), message.messageId);
      return;
    }

    if (text.startsWith('/schedule ')) {
      if (binding.scenario !== 'ai_news') {
        await this.reply(message.chatId, message.topicId, '先用 /bindscenario ai_news 把这个窗口切到 ai_news。', message.messageId);
        return;
      }
      const schedule = parseDigestSchedule(text);
      if (!schedule) {
        await this.reply(message.chatId, message.topicId, '用法：/schedule digest HH:MM', message.messageId);
        return;
      }

      const nextRunAt = computeNextRunAt(schedule.time, new Date());
      const job = this.store.upsertScheduledJob({
        id: crypto.randomUUID(),
        chatId: message.bindingKey,
        targetChatId: message.chatId,
        topicId: message.topicId,
        channelType: message.channelType,
        scenario: 'ai_news',
        jobType: 'digest',
        scheduleTime: schedule.time,
        enabled: true,
        lastRunAt: null,
        nextRunAt,
      });
      await this.reply(
        message.chatId,
        message.topicId,
        `已设置 AI 日报定时任务：每天 ${job.scheduleTime}\n下次运行：${formatLocalDateTime(job.nextRunAt)}`,
        message.messageId,
      );
      return;
    }

    if (text === '/unschedule' || text === '/unschedule digest') {
      const job = this.store.disableScheduledJob(message.bindingKey, 'ai_news', 'digest');
      if (!job) {
        await this.reply(message.chatId, message.topicId, '这个窗口没有 AI 日报定时任务。', message.messageId);
        return;
      }
      await this.reply(message.chatId, message.topicId, '已关闭这个窗口的 AI 日报定时任务。', message.messageId);
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

    if (this.activeTasks.has(message.bindingKey)) {
      await this.reply(message.chatId, message.topicId, '这个窗口已有任务在运行。可用 /status 查看，或用 /abort 中止。', message.messageId);
      return;
    }

    const parsed = parseTaskRequest(effectiveMessage.text?.trim() || '', workspace.name);
    const requestedWorkspaceName = parsed?.workspaceName || workspace.name;
    const targetWorkspace = this.store.getWorkspace(requestedWorkspaceName);
    if (!targetWorkspace || !targetWorkspace.enabled) {
      await this.reply(message.chatId, message.topicId, `未知工作区：${requestedWorkspaceName}`, message.messageId);
      return;
    }

    if (binding.workspaceName !== requestedWorkspaceName) {
      this.router.setWorkspace(message.bindingKey, message.channelType, requestedWorkspaceName);
    }

    if (shouldSendPreparationAck(effectiveScenario, effectiveMessage.text || '')) {
      await this.reply(
        message.chatId,
        message.topicId,
        '已收到链接，正在提取正文或脚本。这一步可能需要一点时间。',
        message.messageId,
      );
    }

    const taskPlan = await this.buildScenarioTaskPlan(effectiveScenario, effectiveMessage, targetWorkspace);
    if (!taskPlan) {
      await this.reply(message.chatId, message.topicId, usageText(), message.messageId);
      return;
    }

    const task = this.store.createTaskRun({
      id: crypto.randomUUID(),
      chatId: message.bindingKey,
      targetChatId: message.chatId,
      topicId: message.topicId,
      scenario: taskPlan.scenario,
      workspaceName: targetWorkspace.name,
      threadId: binding.currentThreadId,
      inputKind: taskPlan.inputKind,
      sourceUrl: taskPlan.sourceUrl,
      outputPath: null,
      prompt: taskPlan.prompt,
      status: 'queued',
      riskFlags: [],
      approvalStatus: 'not_required',
      sandbox: targetWorkspace.defaultSandbox,
      model: targetWorkspace.defaultModel,
      finalMessage: null,
      errorText: null,
    });

    this.store.updateChatCurrentTask(message.bindingKey, message.channelType, task.id);
    const risk = this.riskEvaluator.evaluate(task, targetWorkspace);
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

    await this.startTask(updatedTask, taskPlan, binding.vaultRoot);
  }

  private async handleCallback(message: InboundMessage): Promise<void> {
    const data = message.callbackData || '';
    const match = /^approval:(approve|deny):(.+)$/.exec(data);
    if (!match) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '不支持的操作');
      }
      return;
    }

    const [, action, approvalId] = match;
    const approval = this.store.getApprovalRequest(approvalId);
    if (!approval || approval.chatId !== message.bindingKey) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '未找到审批记录');
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
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '已经处理过了');
      }
      return;
    }

    const task = this.store.getTaskRun(resolved.taskRunId);
    if (!task) {
      if (message.callbackQueryId) {
        await this.adapter.answerCallbackQuery(message.callbackQueryId, '未找到任务');
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
    const taskPlan = await this.buildScenarioTaskPlanFromTask(queuedTask, workspace);
    await this.startTask(queuedTask, taskPlan, binding.vaultRoot);
  }

  private async startTask(task: TaskRunRecord, taskPlan: ScenarioTaskPlan, bindingVaultRoot: string | null): Promise<void> {
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
        : `正在执行\n工作区：${workspace.name}\n${truncate(task.prompt, 240)}`,
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
    }, taskPlan.executionOptions);

    const activeState: ActiveTaskState = {
      taskId: task.id,
      statusMessageId: receipt.messageIds[0],
      lastSummary: '任务已开始',
      startedAt: Date.now(),
      lastEditAt: Date.now(),
      taskScenario: task.scenario,
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
      const completion = await this.completeScenarioTask(task, workspace, bindingVaultRoot, result.finalMessage);
      this.store.updateTaskRun(task.id, {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        finalMessage: completion.finalMessageForTask ?? result.finalMessage,
        errorText: null,
        outputPath: completion.outputPath ?? task.outputPath,
        threadId: result.threadId ?? runningTask.threadId,
      });

      if (completion.contentItem) {
        this.store.createContentItem({
          ...completion.contentItem,
          id: crypto.randomUUID(),
          taskRunId: task.id,
        });
      }

      if (result.threadId) {
        this.store.updateChatCurrentThread(task.chatId, 'telegram', result.threadId);
      }

      if (activeState.statusMessageId) {
        await this.delivery.edit(task.targetChatId, activeState.statusMessageId, '已完成', {
          taskRunId: task.id,
          kind: 'task_finished',
        });
      }

      await this.reply(task.targetChatId, task.topicId, completion.userMessage);
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

  private async runScheduledJob(job: ScheduledJobRecord): Promise<void> {
    if (job.scenario !== 'ai_news' || job.jobType !== 'digest') {
      return;
    }

    if (this.activeTasks.has(job.chatId)) {
      await this.reply(job.targetChatId, job.topicId, '本次定时日报已跳过：当前还有其他任务在运行。');
      return;
    }

    const binding = this.router.resolve(job.chatId, job.channelType, job.targetChatId, job.topicId);
    if (binding.scenario !== 'ai_news') {
      await this.reply(
        job.targetChatId,
        job.topicId,
        `本次定时日报已跳过：当前窗口场景已切换为 ${binding.scenario}。`,
      );
      return;
    }

    const workspace = this.resolveWorkspace(binding);
    const syntheticMessage: InboundMessage = {
      channelType: job.channelType,
      kind: 'message',
      chatId: job.targetChatId,
      bindingKey: job.chatId,
      topicId: job.topicId,
      text: '/digest',
    };
    const taskPlan = await this.buildScenarioTaskPlan('ai_news', syntheticMessage, workspace);
    if (!taskPlan) {
      return;
    }

    const task = this.store.createTaskRun({
      id: crypto.randomUUID(),
      chatId: job.chatId,
      targetChatId: job.targetChatId,
      topicId: job.topicId,
      scenario: taskPlan.scenario,
      workspaceName: workspace.name,
      threadId: binding.currentThreadId,
      inputKind: taskPlan.inputKind,
      sourceUrl: taskPlan.sourceUrl,
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

    this.store.insertAuditEvent({
      chatId: job.chatId,
      taskRunId: task.id,
      direction: 'system',
      kind: 'scheduled_digest',
      payload: `ai_news digest at ${job.scheduleTime}`,
    });
    this.store.updateChatCurrentTask(job.chatId, job.channelType, task.id);

    const risk = this.riskEvaluator.evaluate(task, workspace);
    if (risk.requiresApproval) {
      await this.reply(
        job.targetChatId,
        job.topicId,
        `本次定时日报已跳过：需要审批。\n${risk.summary}`,
      );
      this.store.updateTaskRun(task.id, {
        status: 'denied',
        approvalStatus: 'denied',
        finishedAt: new Date().toISOString(),
        errorText: `Skipped scheduled job: ${risk.summary}`,
        riskFlags: risk.flags,
      });
      return;
    }

    await this.startTask(task, taskPlan, binding.vaultRoot);
  }

  private async buildScenarioTaskPlan(
    scenario: ChatBindingRecord['scenario'],
    message: InboundMessage,
    workspace: WorkspaceRecord,
  ): Promise<ScenarioTaskPlan | null> {
    if (scenario === 'generic') {
      const generic = new GenericScenarioHandler();
      return generic.buildTaskPlan(message, workspace);
    }

    const plan = await this.scenarioRouter.buildTaskPlan(scenario, message, workspace);
    if (plan) return plan;

    return null;
  }

  private async buildScenarioTaskPlanFromTask(task: TaskRunRecord, workspace: WorkspaceRecord): Promise<ScenarioTaskPlan> {
    if (task.scenario === 'content_capture') {
      return {
        scenario: task.scenario,
        inputKind: task.inputKind,
        sourceUrl: task.sourceUrl,
        prompt: task.prompt,
        executionOptions: this.scenarioRouter.getHandler('content_capture') ? { outputSchemaPath: getContentCaptureSchemaPath() } : undefined,
        prefaceText: task.sourceUrl ? `正在沉淀内容，来源：${task.sourceUrl}` : '正在把内容沉淀到知识库',
        completionMode: 'content_capture',
      };
    }

    if (task.scenario === 'daily_todo') {
      return {
        scenario: task.scenario,
        inputKind: task.inputKind,
        sourceUrl: task.sourceUrl,
        prompt: task.prompt,
        executionOptions: this.scenarioRouter.getHandler('daily_todo') ? { outputSchemaPath: getDailyTodoSchemaPath() } : undefined,
        prefaceText: '正在整理今天的计划',
        completionMode: 'daily_todo',
      };
    }

    if (task.scenario === 'ai_news') {
      return {
        scenario: task.scenario,
        inputKind: task.inputKind,
        sourceUrl: task.sourceUrl,
        prompt: task.prompt,
        executionOptions: this.scenarioRouter.getHandler('ai_news') ? { outputSchemaPath: getAiNewsSchemaPath() } : undefined,
        prefaceText: '正在整理 AI 中文日报',
        completionMode: 'ai_news',
      };
    }

    return {
      scenario: task.scenario,
      inputKind: task.inputKind,
      sourceUrl: task.sourceUrl,
      prompt: task.prompt,
      completionMode: 'generic',
    };
  }

  private async completeScenarioTask(
    task: TaskRunRecord,
    workspace: WorkspaceRecord,
    bindingVaultRoot: string | null,
    finalMessage: string,
  ): Promise<{
    userMessage: string;
    outputPath?: string;
    contentItem?: {
      taskRunId: string;
      scenario: TaskRunRecord['scenario'];
      title: string;
      sourceType: import('./types.js').ContentItemRecord['sourceType'];
      sourceUrl: string | null;
      summary: string;
      tags: string[];
      filePath: string;
    };
    finalMessageForTask?: string;
  }> {
    const handler = this.scenarioRouter.getHandler(task.scenario);
    if (!handler?.complete) {
      return { userMessage: finalMessage, finalMessageForTask: finalMessage };
    }

    return handler.complete({
      finalMessage,
      workspace,
      bindingVaultRoot,
      sourceUrl: task.sourceUrl,
    });
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
    '/run <内容>             在当前工作区执行任务',
    '/待办 <内容>            直接按 daily_todo 方式整理',
    '/收集 <内容或链接>      直接按 content_capture 方式沉淀',
    '/日报 [范围]            直接生成 AI 中文日报',
    '/digest [范围]          在 ai_news 场景里手动生成中文日报',
    '/schedule               查看这个窗口的定时任务',
    '/schedule digest HH:MM  设置 ai_news 每天定时中文日报',
    '/unschedule digest      关闭 ai_news 定时中文日报',
    '/status                 查看当前或最近任务',
    '/abort                  中止当前任务',
    '/workspaces             查看可用工作区',
    '/use <name>             切换当前工作区',
    '/scenario               查看当前场景',
    '/bindscenario <name>    绑定当前窗口场景',
    '/history                查看最近任务',
    '/help                   查看帮助',
    '',
    '可用场景：',
    'generic, content_capture, daily_todo, ai_news',
  ].join('\n');
}

function usageText(): string {
  return [
    '当前输入没有匹配到可执行格式。',
    '',
    'generic 场景：',
    '直接发任务内容，或用 /run <内容>',
    '',
    '快捷入口：',
    '/待办 <内容>、/收集 <内容或链接>、/日报 [范围]',
    '',
    'content_capture 场景：',
    '直接发送文本、链接，或文本 + 链接',
    '',
    'daily_todo 场景：',
    '直接发送零散计划、待办，或直接发语音',
    '',
    'ai_news 场景：',
    '使用 /digest 或 /digest 3d',
    '定时日报可用 /schedule digest 09:00',
  ].join('\n');
}

function parseTaskRequest(text: string, currentWorkspaceName: string): { prompt: string; workspaceName: string } | null {
  if (!text) return null;

  if (text.startsWith('/run ')) {
    const prompt = text.slice(5).trim();
    return prompt ? { prompt, workspaceName: currentWorkspaceName } : null;
  }

  if (text.startsWith('/')) {
    return null;
  }

  const labeled = parseLabeledTaskRequest(text);
  if (labeled) {
    return labeled;
  }

  return { prompt: text.trim(), workspaceName: currentWorkspaceName };
}

function parseScenarioShortcut(text: string): { scenario: ChatBindingRecord['scenario']; text: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const todoMatch = /^\/待办(?:\s+([\s\S]+))?$/u.exec(trimmed);
  if (todoMatch) {
    return {
      scenario: 'daily_todo',
      text: todoMatch[1]?.trim() || '',
    };
  }

  const captureMatch = /^\/收集(?:\s+([\s\S]+))?$/u.exec(trimmed);
  if (captureMatch) {
    return {
      scenario: 'content_capture',
      text: captureMatch[1]?.trim() || '',
    };
  }

  const digestMatch = /^\/日报(?:\s+([\s\S]+))?$/u.exec(trimmed);
  if (digestMatch) {
    return {
      scenario: 'ai_news',
      text: `/digest ${digestMatch[1]?.trim() || ''}`.trim(),
    };
  }

  return null;
}

function inferAutoScenario(text: string): ChatBindingRecord['scenario'] | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;
  const urls = trimmed.match(/https?:\/\/[^\s]+/g) || [];
  if (urls.length === 0) return null;

  const firstUrl = urls[0];
  if (!firstUrl) return null;

  try {
    const host = new URL(firstUrl).hostname.replace(/^www\./, '').toLowerCase();
    if (
      host === 'youtube.com'
      || host === 'm.youtube.com'
      || host === 'youtu.be'
      || host === 'x.com'
      || host === 'twitter.com'
      || host === 'vimeo.com'
      || host === 'bilibili.com'
      || host === 'substack.com'
    ) {
      return 'content_capture';
    }
  } catch {}

  return 'content_capture';
}

function shouldSendPreparationAck(
  scenario: ChatBindingRecord['scenario'],
  text: string,
): boolean {
  if (scenario !== 'content_capture') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return false;
  return /https?:\/\/[^\s]+/i.test(trimmed);
}

function parseDigestSchedule(text: string): { time: string } | null {
  const match = /^\/schedule\s+digest\s+(\d{2}:\d{2})$/i.exec(text.trim());
  if (!match) return null;
  const time = match[1];
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return { time };
}

function computeNextRunAt(time: string, from: Date): string {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);
  if (next <= from) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
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

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getContentCaptureSchemaPath(): string {
  return fileURLToPath(new URL('../../config/schemas/content-capture.schema.json', import.meta.url));
}

function getDailyTodoSchemaPath(): string {
  return fileURLToPath(new URL('../../config/schemas/daily-todo.schema.json', import.meta.url));
}

function getAiNewsSchemaPath(): string {
  return fileURLToPath(new URL('../../config/schemas/ai-news.schema.json', import.meta.url));
}
