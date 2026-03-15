import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { ExecutionCallbacks, ExecutionHandle, ExecutionOptions, Executor } from './bridge/interfaces.js';
import type { ApprovalMode, TaskRunRecord, WorkspaceRecord } from './bridge/types.js';

interface CodexExecutorOptions {
  approvalMode: ApprovalMode;
  codexBin?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

export class CodexExecutor implements Executor {
  constructor(private readonly options: CodexExecutorOptions) {}

  runTask(
    task: TaskRunRecord,
    workspace: WorkspaceRecord,
    callbacks?: ExecutionCallbacks,
    executionOptions?: ExecutionOptions,
  ): ExecutionHandle {
    const codexBin = resolveCodexBin(this.options.codexBin);
    const args = [
      '-a',
      this.options.approvalMode,
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      workspace.path,
      '-s',
      task.sandbox,
    ];

    if (task.model) {
      args.push('-m', task.model);
    }

    if (executionOptions?.outputSchemaPath) {
      args.push('--output-schema', executionOptions.outputSchemaPath);
    }

    for (const extraDir of workspace.allowedAdditionalDirs) {
      args.push('--add-dir', extraDir);
    }

    args.push('-');

    const child = spawn(codexBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(task.prompt);
    child.stdin.end();

    let aborted = false;
    return {
      abort() {
        aborted = true;
        child.kill('SIGTERM');
      },
      done: collectCodexResult(child, callbacks, () => aborted),
    };
  }
}

function resolveCodexBin(explicitBin?: string): string {
  const candidates = [
    explicitBin,
    process.env.CODEX_BIN,
    'codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of candidates) {
    if (candidate === 'codex') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'codex';
}

async function collectCodexResult(
  child: ChildProcessWithoutNullStreams,
  callbacks: ExecutionCallbacks | undefined,
  wasAborted: () => boolean,
): Promise<{ threadId?: string; finalMessage: string }> {
  let threadId: string | undefined;
  let finalMessage = '';
  let stderrText = '';

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

  stdout.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      return;
    }

    if (event.type === 'thread.started' && event.thread_id) {
      threadId = event.thread_id;
      callbacks?.onThreadId?.(threadId);
    }

    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
      finalMessage = event.item.text;
      callbacks?.onProgress?.(finalMessage);
    }
  });

  stderr.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    stderrText += `${trimmed}\n`;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 0));
  });

  stdout.close();
  stderr.close();

  if (wasAborted()) {
    throw new Error('Task aborted by user');
  }

  if (exitCode !== 0) {
    throw new Error(stderrText.trim() || `codex exited with code ${exitCode}`);
  }

  return {
    threadId,
    finalMessage: finalMessage || 'Codex completed without a final agent message.',
  };
}
