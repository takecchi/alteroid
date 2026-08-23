import { describe, expect, it } from 'vitest';

import { approvalUpdatedAt, commitmentUpdatedAt } from './schema.js';

/**
 * 一覧の `updatedAt` 導出（`commitmentUpdatedAt` / `approvalUpdatedAt`）。
 *
 * MCP（`tools.ts`）・HTTP・CLI（`apps/cli/src/chat.ts`）の3面が同じ導出を
 * それぞれの実装側に書いていたのをここへ寄せた（#269 一覧の updatedAt 導出を
 * 1箇所へ）。ここで固定するのは導出そのもの（両枝）で、出力の文字列を測る
 * 歯は `tools.test.ts` の「commitment_list の作成は at・更新は closedAt ?? at」
 * が別に持っている——役割が違うので、あちらは書き換えていない。
 */
describe('commitmentUpdatedAt', () => {
  it('closedAt が無ければ at を返す（未了）', () => {
    expect(commitmentUpdatedAt({ at: '2026-01-01T00:00:00.000Z', closedAt: undefined })).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('closedAt があればそちらを返す（片付いた）', () => {
    expect(
      commitmentUpdatedAt({
        at: '2026-01-01T00:00:00.000Z',
        closedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('approvalUpdatedAt', () => {
  it('answeredAt が無ければ createdAt を返す（回答待ち）', () => {
    expect(
      approvalUpdatedAt({ createdAt: '2026-01-01T00:00:00.000Z', answeredAt: undefined }),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('answeredAt があればそちらを返す（回答済み）。この枝は tools.ts の呼び出し元からは到達しないが、ここで直接固定する', () => {
    expect(
      approvalUpdatedAt({
        createdAt: '2026-01-01T00:00:00.000Z',
        answeredAt: '2026-01-03T00:00:00.000Z',
      }),
    ).toBe('2026-01-03T00:00:00.000Z');
  });
});
