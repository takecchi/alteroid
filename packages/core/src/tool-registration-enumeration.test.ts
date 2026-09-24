import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, createCloneTools } from './tools.js';

/**
 * **族の歯（Issue #1397 の c25-5。元は #916 comment 25）。**
 *
 * ## 何のためにここが在るか
 *
 * `createCloneTools(context)` が `tool(...)` で実際に登録する道具の名前は、
 * 呼び出し1つ1つの1番目の引数（文字列リテラル）でしかなく、**型で
 * `CLONE_TOOL_NAMES` に縛られていない**。`CLONE_TOOL_NAMES` へ名前を1つ
 * 足しても、`createCloneTools` 側の登録を1本消し忘れても（あるいは名前を
 * 1文字間違えても）、TypeScript は1文字も怒らない——`tool()` の1番目の
 * 引数の型は `string` であって `CloneToolName` ではないため。
 *
 * 隣の `tool-description-enumeration.test.ts` は同じ関数を呼ぶが、見ているのは
 * **`CLONE_TOOL_NAMES` に載っている名前で `.find()` した後の `description`**
 * だけである（`descriptionOf()`）。名前で引いた時点で「その名前の道具が
 * 実在するか」は素通りしており、**`createCloneTools()` が返す配列の側に
 * 余分な道具が混じっていないか・`CLONE_TOOL_NAMES` の側に登録し忘れが
 * 無いかを、集合として直接突き合わせる歯はどこにも無かった**（確認手順は
 * このファイルの `describe.skip` ではなく PR 本文に書く。ここでは前提の
 * 逐語だけを残す）。
 *
 * ## 測っているもの
 *
 * - `createCloneTools(context)` が返す道具の名前の集合 と `CLONE_TOOL_NAMES`
 *   の集合が一致すること（両方向の差集合）
 * - どちらの側にも重複登録が無いこと（配列の長さと集合の大きさを比べる）
 * - 空振りでないこと（両方の集合が空でない）
 *
 * ## ⚠️ この歯が測っていないこと（正直に書く）
 *
 * - 各道具の `description` の中身・引数スキーマ・ハンドラの挙動は見ていない
 *   （そちらは `tools.test.ts` と `tool-description-enumeration.test.ts` が持つ）
 * - `CLONE_ALLOWED_TOOLS`（MCP 経由でクローンへ実際に配られる名前の一覧）との
 *   突き合わせは見ていない。ここが見るのは `createCloneTools()` の返り値と
 *   `CLONE_TOOL_NAMES` の2つだけである
 */
describe('CLONE_TOOL_NAMES と createCloneTools() の登録名', () => {
  function registeredNames(): string[] {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    return tools.map((entry) => entry.name);
  }

  it('空振りでない（CLONE_TOOL_NAMES も登録された道具も空でない）', () => {
    expect(
      CLONE_TOOL_NAMES.length,
      'CLONE_TOOL_NAMES が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(
      registeredNames().length,
      'createCloneTools() が1つも道具を返さない。この歯は何も測っていない',
    ).toBeGreaterThan(0);
  });

  it('createCloneTools() が返す道具の名前の集合は、CLONE_TOOL_NAMES の集合と一致する', () => {
    const registered = new Set(registeredNames());
    const expected = new Set<string>(CLONE_TOOL_NAMES);

    const missingFromRegistered = [...expected].filter((name) => !registered.has(name));
    const extraInRegistered = [...registered].filter((name) => !expected.has(name));

    expect(
      { missingFromRegistered, extraInRegistered },
      // 🔴 赤の意味。**名前は文字列リテラルでしか渡っておらず、型では
      // 縛られていない。ここが赤いということは、CLONE_TOOL_NAMES と
      // createCloneTools() の登録のどちらか一方だけを直して、もう一方へ
      // 追随させ忘れている。**
      // - `missingFromRegistered`（CLONE_TOOL_NAMES に在るのに未登録）:
      //   `createCloneTools` 側の `tool(...)` 呼び出しを消した／名前を
      //   打ち間違えた。追随させるなら `tool(...)` を足すか名前を直す。
      //   道具そのものを削るなら、`CLONE_TOOL_NAMES` からも消すこと
      //   （`CLONE_ALLOWED_TOOLS` など、この名簿から導出している側も
      //   合わせて確認する）。
      // - `extraInRegistered`（登録されているのに CLONE_TOOL_NAMES に無い）:
      //   `tool(...)` を新しく足したのに `CLONE_TOOL_NAMES` へ追加し忘れた。
      //   追加すること。
      `【赤の意味】\n` +
        `- CLONE_TOOL_NAMES に在るのに createCloneTools() が登録していない: ` +
        `${missingFromRegistered.length === 0 ? '(なし)' : missingFromRegistered.join(' / ')}\n` +
        `- createCloneTools() が登録しているのに CLONE_TOOL_NAMES に無い: ` +
        `${extraInRegistered.length === 0 ? '(なし)' : extraInRegistered.join(' / ')}`,
    ).toEqual({ missingFromRegistered: [], extraInRegistered: [] });
  });

  it('CLONE_TOOL_NAMES に重複が無い', () => {
    const unique = new Set<string>(CLONE_TOOL_NAMES);
    expect(
      unique.size,
      `【赤の意味】CLONE_TOOL_NAMES に同じ名前が2回以上ある` +
        `（配列の長さ ${CLONE_TOOL_NAMES.length} に対し、集合の大きさ ${unique.size}）。` +
        'どちらかを消すこと。',
    ).toBe(CLONE_TOOL_NAMES.length);
  });

  it('createCloneTools() が返す道具に重複登録が無い（同じ名前で2回 tool(...) していない）', () => {
    const names = registeredNames();
    const unique = new Set(names);
    expect(
      unique.size,
      `【赤の意味】createCloneTools() が同じ名前の道具を2回以上 tool(...) で登録している` +
        `（返り値の長さ ${names.length} に対し、名前の集合の大きさ ${unique.size}）。` +
        'MCP サーバは同名の道具を1つしか持てないので、片方が黙って消える。' +
        '重複した名前のどちらかを直すこと。',
    ).toBe(names.length);
  });
});
