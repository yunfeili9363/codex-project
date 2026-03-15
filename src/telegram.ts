import type { ChannelAdapter } from './bridge/interfaces.js';
import { buildBindingKey } from './bridge/addressing.js';
import type { DeliveryReceipt, InboundMessage, InlineButton, OutboundMessage } from './bridge/types.js';

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  chat: {
    id: number;
  };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: {
    id: number;
    username?: string;
    first_name?: string;
  };
  message?: TelegramMessage;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const;
  private offset = 0;
  private running = false;
  private currentPollController?: AbortController;

  constructor(
    private readonly token: string,
    private readonly pollTimeoutSeconds: number,
  ) {}

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (this.running) {
      throw new Error('Telegram adapter is already running');
    }

    this.running = true;
    let failureCount = 0;
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        failureCount = 0;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const inbound = toInbound(update);
          if (inbound) {
            await onMessage(inbound);
          }
        }
      } catch (error) {
        if (!this.running && isAbortError(error)) {
          break;
        }
        console.error('[telegram-adapter] polling failed:', error);
        failureCount += 1;
        await sleep(Math.min(15_000, 1_500 * failureCount));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.currentPollController?.abort();
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const result = await this.request<TelegramMessage>('sendMessage', {
      chat_id: message.chatId,
      message_thread_id: message.topicId ?? undefined,
      text: message.text,
      reply_to_message_id: message.replyToMessageId,
      reply_parameters: message.replyToMessageId ? { message_id: message.replyToMessageId } : undefined,
      reply_markup: message.inlineButtons ? { inline_keyboard: toInlineKeyboard(message.inlineButtons) } : undefined,
    });
    return { messageIds: [result.message_id] };
  }

  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    await this.request('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    this.currentPollController?.abort();
    this.currentPollController = new AbortController();
    try {
      return await this.request<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
      }, {
        signal: this.currentPollController.signal,
        timeoutMs: (this.pollTimeoutSeconds + 10) * 1000,
      });
    } finally {
      this.currentPollController = undefined;
    }
  }

  private async request<T>(
    method: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Telegram HTTP ${response.status} for ${method}`);
    }

    const json = (await response.json()) as TelegramResponse<T>;
    if (!json.ok) {
      throw new Error(`Telegram API ${method} failed: ${json.description || 'unknown error'}`);
    }

    return json.result;
  }
}

function toInbound(update: TelegramUpdate): InboundMessage | null {
  const callback = update.callback_query;
  if (callback?.message) {
    const topicId = callback.message.message_thread_id ?? null;
    const rawChatId = String(callback.message.chat.id);
    return {
      channelType: 'telegram',
      kind: 'callback',
      chatId: rawChatId,
      bindingKey: buildBindingKey(rawChatId, topicId),
      topicId,
      messageId: callback.message.message_id,
      userId: String(callback.from.id),
      userDisplayName: callback.from.username || callback.from.first_name,
      callbackData: callback.data,
      callbackQueryId: callback.id,
    };
  }

  if (update.message) {
    const topicId = update.message.message_thread_id ?? null;
    const rawChatId = String(update.message.chat.id);
    return {
      channelType: 'telegram',
      kind: 'message',
      chatId: rawChatId,
      bindingKey: buildBindingKey(rawChatId, topicId),
      topicId,
      messageId: update.message.message_id,
      userId: update.message.from ? String(update.message.from.id) : undefined,
      userDisplayName: update.message.from?.username || update.message.from?.first_name,
      text: update.message.text,
    };
  }

  return null;
}

function toInlineKeyboard(buttons: InlineButton[][]): Array<Array<{ text: string; callback_data: string }>> {
  return buttons.map(row =>
    row.map(button => ({
      text: button.text,
      callback_data: button.callbackData,
    })),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const usable = signals.filter(Boolean) as AbortSignal[];
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  return AbortSignal.any(usable);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
