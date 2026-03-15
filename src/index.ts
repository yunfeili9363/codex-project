import { loadConfig, loadWorkspaceRegistry } from './config.js';
import { BridgeManager } from './bridge/manager.js';
import { DefaultRiskEvaluator } from './bridge/risk.js';
import { SqliteStore } from './bridge/store.js';
import { CodexExecutor } from './codex.js';
import { TelegramAdapter } from './telegram.js';
import { acquireInstanceLock } from './runtime/instance-lock.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const instanceLock = acquireInstanceLock(config.instanceLockPath);
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
  const manager = new BridgeManager(adapter, store, executor, riskEvaluator, config.allowedChatIds, config.adminUserIds);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`telegram-codex-bridge stopping: ${reason}`);
    try {
      await manager.stop();
    } finally {
      instanceLock.release();
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGHUP', () => {
    void shutdown('SIGHUP');
  });

  console.log(`telegram-codex-bridge starting with ${workspaces.length} workspace(s)`);
  try {
    await manager.start();
  } finally {
    await shutdown('main_exit');
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
