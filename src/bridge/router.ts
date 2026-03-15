import type { Store } from './interfaces.js';
import type { ChatBindingRecord, ScenarioType } from './types.js';

export class SessionRouter {
  constructor(private readonly store: Store) {}

  resolve(
    chatId: string,
    channelType: 'telegram',
    targetChatId?: string,
    topicId?: number | null,
  ): ChatBindingRecord {
    const existing = this.store.getChatBinding(chatId, channelType);
    if (existing) return existing;

    const workspaces = this.store.listEnabledWorkspaces();
    if (workspaces.length === 0) {
      throw new Error('No enabled workspaces configured');
    }

    return this.store.ensureChatBinding(chatId, channelType, workspaces[0].name, targetChatId || chatId, topicId);
  }

  setWorkspace(chatId: string, channelType: 'telegram', workspaceName: string): ChatBindingRecord {
    this.resolve(chatId, channelType);
    return this.store.updateChatWorkspace(chatId, channelType, workspaceName);
  }

  setScenario(
    chatId: string,
    channelType: 'telegram',
    scenario: ScenarioType,
    scenarioConfigJson?: string | null,
    vaultRoot?: string | null,
  ): ChatBindingRecord {
    this.resolve(chatId, channelType);
    return this.store.updateChatScenario(chatId, channelType, scenario, scenarioConfigJson, vaultRoot);
  }
}
