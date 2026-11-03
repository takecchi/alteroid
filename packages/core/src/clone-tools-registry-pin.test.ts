import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, createCloneTools } from './tools.js';

// クローンの道具の一覧（名前・並び・説明文・入力スキーマ）を、コミットした固定値（clone-tools-registry-pin.json）と丸ごと比べる。
// `tools.ts` を族ごとのファイルへ分けるとき、移しただけで何も変わっていないことを機械で確かめる歯。
// 固定値を更新するときは、意図して更新し、PR 本文に理由を書く（手で書き写さず、いまの `createCloneTools` の返り値から作り直す）。
// ハンドラの中身はここでは縛らない（ふるまいは各道具の試験が持つ）。

interface PinnedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

const PIN_URL = new URL('./clone-tools-registry-pin.json', import.meta.url);

function actualTools(): PinnedTool[] {
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return tools.map((entry) => ({
    name: entry.name,
    description: entry.description,
    // JSON を通す: undefined の欄や関数を落とし、固定値と同じ形で比べるため
    // `tool()` は入力を zod の object に包んで持つ（`strictToolInput`）。素の shape で来た場合は包む
    inputSchema: JSON.parse(
      JSON.stringify(
        z.toJSONSchema(
          '_zod' in (entry.inputSchema as object)
            ? (entry.inputSchema as unknown as z.ZodType)
            : z.object(entry.inputSchema as z.ZodRawShape),
          { io: 'input', unrepresentable: 'any' },
        ),
      ),
    ) as unknown,
  }));
}

describe('クローンの道具の一覧の固定（名前・並び・説明・入力スキーマ）', () => {
  const pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinnedTool[];

  it('空振りでない（固定値にも実際の一覧にも道具が在り、CLONE_TOOL_NAMES と本数が合う）', () => {
    expect(pinned.length, '固定値が空である。この歯は何も測っていない').toBeGreaterThan(0);
    expect(actualTools().length).toBe(pinned.length);
    expect(pinned.length).toBe(CLONE_TOOL_NAMES.length);
  });

  it('名前の並びが固定値と同じ（並びを変えると、モデルに見える tools/list の順が変わる）', () => {
    expect(actualTools().map((entry) => entry.name)).toEqual(pinned.map((entry) => entry.name));
  });

  it('道具ごとの説明文が固定値と同じ', () => {
    const actual = actualTools();
    for (const [index, entry] of pinned.entries()) {
      expect(actual[index]?.description, `${entry.name} の description`).toBe(entry.description);
    }
  });

  it('道具ごとの入力スキーマ（JSON Schema）が固定値と同じ', () => {
    const actual = actualTools();
    for (const [index, entry] of pinned.entries()) {
      expect(actual[index]?.inputSchema, `${entry.name} の inputSchema`).toEqual(
        entry.inputSchema,
      );
    }
  });

  it('一覧ぜんぶが固定値と同じ（上の個別の歯が見逃す欄の追加も拾う）', () => {
    expect(actualTools()).toEqual(pinned);
  });
});
