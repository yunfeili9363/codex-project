import path from 'node:path';

export function defaultVaultRoot(workspacePath: string, bindingVaultRoot: string | null): string {
  return bindingVaultRoot ? path.resolve(bindingVaultRoot) : path.join(workspacePath, 'vault');
}

export function inboxFilePath(vaultRoot: string, date: Date, title: string): string {
  const dateSegment = date.toISOString().slice(0, 10);
  const slug = slugify(title || 'capture');
  return path.join(vaultRoot, 'inbox', dateSegment, `${slug}.md`);
}

export function dailyTodoFilePath(vaultRoot: string, date: Date): string {
  const dateSegment = date.toISOString().slice(0, 10);
  return path.join(vaultRoot, 'todo-daily', `${dateSegment}.md`);
}

export function aiNewsFilePath(vaultRoot: string, date: Date): string {
  const dateSegment = date.toISOString().slice(0, 10);
  return path.join(vaultRoot, 'ai-news', `${dateSegment}.md`);
}

export function displayPath(workspacePath: string, filePath: string): string {
  const relative = path.relative(workspacePath, filePath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..')) {
    return filePath;
  }
  return relative;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'capture';
}
