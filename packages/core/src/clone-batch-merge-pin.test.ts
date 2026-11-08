import { describe, it, expect } from 'vitest';
import type { InboxEvent } from './schema.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { setup, lineStartingWith, waitFor } from './clone-test-harness.js';
import { readAtLabel } from './situation.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

// まとめ読み（`Clone` の `#mergedHumanBatch` ほか 11 メンバー）の境目を、`createClone` 越しに固定する試験。
// 切り出し（`clone-batch-merge.ts`）の前に置いた: 期待の文字列・件数は、仕様を先に書いたものではなく、
// 切り出し前の作りの出力を生成して目で読んで確かめた値である。既存の試験（`clone-manager-report-batching.test.ts` ほか）が縛っていない枝だけを足す。
// 変異（判定・上限・数え始め・保持の除外・断り書きの文言）を当てて赤くなることは、切り出しの前後の両方で確かめてある。

// 実時間で待たない（scripts/wallclock-waits-baseline.json の基準を増やさないため）: 全件が消し込まれたことを待つ
const drained = (s: Setup): Promise<void> =>
  waitFor(async () => (await s.stores.inbox.claimPending()).length === 0, '全件が消し込まれる');
const spendLimitMessage = "You've hit your individual spend limit for this account.";

const manager = (
  id: string,
  managerId: string,
  text: string,
  extra: Record<string, unknown> = {},
): InboxEvent =>
  ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
    ...extra,
  }) as InboxEvent;

const external = (id: string, source: string, payload: unknown, extra = {}): InboxEvent =>
  ({
    type: 'external',
    id,
    at: new Date().toISOString(),
    source,
    payload,
    ...extra,
  }) as InboxEvent;

const attachment = {
  id: 'att-1',
  name: 'a.png',
  mediaType: 'image/png',
  size: 3,
  sha256: 'abc',
};

describe('まとめ読みの境目の固定（切り出し前後で変えない）', () => {
  it('混合の束の予算ちょうど（47,500 字）は束に入る。1字超えると次のターンへ回る', async () => {
    const s = setup();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    // 27,500 + 20,000 = 47,500（ちょうど）→ 1 ターン。続く C（1 字）は予算を超えるので次のターン
    s.clone.post(manager('b1', 'mgr-A', `甲${'x'.repeat(27_499)}`));
    s.clone.post(manager('b2', 'mgr-B', `乙${'x'.repeat(19_999)}`));
    s.clone.post(manager('b3', 'mgr-C', '丙'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('丙')),
      'C を含むターンが投げられる',
    );
    await drained(s);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('甲');
    expect(inputs[1] ?? '').toContain('乙');
    expect(inputs[1] ?? '').not.toContain('丙');
    expect(inputs[2] ?? '').toContain('丙');
    await s.clone.stop();
  }, 15_000);

  it('同じ担当の束の本文がちょうど予算（47,500 字）のとき、本文が空の別担当の報告まで1つの混合の束に広げる', async () => {
    const s = setup();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    // 27,500 + 20,000 = 47,500（予算ちょうど）。続く本文の空の報告は 0 字なので予算に収まる
    s.clone.post(manager('e1', 'mgr-A', `甲${'x'.repeat(27_499)}`));
    s.clone.post(manager('e2', 'mgr-A', `乙${'x'.repeat(19_999)}`));
    s.clone.post(manager('e3', 'mgr-empty', ''));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('mgr-empty')),
      '空の報告を含むターンが投げられる',
    );
    await drained(s);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs[1] ?? '').toContain('甲');
    expect(inputs[1] ?? '').toContain('乙');
    await s.clone.stop();
  }, 15_000);

  it('添付を持つ external は混合の束に入らない（添付1件でも。次のターンで単独）', async () => {
    const s = setup();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(manager('a1', 'mgr-A', 'A本文'));
    s.clone.post(external('x1', 'hook', { text: '添付つき外部' }, { attachments: [attachment] }));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('添付つき外部')),
      '添付つき外部のターンが投げられる',
    );
    await drained(s);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('A本文');
    expect(inputs[1] ?? '').not.toContain('添付つき外部');
    expect(inputs[2] ?? '').toContain('添付つき外部');
    await s.clone.stop();
  }, 15_000);

  it('枠で保持した external は、同じ中身の続きと束ねない（保持した1件が単独で再試行され、続きは別の束）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(external('h1', 'token-pool', { text: '同じ中身' }));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '一件目のターンが投げられる');
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'h1');
    }, '一件目が未読として保持される');

    s.clone.post(external('h2', 'token-pool', { text: '同じ中身' }));
    s.clone.post(external('h3', 'token-pool', { text: '同じ中身' }));

    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 3, '保持した分と続きの束が投げられる');
    await drained(s);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').not.toContain('まとめて渡す');
    expect(inputs[2] ?? '').toContain('同じ中身の合図を続けて **2 件** まとめて渡す');
    await s.clone.stop();
  }, 15_000);

  it('同じ担当の報告 2 件だけ（続きなし）は、同じ担当の束の本文のまま（混合の束の本文にならない）', async () => {
    const s = setup();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(manager('p1', 'mgr-P', '同担当1本目'));
    s.clone.post(manager('p2', 'mgr-P', '同担当2本目'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('同担当2本目')),
      'まとめたターンが投げられる',
    );
    await drained(s);

    const merged = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(merged).toContain('同担当1本目');
    expect(merged).toContain('同担当2本目');
    expect(lineStartingWith(merged, '[system] マネージャー mgr-P から届いた報告を')).toBe(
      '[system] マネージャー mgr-P から届いた報告を、処理待ちのあいだに続けて **2 件** まとめて渡す（要約していない）。',
    );
    expect(merged).toContain(
      '**まとめて読んでから答えよ。** 後の報告が前の報告を補足・訂正していることがある。**最後まで読んでから判断すること。**',
    );
    expect(merged).not.toContain('起点の違う合図');
    await s.clone.stop();
  }, 15_000);

  it('上限 1: 束にならず、先頭 1 件のターンに「上限（1 件）・この束は 1 件・あと 1 件」の断り書きが載る', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '1' });
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(manager('l1', 'mgr-L', '上限1の1本目'));
    s.clone.post(manager('l2', 'mgr-L', '上限1の2本目'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('上限1の2本目')),
      '2本目のターンが投げられる',
    );
    await drained(s);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('上限1の1本目');
    expect(inputs[1] ?? '').not.toContain('上限1の2本目');
    expect(lineStartingWith(inputs[1] ?? '', '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（1 件）で切った束である（この束は 1 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );
    expect(inputs[2] ?? '').not.toContain('このターンへ束ねる合図は、上限');
    await s.clone.stop();
  }, 15_000);

  it('断り書きの全文（上限 2・3 件）: 4 行の並びと区切りが 1 字も変わらない', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });
    const before = Date.now();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(manager('t1', 'mgr-T', '全文1本目'));
    s.clone.post(manager('t2', 'mgr-T', '全文2本目'));
    s.clone.post(manager('t3', 'mgr-T', '全文3本目'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('全文3本目')),
      '3本目のターンが投げられる',
    );
    await drained(s);

    const truncated = (s.calls[0] as FakeCall).inputs[1] ?? '';
    const start = truncated.indexOf('[system] **このターンへ束ねる合図は、上限');
    const end = truncated.indexOf('---\n', start) + '---\n'.length;
    const raw = truncated.slice(start, end);
    // 時刻は「数えた時点（いま）」: 試験の前後の時刻のどちらか（秒をまたぐ回がありうる）と一致する
    const label = /(\d{2}:\d{2}:\d{2}Z) 時点/.exec(raw)?.[1];
    expect([readAtLabel(before), readAtLabel(Date.now())]).toContain(label);
    const notice = raw.replace(/\d{2}:\d{2}:\d{2}Z 時点/, '<HH:MM:SSZ> 時点');
    expect(notice).toBe(
      [
        '[system] **このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。<HH:MM:SSZ> 時点）。**同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。',
        '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
        '',
        '---',
        '',
      ].join('\n'),
    );
    await s.clone.stop();
  }, 15_000);

  it('external の束ね鍵が作れなかったときは、本文を出さずに「external の束ね鍵の計算」の跡を残す', async () => {
    const lines = await captureStderr(async () => {
      const s = setup();
      s.clone.post(humanMessage('先客'));
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

      const circular: Record<string, unknown> = { text: '循環参照の本文' };
      circular.self = circular;
      s.clone.post(external('c1', 'token-pool', circular));
      s.clone.post(external('c2', 'token-pool', circular));

      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 3, '2件とも処理される');
      await drained(s);
      await s.clone.stop();
    });

    const noted = lines.filter((line) => line.includes('external の束ね鍵の計算'));
    expect(noted.length).toBeGreaterThan(0);
    expect(noted[0]?.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/, '<時刻>')).toMatch(
      /^alteroid: <時刻> external の束ね鍵の計算を記録できませんでした（external source\.chars=10 payload=yes）: TypeError/,
    );
    for (const line of noted) expect(line).not.toContain('循環参照の本文');
  }, 15_000);
});
