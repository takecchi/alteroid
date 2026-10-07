import { createMemoryStores, resetWorkspaceState } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { resetResponseSchema } from './openapi.js';

describe('POST /reset の応答の形', () => {
  it('⭐ `WorkspaceResetSummary` の欄が1つでも schema から落ちていたら赤くなる', async () => {
    const summary = await resetWorkspaceState(createMemoryStores());
    const schemaKeys = Object.keys(resetResponseSchema.shape.cleared.shape).sort();
    // `sessionLog` は pg 構成でだけ付き、インメモリの器では出ないので、突き合わせる側から外す。
    const expected = [...Object.keys(summary), 'sessionLog'].sort();
    expect(schemaKeys).toEqual(expected);
  });

  it('⭐ 実際に parse を通しても欄が落ちない（zod が黙って捨てる経路そのもの）', async () => {
    const cleared = await resetWorkspaceState(createMemoryStores());
    const parsed = resetResponseSchema.parse({ cleared });
    expect(Object.keys(parsed.cleared).sort()).toEqual(Object.keys(cleared).sort());
  });
});
