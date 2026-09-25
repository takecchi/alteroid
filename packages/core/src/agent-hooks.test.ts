import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 番人テスト: `agent-hooks.ts` に `@anthropic-ai/claude-agent-sdk` の文字列が
 * 混ざっていないことを、ソースを直接読んで確かめる（`agent-events.test.ts` /
 * `agent-ports.test.ts` の同じ形の番人テストと対になる）。
 *
 * **中立の語彙に SDK の型が1つでも漏れると、次の provider を足すときに
 * 「Claude の形に似せて作る」以外の選択肢が無くなる。** `import type` で
 * あっても型注釈として漏れれば同じことが起きるので、コンパイル結果ではなく
 * ソーステキストそのものを検査する（`.js` へコンパイルすれば型 import は
 * 消えて見えなくなるため、`.ts` を直接読む必要がある）。
 *
 * **⚠️ これが測っているのはこのファイル1枚だけである。** SDK の入力を
 * この語彙へ写す処理（`toAgentToolAuditRecord` / `toAgentToolAuditFailureRecord`）
 * は `claude-provider.ts` 側にあり、そちらは SDK を import している——
 * 「中立である」の範囲をこのテストの外へ広げて読まないこと。
 */
describe('agent-hooks.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-hooks.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
