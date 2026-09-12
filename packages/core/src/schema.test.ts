import { describe, expect, it } from 'vitest';

import { approvalUpdatedAt, commitmentUpdatedAt, inboxEventSchema } from './schema.js';

/**
 * `manager_message` の `statusAtDelivery`（issue #870）。
 *
 * **正本は構造化欄、散文（`text`）は表示のためだけ**——`#124`（`d2ff50c`）が
 * 固定した「判定は構造化された印で行い、文言は表示にだけ使う」の踏襲
 * （`schema.ts` の `statusAtDelivery` の doc）。ここで確かめるのは2つ:
 *
 * 1. **構造化欄から `JobStatus` の値そのものが読める。** フィクスチャが
 *    与えた値（例: `'waiting_human'`）がそのまま出る——定型の飾り文を
 *    `toContain` して済ませない（それは「文言が一致した」であって
 *    「構造化欄から読めた」ではない）。
 * 2. **散文の書式が変わっても、この読み取りは壊れない。** `text` が
 *    まったく違う書式の2つの `manager_message` を用意し、`statusAtDelivery`
 *    への読み取り（`.statusAtDelivery` を直接見る）が両方で同じように
 *    成立することを見る——`text` を1文字も参照せずに済んでいることが、
 *    このアサーションの形そのもので示される。
 */
function managerMessageEvent(overrides: {
  text: string;
  statusAtDelivery?: 'running' | 'waiting_human' | 'done' | 'failed' | 'lost' | 'stopped';
}) {
  return {
    type: 'manager_message' as const,
    id: 'evt-1',
    at: '2026-09-01T00:00:00.000Z',
    managerId: 'mgr-1',
    kind: 'report' as const,
    ...overrides,
  };
}

describe('inboxEventSchema: manager_message.statusAtDelivery', () => {
  it('フィクスチャが与えた JobStatus の値そのものが構造化欄に現れる', () => {
    const parsed = inboxEventSchema.parse(
      managerMessageEvent({ text: '本文はなんでもよい', statusAtDelivery: 'waiting_human' }),
    );
    if (parsed.type !== 'manager_message') throw new Error('unreachable');
    expect(parsed.statusAtDelivery).toBe('waiting_human');
  });

  it('省略時はキー自体が付かない（既定値を作らない）', () => {
    const parsed = inboxEventSchema.parse(managerMessageEvent({ text: '本文はなんでもよい' }));
    if (parsed.type !== 'manager_message') throw new Error('unreachable');
    expect(parsed.statusAtDelivery).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, 'statusAtDelivery')).toBe(false);
  });

  it('未知の値は拒否する（jobStatusSchema と同じ6値に閉じている）', () => {
    const result = inboxEventSchema.safeParse(
      managerMessageEvent({
        text: '本文はなんでもよい',
        // @ts-expect-error -- 意図的に未知の値を渡す
        statusAtDelivery: 'not_a_real_status',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('散文（text）の書式が変わっても、statusAtDelivery の読み取りは同じ形で成立する', () => {
    // 2つの `text` はまったく別の書式——1つは実在する散文（`manager.ts` の
    // `case 'closed'` が組み立てる「この委譲は終わった（status=...)」の形）、
    // もう1つはその書式を変えた（将来の書き換えを想定した）まったく別の文。
    // どちらも `statusAtDelivery` は同じ値を持つ。
    const before = inboxEventSchema.parse(
      managerMessageEvent({
        text: '[mgr-1] この委譲は終わった（status=lost）。背景処理の完了待ちで畳んでいた報告をまとめて配る。',
        statusAtDelivery: 'lost',
      }),
    );
    const after = inboxEventSchema.parse(
      managerMessageEvent({
        text: '[mgr-1] 委譲が終了しました。積み残しの報告をまとめて送ります。',
        statusAtDelivery: 'lost',
      }),
    );
    if (before.type !== 'manager_message' || after.type !== 'manager_message') {
      throw new Error('unreachable');
    }
    // **同じ1本の式で読む。`text` は一度も参照しない。**
    const readStatus = (event: typeof before) => event.statusAtDelivery;
    expect(readStatus(before)).toBe('lost');
    expect(readStatus(after)).toBe('lost');
  });
});

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
