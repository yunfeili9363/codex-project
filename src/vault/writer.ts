import fs from 'node:fs';
import path from 'node:path';

export class VaultWriter {
  async writeMarkdown(filePath: string, content: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  async appendMarkdown(filePath: string, content: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, 'utf8').trimEnd();
      const next = current ? `${current}\n\n---\n\n${content.trim()}\n` : `${content.trim()}\n`;
      fs.writeFileSync(filePath, next, 'utf8');
      return filePath;
    }

    fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
    return filePath;
  }

  async appendNumberedTodo(filePath: string, itemText: string): Promise<{ filePath: string; index: number; items: string[] }> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const normalizedItem = itemText.trim();
    const header = '# 待办清单';

    if (!fs.existsSync(filePath)) {
      const initial = `${header}\n\n1. ${normalizedItem}\n`;
      fs.writeFileSync(filePath, initial, 'utf8');
      return { filePath, index: 1, items: [normalizedItem] };
    }

    const current = fs.readFileSync(filePath, 'utf8');
    const currentItems = parseNumberedTodoItems(current);
    const nextIndex = currentItems.length + 1;
    const separator = current.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(filePath, `${current}${separator}${nextIndex}. ${normalizedItem}\n`, 'utf8');
    return { filePath, index: nextIndex, items: [...currentItems, normalizedItem] };
  }

  async readNumberedTodos(filePath: string): Promise<string[]> {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    return parseNumberedTodoItems(fs.readFileSync(filePath, 'utf8'));
  }
}

function parseNumberedTodoItems(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map(line => {
      const match = /^\d+\.\s+(.+)$/.exec(line.trim());
      return match?.[1]?.trim() || '';
    })
    .filter(Boolean);
}
