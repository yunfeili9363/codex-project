import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoTranscript {
  platform: 'youtube';
  title: string | null;
  languageCode: string;
  transcript: string;
  source: 'captions' | 'whisper';
}

interface YoutubePlayerResponse {
  videoDetails?: {
    title?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
        name?: {
          simpleText?: string;
        };
      }>;
    };
  };
}

interface Json3TranscriptResponse {
  events?: Array<{
    segs?: Array<{
      utf8?: string;
    }>;
  }>;
}

export async function fetchVideoTranscript(url: string): Promise<VideoTranscript | null> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const html = await fetchText(watchUrl);
  const rawPlayerResponse = extractJsonObject(html, 'var ytInitialPlayerResponse = ')
    || extractJsonObject(html, 'ytInitialPlayerResponse = ');
  if (!rawPlayerResponse) return null;

  const playerResponse = JSON.parse(rawPlayerResponse) as YoutubePlayerResponse;
  const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const bestTrack = tracks.length > 0 ? [...tracks].sort(compareCaptionTracks)[0] : null;
  const captionTranscript = bestTrack?.baseUrl
    ? await fetchCaptionTranscript(bestTrack.baseUrl, bestTrack.languageCode || 'unknown')
    : null;
  if (captionTranscript) {
    return {
      platform: 'youtube',
      title: playerResponse.videoDetails?.title?.trim() || null,
      languageCode: captionTranscript.languageCode,
      transcript: captionTranscript.transcript,
      source: 'captions',
    };
  }

  const whisperTranscript = await transcribeAudioWithWhisper(url);
  if (!whisperTranscript) return null;

  return {
    platform: 'youtube',
    title: playerResponse.videoDetails?.title?.trim() || null,
    languageCode: whisperTranscript.languageCode,
    transcript: whisperTranscript.transcript,
    source: 'whisper',
  };
}

async function fetchCaptionTranscript(
  baseUrl: string,
  languageCode: string,
): Promise<{ languageCode: string; transcript: string } | null> {
  try {
    const transcriptJson = await fetchText(`${baseUrl}&fmt=json3`);
    const transcriptResponse = JSON.parse(transcriptJson) as Json3TranscriptResponse;
    const transcript = normalizeTranscript(
      (transcriptResponse.events || [])
        .flatMap(event => event.segs || [])
        .map(segment => segment.utf8 || '')
        .join(' '),
    );
    if (!transcript) return null;
    return { languageCode, transcript };
  } catch (error) {
    console.error('[video-transcript] caption fetch failed, falling back to whisper:', error);
    return null;
  }
}

function compareCaptionTracks(
  a: { languageCode?: string; kind?: string },
  b: { languageCode?: string; kind?: string },
): number {
  return scoreCaptionTrack(b) - scoreCaptionTrack(a);
}

function scoreCaptionTrack(track: { languageCode?: string; kind?: string }): number {
  const language = (track.languageCode || '').toLowerCase();
  const isManual = track.kind !== 'asr';
  let score = 0;
  if (language.startsWith('zh')) score += 100;
  if (language === 'en' || language.startsWith('en-')) score += 80;
  if (isManual) score += 20;
  return score;
}

function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v');
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/')[2] || null;
      }
    }
  } catch {}
  return null;
}

async function transcribeAudioWithWhisper(url: string): Promise<{ languageCode: string; transcript: string } | null> {
  const ytDlpBin = process.env.YT_DLP_BIN?.trim() || 'yt-dlp';
  const pythonBin = process.env.WHISPER_PYTHON_BIN?.trim() || 'python3';
  const whisperModel = process.env.WHISPER_MODEL?.trim() || 'turbo';
  const whisperLanguage = process.env.WHISPER_LANGUAGE?.trim() || 'auto';
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-video-'));

  try {
    const outputTemplate = path.join(tempDir, 'audio.%(ext)s');
    await execFileAsync(ytDlpBin, [
      '--no-playlist',
      '--extract-audio',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--output',
      outputTemplate,
      url,
    ], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });

    const audioFile = findFirstFile(tempDir, /^audio\./);
    if (!audioFile) return null;

    const transcriptJsonPath = path.join(tempDir, `${path.basename(audioFile, path.extname(audioFile))}.json`);
    const args = [
      '-m',
      'whisper',
      audioFile,
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
      timeout: 30 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });

    if (!fs.existsSync(transcriptJsonPath)) return null;
    const raw = await fs.promises.readFile(transcriptJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { text?: string; language?: string };
    const transcript = normalizeTranscript(parsed.text || '');
    if (!transcript) return null;

    return {
      languageCode: String(parsed.language || whisperLanguage || 'unknown'),
      transcript,
    };
  } catch (error) {
    console.error('[video-transcript] whisper fallback failed:', error);
    return null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function extractJsonObject(html: string, marker: string): string | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const objectStart = html.indexOf('{', markerIndex + marker.length);
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}

function normalizeTranscript(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .trim();
}

function findFirstFile(directory: string, pattern: RegExp): string | null {
  for (const entry of fs.readdirSync(directory)) {
    if (pattern.test(entry)) {
      return path.join(directory, entry);
    }
  }
  return null;
}
