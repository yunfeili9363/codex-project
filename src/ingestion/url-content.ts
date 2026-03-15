export async function fetchReadableUrlText(url: string): Promise<string | null> {
  const candidates = [
    `https://r.jina.ai/http://${url}`,
    `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`,
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          'user-agent': 'Mozilla/5.0',
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

function normalizeReadableText(text: string): string | null {
  const cleaned = text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return null;
  if (/^error\b/i.test(cleaned)) return null;
  return cleaned.slice(0, 80_000);
}
