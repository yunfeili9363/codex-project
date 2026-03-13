import { loadConfig, loadWorkspaceRegistry } from './config.js';
import { BridgeManager } from './bridge/manager.js';
import { DefaultRiskEvaluator } from './bridge/risk.js';
import { SqliteStore } from './bridge/store.js';
import { CodexExecutor } from './codex.js';
import { TelegramAdapter } from './telegram.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const workspaces = loadWorkspaceRegistry(config.workspacesPath);

  const store = new SqliteStore(config.databasePath);
  store.bootstrap(workspaces);
  store.markRunningTasksInterrupted('Bridge process restarted before task completion');

  const adapter = new TelegramAdapter(config.telegramBotToken, config.pollTimeoutSeconds);
  const executor = new CodexExecutor({
    approvalMode: config.defaultApprovalMode,
    codexBin: config.codexBin,
  });
  const riskEvaluator = new DefaultRiskEvaluator();
  const manager = new BridgeManager(adapter, store, executor, riskEvaluator, config.allowedChatIds);

  console.log(`telegram-codex-bridge starting with ${workspaces.length} workspace(s)`);
  await manager.start();
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
