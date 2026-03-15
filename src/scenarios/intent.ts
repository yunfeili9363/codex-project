export interface LightweightIntent {
  cleanText: string;
  compact: boolean;
  markdown: boolean;
  focusKeyPoints: boolean;
  focusPriority: boolean;
  focusContentAngles: boolean;
}

export function parseLightweightIntent(text: string): LightweightIntent {
  let cleanText = text.trim();
  const flags = {
    compact: false,
    markdown: false,
    focusKeyPoints: false,
    focusPriority: false,
    focusContentAngles: false,
  };

  const rules: Array<{ key: keyof typeof flags; patterns: RegExp[] }> = [
    {
      key: 'compact',
      patterns: [
        /只要最简版/gi,
        /最简版/gi,
        /简单整理一下/gi,
        /简单收一下/gi,
        /简要整理/gi,
        /轻量整理/gi,
        /简洁一点/gi,
      ],
    },
    {
      key: 'markdown',
      patterns: [
        /整理成\s*markdown/gi,
        /整理成\s*md/gi,
        /按\s*markdown\s*记下来/gi,
        /写成\s*markdown/gi,
        /markdown文档/gi,
      ],
    },
    {
      key: 'focusKeyPoints',
      patterns: [
        /顺便提炼重点/gi,
        /提炼重点/gi,
        /抓重点/gi,
        /提要一下/gi,
        /提炼核心/gi,
      ],
    },
    {
      key: 'focusPriority',
      patterns: [
        /排一下优先级/gi,
        /分一下轻重缓急/gi,
        /执行顺序/gi,
        /先后顺序/gi,
        /按优先级整理/gi,
      ],
    },
    {
      key: 'focusContentAngles',
      patterns: [
        /偏内容选题/gi,
        /适合做内容/gi,
        /选题角度/gi,
        /顺便给选题方向/gi,
      ],
    },
  ];

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(cleanText)) {
        flags[rule.key] = true;
        cleanText = cleanText.replace(pattern, ' ');
      }
    }
  }

  cleanText = cleanText
    .replace(/[，,、；;。.\s]+$/g, '')
    .replace(/^[，,、；;。.\s]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    cleanText: cleanText || text.trim(),
    ...flags,
  };
}
