import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXCHANGE_KIND_PREFIXES } from './exchange-kind.js';

const CORE_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

interface ExchangeWriteSite {
  readonly file: string;
  readonly line: number;
  readonly objectText: string;
}

function findJournalCallObjects(file: string): ExchangeWriteSite[] {
  const fullPath = path.join(CORE_SRC_DIR, file);
  const text = readFileSync(fullPath, 'utf8');
  const sites: ExchangeWriteSite[] = [];
  const callRe = /\bjournal(?:\.append)?\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const openBraceIndex = m.index + m[0].length - 1;
    const end = findMatchingBrace(text, openBraceIndex);
    if (end === -1) {
      throw new Error(
        `${file}: ${m.index} にある journal( 呼び出しの閉じ括弧が見つからない（括弧の対応が崩れている）`,
      );
    }
    const objectText = text.slice(openBraceIndex, end + 1);
    if (!/type:\s*'exchange'/.test(objectText)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    sites.push({ file, line, objectText });
  }
  return sites;
}

function findMatchingBrace(text: string, openBraceIndex: number): number {
  let depth = 0;
  let inBacktick = false;
  let templateExprDepth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (templateExprDepth > 0) {
        if (ch === '{') templateExprDepth += 1;
        else if (ch === '}') templateExprDepth -= 1;
        continue;
      }
      if (ch === '`' && prev !== '\\') {
        inBacktick = false;
        continue;
      }
      if (ch === '$' && text[i + 1] === '{') {
        templateExprDepth = 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
      continue;
    }
  }
  return -1;
}

function extractFieldValue(objectText: string, fieldName: string): string | undefined {
  const m = new RegExp(`(^|[{,\\s])${fieldName}:\\s*`).exec(objectText);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  const start = i;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inBacktick = false;
  let templateExprDepth = 0;
  let inSingle = false;
  let inDouble = false;
  for (; i < objectText.length; i += 1) {
    const ch = objectText[i];
    const prev = i > 0 ? objectText[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (templateExprDepth > 0) {
        if (ch === '{') templateExprDepth += 1;
        else if (ch === '}') {
          templateExprDepth -= 1;
        }
        continue;
      }
      if (ch === '`' && prev !== '\\') {
        inBacktick = false;
        continue;
      }
      if (ch === '$' && objectText[i + 1] === '{') {
        templateExprDepth = 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(') {
      depthParen += 1;
      continue;
    }
    if (ch === ')') {
      depthParen -= 1;
      continue;
    }
    if (ch === '[') {
      depthBracket += 1;
      continue;
    }
    if (ch === ']') {
      depthBracket -= 1;
      continue;
    }
    if (ch === '{') {
      depthBrace += 1;
      continue;
    }
    if (ch === '}') {
      if (depthBrace === 0) break;
      depthBrace -= 1;
      continue;
    }
    if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      break;
    }
  }
  return objectText.slice(start, i);
}

function isLiteralHumanWith(objectText: string): boolean {
  const withValue = extractFieldValue(objectText, 'with');
  return withValue !== undefined && withValue.trim() === "'human'";
}

function textFieldReferencesAnyPrefix(objectText: string): boolean {
  const textValue = extractFieldValue(objectText, 'text');
  if (textValue === undefined) return false;
  return EXCHANGE_KIND_PREFIXES.some(({ kind }) =>
    textValue.includes(`EXCHANGE_KIND_${kind.toUpperCase()}_PREFIX`),
  );
}

const EXPECTED_SITE_COUNT: Record<string, number> = {
  'clone.ts': 69,
  'manager.ts': 57,
};

describe('type: exchange の書き込み全箇所が kind 接頭辞を持つ（issue #1332）', () => {
  for (const file of ['clone.ts', 'manager.ts']) {
    const sites = findJournalCallObjects(file);

    it(`${file}: 実書き込み箇所の総数が${String(EXPECTED_SITE_COUNT[file])}件（テスト・doc コメント・型抽出・契約テストヘルパー・turn-input.ts は journal( 呼び出しの形を取らないので自然に除外される）`, () => {
      expect(sites.length).toBe(EXPECTED_SITE_COUNT[file]);
    });

    describe(`${file}: 各箇所が「with: 'human'（構造で応答と分かる）」か「6接頭辞のどれかを text に持つ」のどちらか`, () => {
      for (const site of sites) {
        it(`${file}:${String(site.line)}`, () => {
          if (isLiteralHumanWith(site.objectText)) {
            return;
          }
          expect(textFieldReferencesAnyPrefix(site.objectText)).toBe(true);
        });
      }
    });
  }
});

describe('exchange-kind-apply-branch: clone.ts の apply（with が self/human の条件式）', () => {
  it('self 側の分岐だけが EXCHANGE_KIND_REPLY_PREFIX を text に持つ（human 側は付けない）', () => {
    const sites = findJournalCallObjects('clone.ts');
    const applySite = sites.find((site) =>
      site.objectText.includes("turn.conversationId === null ? 'self' : 'human'"),
    );
    expect(applySite).toBeDefined();
    const textValue = extractFieldValue(applySite!.objectText, 'text');
    expect(textValue).toBeDefined();
    expect(textValue).toContain('EXCHANGE_KIND_REPLY_PREFIX');
    expect(textValue).toMatch(/turn\.conversationId === null \? EXCHANGE_KIND_REPLY_PREFIX : ''/);
  });
});
