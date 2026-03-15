export async function fetchReadableUrlText(url: string): Promise<string | null> {
  const normalizedUrl = normalizeUrlForMirror(url);
  if (!normalizedUrl) return null;

  const candidates = [
    `https://r.jina.ai/http://${normalizedUrl}`,
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          'user-agent': 'Mozilla/5.0',
          'accept': 'text/plain, text/markdown;q=0.9, */*;q=0.8',
          'x-return-format': 'markdown',
        },
      });
      if (!response.ok) continue;
      const text = normalizeReadableText(await response.text());
      if (text) return text;
    } catch (error) {
      console.error('[url-content] fetch failed:', error);
    }
  }

  return null;
}

function normalizeUrlForMirror(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

function normalizeReadableText(text: string): string | null {
  const cleaned = text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return null;
  if (/^error\b/i.test(cleaned)) return null;
  if (/^(?:\{|"data":)/i.test(cleaned)) return null;
  return cleaned.slice(0, 120_000);
}
