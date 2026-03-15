import fs from 'node:fs';
import path from 'node:path';

export interface InstanceLock {
  readonly path: string;
  release(): void;
}

export function acquireInstanceLock(lockPath: string): InstanceLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  clearStaleLock(lockPath);

  const fd = fs.openSync(lockPath, 'wx');
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(fd, payload, 'utf8');

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    },
  };
}

function clearStaleLock(lockPath: string): void {
  if (!fs.existsSync(lockPath)) return;

  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
      throw new Error(`已有 bridge 进程在运行（pid=${pid}）`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('已有 bridge 进程')) {
      throw error;
    }
  }

  fs.rmSync(lockPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error) {
      const code = String((error as { code?: string }).code || '');
      if (code === 'EPERM') return true;
      if (code === 'ESRCH') return false;
    }
    return false;
  }
}
