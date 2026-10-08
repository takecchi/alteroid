import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, createCloneTools } from './tools.js';

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
