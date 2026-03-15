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
}
