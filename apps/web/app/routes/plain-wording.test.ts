import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 記憶・設定系の画面の説明文（`description=` / `subtitle=`）に、利用者に見せない語を入れない（#2782）。
 *
 * 見せない語: CLI のコマンド名（`alteroid token list` など）、API のパス（`GET /tokens` など）、
 * Issue 番号（`#1055`）、内部の識別子（`inbox_events`・`token_rotation` のような snake_case）。
 * 開発者向けの情報は、折りたたみなど詳細を開いた先に置く。
 *
 * **この歯が測っているのは、上の2つの属性に文字列リテラルで書かれた文言だけである。**
 * `{...}` の式で組む文言・JSX の本文・`title` 属性・`placeholder` は見ていない
 * （それらは各画面のテストが個別に固定している）。
 */
const SCREENS = [
  'memory',
  'memory-detail',
  'practices',
  'practice-detail',
  'commitments',
  'schedule',
  'approvals',
  'settings',
  'env-vars',
  'profile',
  'tokens',
  'mcp-servers',
  'access',
  'permissions',
  'usage',
];

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  {
    name: 'CLI のコマンド名',
    pattern: /alteroid (?:token|permission|access|credential|profile|mcp|daemon|runners)\b/,
  },
  { name: 'API のパス', pattern: /\b(?:GET|PUT|POST|PATCH|DELETE) \/[a-z]/ },
  { name: 'Issue 番号', pattern: /#\d{2,}/ },
  { name: 'snake_case の識別子', pattern: /\b[a-z]+_[a-z_]+\b/ },
];

describe('記憶・設定系の画面の説明文に内部の語を出さない（#2782）', () => {
  for (const screen of SCREENS) {
    it(`${screen}.tsx の description / subtitle`, () => {
      const source = readFileSync(
        fileURLToPath(new URL(`./${screen}.tsx`, import.meta.url)),
        'utf8',
      );
      const texts = [...source.matchAll(/\b(?:description|subtitle)="([^"]*)"/g)].map(
        (match) => match[1] ?? '',
      );
      for (const text of texts) {
        for (const { name, pattern } of FORBIDDEN) {
          expect(pattern.test(text), `${name}が説明文に出ている: ${text}`).toBe(false);
        }
      }
    });
  }
});
