import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AudioTranscript {
  text: string;
  languageCode: string | null;
}

export async function transcribeAudioFile(inputFilePath: string): Promise<AudioTranscript | null> {
  const pythonBin = process.env.WHISPER_PYTHON_BIN?.trim() || 'python3';
  const whisperModel = process.env.WHISPER_MODEL?.trim() || 'turbo';
  const whisperLanguage = process.env.WHISPER_LANGUAGE?.trim() || 'auto';
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-audio-'));

  try {
    const baseName = path.basename(inputFilePath, path.extname(inputFilePath));
    const transcriptJsonPath = path.join(tempDir, `${baseName}.json`);
    const args = [
      '-m',
      'whisper',
      inputFilePath,
      '--model',
      whisperModel,
      '--output_format',
      'json',
      '--output_dir',
      tempDir,
      '--fp16',
      'False',
    ];

    if (whisperLanguage !== 'auto') {
      args.push('--language', whisperLanguage);
    }

    await execFileAsync(pythonBin, args, {
      timeout: 15 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });

    if (!fs.existsSync(transcriptJsonPath)) return null;
    const raw = await fs.promises.readFile(transcriptJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { text?: string; language?: string };
    const text = normalizeTranscript(parsed.text || '');
    if (!text) return null;

    return {
      text,
      languageCode: parsed.language?.trim() || null,
    };
  } catch (error) {
    console.error('[audio-transcript] whisper transcription failed:', error);
    return null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeTranscript(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
