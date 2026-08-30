import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 番人テスト: `agent-events.ts` に `@anthropic-ai/claude-agent-sdk` の文字列が
 * 混ざっていないことを、ソースを直接読んで確かめる（`agent-ports.test.ts` の
 * 同じ形の番人テストと対になる）。
 *
 * **中立の語彙に SDK の型が1つでも漏れると、次の provider を足すときに
 * 「Claude の形に似せて作る」以外の選択肢が無くなる。** `import type` であっても
 * 型注釈として漏れれば同じことが起きるので、コンパイル結果ではなくソース
 * テキストそのものを検査する（`.js` へコンパイルすれば型 import は消えて
 * 見えなくなるため、`.ts` を直接読む必要がある）。
 *
 * **⚠️ これが測っているのはこのファイル1枚だけである。** ここが参照している
 * `sdk-failure.ts` / `usage-limits.ts` は SDK を import しており、依存の連鎖と
 * しては残っている（`agent-events.ts` の doc に明記した）。**「中立である」の
 * 範囲をこのテストの外へ広げて読まないこと。**
 */
describe('agent-events.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-events.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
