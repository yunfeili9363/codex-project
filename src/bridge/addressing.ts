export function buildBindingKey(chatId: string, topicId: number | null | undefined): string {
  return topicId == null ? chatId : `${chatId}#${topicId}`;
}
