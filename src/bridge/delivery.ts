import type { ChannelAdapter, Store } from './interfaces.js';
import type { DeliveryReceipt, OutboundMessage } from './types.js';

const TELEGRAM_LIMIT = 4096;
const MAX_RETRIES = 3;

export class DeliveryLayer {
  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly store: Store,
  ) {}

  async send(message: OutboundMessage, audit?: { taskRunId?: string | null; kind?: string }): Promise<DeliveryReceipt> {
    const chunks = chunkText(message.text, TELEGRAM_LIMIT);
    const messageIds: number[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const receipt = await retry(() => this.adapter.send({
        ...message,
        text: chunks[index],
        inlineButtons: index === chunks.length - 1 ? message.inlineButtons : undefined,
        replyToMessageId: index === 0 ? message.replyToMessageId : undefined,
      }));
      messageIds.push(...receipt.messageIds);
    }

    this.store.insertAuditEvent({
      chatId: message.chatId,
      taskRunId: audit?.taskRunId ?? null,
      direction: 'outbound',
      kind: audit?.kind || 'message',
      payload: message.text.slice(0, 1000),
    });

    return { messageIds };
  }

  async edit(chatId: string, messageId: number, text: string, audit?: { taskRunId?: string | null; kind?: string }): Promise<void> {
    const safeText = text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT - 20)}\n\n[truncated]` : text;
    await retry(() => this.adapter.editMessage(chatId, messageId, safeText));

    this.store.insertAuditEvent({
      chatId,
      taskRunId: audit?.taskRunId ?? null,
      direction: 'system',
      kind: audit?.kind || 'message_edit',
      payload: safeText.slice(0, 1000),
    });
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit / 2) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks;
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}
