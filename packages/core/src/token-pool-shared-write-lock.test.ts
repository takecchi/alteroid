import { describe, expect, it } from 'vitest';

import type { Stores, TokenPoolStore } from './store.js';
import { createMemoryStores } from './testing.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createTokenPoolWriteLock } from './token-pool-write-lock.js';
import { createTokenRotator, type TokenProbePort, type TokenSpreadPort } from './token-rotator.js';

/**
 * Issue #2200 の歯。
 *
 * `TokenPoolService`（人間の `PUT /tokens` / `noteUnusable` / `noteUsable`）と
 * `TokenRotator`（`coolDown` / `finishSweep` / `recordTrialVerdict` /
 * `reconsider`）は、どちらも `TokenPoolStore.replace()`（CAS の無い全文置換）で
 * トークンの表を書く。修正前はそれぞれが自分専用の `serial()` しか持たず、
 * 別インスタンスの書き込みを待たなかったので、重なると後に書いたほうが前の
 * 変更を黙って消した（実測は Issue #2200 本文、および
 * `~/wt/alteroid-a-w15/.scratch/token-pool-cross-serial-race.test.ts` の再現）。
 *
 * ここでは `createTokenPoolWriteLock()` を1つ作って両方へ渡し、
 * （a）（c）（d）は実際の重なり方を、（b）は「読み直しが読み直した時点で
 * 古い」ことを模した重なりを使って、両方の書き込みが残ること・鍵が
 * probe の間は握られていないことを測る。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `list()` の**結果を読み取る瞬間**と**呼び出し元へ届く瞬間**をずらす。
 *
 * 実際の fs / pg の往復（読みには時間が掛かるが、読んだ内容自体は「呼んだ
 * 瞬間」の状態である）を模している。共有の鍵が無ければ、この遅延の間に
 * 相手の書き込みが完了しても、こちらは古い版を書き戻してしまう——
 * （b）はこの形で「読み直したのに古い」を作る。
 */
function delayedList(base: TokenPoolStore, delayMs: number): TokenPoolStore {
  return {
    ...base,
    list: async () => {
      const snapshot = await base.list();
      await sleep(delayMs);
      return snapshot;
    },
  };
}

describe('token-pool-service と token-rotator の共有書き込み鍵（Issue #2200）', () => {
  it('(a) 回し手が候補を probe している間に完了した PUT /tokens は、回し手の冷却と両方残る', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    // **候補（tok-b）は「使えない」と判定させる**——`finishSweep` の
    // 「保存する前に最新の一覧を読み直して、変えた行だけを id で当てる」
    // 区間（`sweep.unusableIds.length > 0` の分岐）を実際に通すため。
    // 30ms は probe が掛かる時間そのもので、その間に人間の `PUT /tokens`
    // を完了させる。
    const probe: TokenProbePort = {
      async probe() {
        await sleep(30);
        return { verdict: 'unusable', reason: 'probe が拒否した' };
      },
    };
    const spread: TokenSpreadPort = {
      async spread() {
        return [{ target: 'runner-primary', ok: true }];
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread,
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
      newId: () => 'tok-c',
    });

    const observePromise = rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **`coolDown`（tok-a を冷やす短い区間）が終わり、`sweepCandidates` が
    // tok-b を probe し始めるまで少し待つ。** ここで人間の `PUT /tokens` を
    // 起こすと、`afterCoolDown` / `sweep.tokens` はまだ3本目を知らない状態
    // （probe を始める前に読んだ2本のまま）で probe が進み、`finishSweep`
    // が保存する時点で初めて3本目と鉢合わせる——`sweep.tokens` をそのまま
    // 書き戻すと消える、まさにその形。
    await sleep(10);
    const replacePromise = poolService.replace([
      { id: 'tok-a', label: 'first', value: 'value-a' },
      { id: 'tok-b', label: 'second', value: 'value-b' },
      { label: 'third (added by human)', value: 'value-c' },
    ]);

    const [replaceResult, observeResult] = await Promise.all([replacePromise, observePromise]);
    const finalTokens = await stores.tokens.list();

    const hasThird = finalTokens.some((token) => token.id === 'tok-c');
    const aCooling = finalTokens.find((token) => token.id === 'tok-a')?.cooldownUntil !== undefined;
    const bUnusable =
      finalTokens.find((token) => token.id === 'tok-b')?.lastRejectedAt !== undefined;

    // 生の状態そのものが実測——ここに出す値を判定の代わりにしない。
    process.stderr.write(
      `[tooth a] replaceResult.kind=${replaceResult.kind} ` +
        `replaceResult.tokens.length=${String(replaceResult.kind === 'replaced' ? replaceResult.view.tokens.length : -1)} ` +
        `observeResult.kind=${observeResult.kind} ` +
        `hasThird=${String(hasThird)} aCooling=${String(aCooling)} bUnusable=${String(bUnusable)} ` +
        `finalTokens=${JSON.stringify(
          finalTokens.map((t) => ({
            id: t.id,
            cooldownUntil: t.cooldownUntil,
            lastRejectedAt: t.lastRejectedAt,
          })),
        )}\n`,
    );

    // **両方の書き込みが残る。** 人間が足した3本目も、回し手が付けた冷却も
    // （coolDown の tok-a、sweep の tok-b）、どちらも消えない。
    expect({ hasThird, aCooling, bUnusable }).toEqual({
      hasThird: true,
      aCooling: true,
      bUnusable: true,
    });
  });

  it('(b) noteUnusable（writeOne 経由）と回し手の recordTrialVerdict が重なっても両方残る', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'b', value: 'value-b', order: 1 },
    ]);

    const writeLock = createTokenPoolWriteLock();
    // **人間側（`noteUnusable`）の読み直しだけを「遅れて届く」形にする。**
    // 鍵を共有していれば、この遅れのぶん回し手の読み直しは後ろへ押し出され、
    // 回し手は人間の書き込みが終わった後の一覧から読み直すので両方残る。
    // 鍵を共有していなければ、回し手は人間の読み直しが「届く前」に自分の
    // 読み直し・書き戻しを終えてしまい、後から届く人間の書き込みが
    // （古い一覧を元にしているので）それを丸ごと踏み消す。
    const slowStores: Stores = { ...stores, tokens: delayedList(stores.tokens, 30) };

    const poolService = createTokenPoolService({
      stores: slowStores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
    });
    const rotator = createTokenRotator({
      stores,
      probe: {
        async probe() {
          return { verdict: 'usable' };
        },
      },
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });

    const notePromise = poolService.noteUnusable({
      id: 'tok-b',
      message: '人間 / probe が観測した拒否',
    });
    // **`notePromise` が鍵を掴んで（遅延の中で）寝ているあいだに**、回し手の
    // 書き込みを起こす。鍵が共有されていれば、これは `notePromise` の書き
    // 戻しが終わるまで自分の読み直しを始められない。
    await sleep(5);
    const trialPromise = rotator.recordTrialVerdict({
      tokenId: 'tok-a',
      verdict: { verdict: 'unusable', reason: 'trial が拒否した', retryAt: 1_800_000_000_000 },
    });

    const [noteResult, trialResult] = await Promise.all([notePromise, trialPromise]);
    const finalTokens = await stores.tokens.list();

    const aHasCooldown =
      finalTokens.find((token) => token.id === 'tok-a')?.cooldownUntil !== undefined;
    const bUnusable =
      finalTokens.find((token) => token.id === 'tok-b')?.lastRejectedAt !== undefined;

    process.stderr.write(
      `[tooth b] noteResult.id=${noteResult?.id ?? '(undefined)'} trialResult=${trialResult} ` +
        `aHasCooldown=${String(aHasCooldown)} bUnusable=${String(bUnusable)} ` +
        `finalTokens=${JSON.stringify(
          finalTokens.map((t) => ({
            id: t.id,
            cooldownUntil: t.cooldownUntil,
            lastRejectedAt: t.lastRejectedAt,
          })),
        )}\n`,
    );

    expect({ aHasCooldown, bUnusable }).toEqual({ aHasCooldown: true, bUnusable: true });
  });

  it('(c) 回し手が冷却を付けようとした行を、読み直しの時点で人間が消していたら作り直さない', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'b', value: 'value-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
    });
    const rotator = createTokenRotator({
      stores,
      probe: {
        async probe() {
          return { verdict: 'usable' };
        },
      },
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });

    // **先に、人間が現役（tok-a）を丸ごと消す。**（`active` の指名はそのまま
    // 残る——`replace()` は `active` に触れない。`coolDown` が読み直す時点で
    // 「降りる行がもう無い」を作るのが目的なので、ここは順序を固定してよい
    // （待ち合わせの必要が無い）。
    await poolService.replace([{ id: 'tok-b', label: 'b', value: 'value-b' }]);

    const observeResult = await rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const finalTokens = await stores.tokens.list();
    const tokAResurrected = finalTokens.some((token) => token.id === 'tok-a');

    process.stderr.write(
      `[tooth c] observeResult.kind=${observeResult.kind} tokAResurrected=${String(tokAResurrected)} ` +
        `finalTokens=${JSON.stringify(finalTokens.map((t) => t.id))}\n`,
    );

    // **消えた行を作り直さない。** 一覧には tok-b だけが残る。
    expect(tokAResurrected).toBe(false);
    expect(finalTokens.map((token) => token.id)).toEqual(['tok-b']);
  });

  it('(d) probe のあいだは鍵を握っていない（PUT /tokens が probe を待たない）', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'b', value: 'value-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    const PROBE_DELAY_MS = 300;
    const probe: TokenProbePort = {
      async probe() {
        await sleep(PROBE_DELAY_MS);
        return { verdict: 'usable' };
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
      newId: () => 'tok-c',
    });

    const observePromise = rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **`coolDown`（鍵を握る短い区間）が終わって probe に入るまで少し待つ。**
    // ここで `PUT /tokens` を起こす——probe はまだ `PROBE_DELAY_MS` 残っている。
    await sleep(20);

    const replaceStartedAt = Date.now();
    await poolService.replace([
      { id: 'tok-a', label: 'a', value: 'value-a' },
      { id: 'tok-b', label: 'b', value: 'value-b' },
      { label: 'third (added by human)', value: 'value-c' },
    ]);
    const replaceElapsedMs = Date.now() - replaceStartedAt;

    process.stderr.write(
      `[tooth d] replaceElapsedMs=${String(replaceElapsedMs)} (probe delay=${String(PROBE_DELAY_MS)}ms)\n`,
    );

    // **probe を待たされていれば、ここは 300ms 近くまで伸びる。** 鍵を
    // 握っていなければ、読み直し→書き戻しだけの短い時間で終わる。
    expect(replaceElapsedMs).toBeLessThan(PROBE_DELAY_MS / 2);

    await observePromise;
  });

  it('(e) probe の間に PUT /tokens で同じ行の value / label を変えても、回し手はそれを古い値へ戻さない', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'old-label', value: 'old-value', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    // tok-b を候補として probe し、「使えない」と判定させる——`finishSweep`
    // の保存（`unusablePatches` を id で当てる区間）を実際に通す。
    const probe: TokenProbePort = {
      async probe() {
        await sleep(30);
        return { verdict: 'unusable', reason: 'probe が拒否した' };
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
    });

    const observePromise = rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **`coolDown` が終わり、`sweepCandidates` が tok-b を probe し始めるまで
    // 少し待ってから**、人間が同じ行（tok-b）の鍵そのもの（`value`）と
    // `label` を差し替える——回し手が probe の判定を持ち帰るより先に、
    // 「読んだ後の行」を人間が書き換える形を作る。
    await sleep(10);
    await poolService.replace([
      { id: 'tok-a', label: 'a', value: 'value-a' },
      { id: 'tok-b', label: 'new-label (rotated by human)', value: 'new-value (rotated by human)' },
    ]);

    const observeResult = await observePromise;
    const finalTokens = await stores.tokens.list();
    const b = finalTokens.find((token) => token.id === 'tok-b');

    process.stderr.write(
      `[tooth e] observeResult.kind=${observeResult.kind} ` +
        `b.value=${b?.value ?? '(undefined)'} b.label=${b?.label ?? '(undefined)'} ` +
        `b.lastRejectedAt=${b?.lastRejectedAt ?? '(undefined)'}\n`,
    );

    // **差し替えた鍵・ラベルは残る。冷却も付く。** 回し手が変えてよいのは
    // 冷却関連の欄だけで、`value` / `label` を古い値へ戻してはいけない。
    expect({
      value: b?.value,
      label: b?.label,
      cooling: b?.lastRejectedAt !== undefined,
    }).toEqual({
      value: 'new-value (rotated by human)',
      label: 'new-label (rotated by human)',
      cooling: true,
    });
  });
});
