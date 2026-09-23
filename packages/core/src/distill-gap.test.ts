import { describe, expect, it } from 'vitest';

import {
  countsAsUndistilledActivity,
  deriveDistillGapFromJournal,
  distillSucceededEntry,
} from './distill-gap.js';
import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import type { JournalEntry } from './schema.js';

/**
 * `countsAsUndistilledActivity` の allowlist を直に当てる単体の歯。
 *
 * **`clone.test.ts` の「クローン — 蒸留が間に合わなかった区間の検出」は、
 * クローンのループ全体を通した end-to-end の歯を持つが、`token_rotation` /
 * `subagent_stall` のように「器の記帳であって数えない」型を単独で
 * 押す歯は無い。** ここでは `deriveDistillGapFromJournal` の下請けである
 * `countsAsUndistilledActivity` へ直に当て、allowlist に無い型が `false` を
 * 返すことを固定する（Issue #357 — `subagent_stall` を足したとき、
 * `distill-gap.ts` の switch に `case 'subagent_stall': return false;` を
 * 明示で足した。その決定を検算する）。
 */
describe('countsAsUndistilledActivity（allowlist の外は false）', () => {
  it('subagent_stall は「まだ記憶へ移っていない活動」に数えない（器の記帳）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'j-1',
      at: '2026-09-06T00:00:00.000Z',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: '起こし直した（1回目 / 上限 2）。',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  it('subagent_stall（limit_reached）も同様に false（outcome で分岐しない）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'j-2',
      at: '2026-09-06T00:00:00.000Z',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 2,
      outcome: 'limit_reached',
      text: '起こし直さなかった。',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  // **対照。** allowlist に在る型は今までどおり数える——この歯だけで
  // 「何を渡しても false を返す壊れた実装」に強くならないようにする。
  it('（対照）exchange with!==self は数える', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'j-3',
      at: '2026-09-06T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: '人間からの発言',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(true);
  });
});

/**
 * OOM の本体を直す（issue #1283）の `distill-gap.ts` 側。**ここは打ち切りを
 * 導入しない**——`deriveDistillGapFromJournal` が直す前と1文字も違わない
 * 結果を返しながら、日誌ストアへ渡る `limit` だけが有限になることを測る。
 *
 * `createSyntheticJournalStore`（`journal-scan.test-support.ts`）は、有限の
 * `limit` が渡らないとその場で例外を投げる偽物——本番の穴
 * （`grep -Fn -- 'query.limit ?? Number.MAX_SAFE_INTEGER' packages/storage-pg/src/journal.ts`）
 * と同じ形をここでも再現させない。
 */
describe('OOM の本体を直す（issue #1283）— distill-gap の走査をページ単位に有界化する', () => {
  it('⭐ 活動が大量に在っても activityCount は正確なまま、偽ストアへ渡る limit は常に有限で、渡った総件数は活動の件数に比例した量で頭打ちになる（打ち切りは導入しない）', async () => {
    const activityCount = JOURNAL_SCAN_PAGE_SIZE * 6 + 37;
    // marker（印）はいちばん古い（index === activityCount）行1本だけ。
    // index 0..activityCount-1 は印より新しい「まだ記憶へ移っていない活動」
    // （exchange, with: 'manager' — `with !== 'self'` なので数える）。
    const total = activityCount + 1;
    const baseTimeMs = Date.now();
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs,
      entryAt: (index) =>
        index === activityCount
          ? distillSucceededEntry('shutdown')
          : { type: 'exchange', with: 'manager', role: 'outbound', text: `activity-${index}` },
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    expect(gap).not.toBeNull();
    // **見つかる結果は直す前と同一——打ち切りは導入していない。**
    expect(gap!.window).toBe('since_last_distill');
    expect(gap!.activityCount).toBe(activityCount);
    expect(gap!.lastDistilledAt).toBe(fake.entryOf(activityCount).at);
    expect(gap!.lastActivityAt).toBe(fake.entryOf(0).at);
    expect(gap!.firstActivityAt).toBe(fake.entryOf(activityCount - 1).at);

    // **全呼び出しが有限の limit を持つ**（印を探す枝・活動を数える枝の
    // どちらも）。
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(Number.isFinite(call.limit)).toBe(true);
      expect(call.limit).toBeGreaterThan(0);
      expect(call.limit).toBeLessThanOrEqual(JOURNAL_SCAN_PAGE_SIZE);
    }

    // **偽ストアが渡した総件数が、活動の件数（＋印1件）に比例した量で
    // 頭打ちになる。** ヒープへ載る量がページの大きさに抑えられていることの
    // 代理指標——「見つけるまで無制限に読み続ける」設計であっても、実際に
    // 読むのは「必要な分だけ」であることをここで示す。
    expect(fake.totalReturned).toBe(activityCount + 1);
  });

  it('印を探す枝は、最初に当たった行で止まる（後ろに大量のノイズが在っても読み切らない）', async () => {
    // 印（index 0＝いちばん新しい行）の**後ろ**（古い側）に、印ではない
    // decision 行を大量に積む——desc で走査する印探しの枝が「見つけた
    // 時点で止まる」を守っていなければ、この偽ストアへ渡る総件数が
    // `noiseCount` 近くまで膨らむ。
    const noiseCount = JOURNAL_SCAN_PAGE_SIZE * 4;
    const total = noiseCount + 1;
    const baseTimeMs = Date.now();
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs,
      entryAt: (index) =>
        index === 0
          ? distillSucceededEntry('shutdown')
          : { type: 'decision', decision: `noise-${index}`, grounds: 'g' },
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    // 印がいちばん新しい行なので、印より後ろ（新しい側）に活動は無い——
    // ずれは無い。
    expect(gap).toBeNull();

    // **印を探す枝は、印を含む最初の1ページで止まる。** `noiseCount`
    // （ページの大きさの4倍）件の非印 decision が後ろに積まれていても、
    // 偽ストアへ渡った総件数はページ1枚ぶん（`JOURNAL_SCAN_PAGE_SIZE`）を
    // 超えない——「見つけた時点で止まる」が壊れて後ろの3ページぶんまで
    // 読みに行けば、この上限を確実に超える。
    expect(fake.totalReturned).toBeLessThanOrEqual(JOURNAL_SCAN_PAGE_SIZE);
    expect(fake.totalReturned).toBeLessThan(total);
  });
});
