import { describe, it, expect } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingJournalAppend,
  humanMessage,
} from './testing.js';
import { fakeSdk, setup, wireEvents, waitFor, waitForTerminal } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

/**
 * ターンの失敗が、聞き手の有無に関わらず観測できるか。
 *
 * **ここが成り立っていることが、受信箱の消し込みの前提である**（#58）。例外で
 * 終わった合図も `#forget` してよいとしたのは「失敗が記録されているから」で、
 * `#emit` は購読者が居なければ何もしない以上、chat へ流すだけでは記録に
 * ならない。7 つある入力経路のうち `human_message` だけがそれで済ませていた。
 */
describe('クローン — ターンの失敗の跡', () => {
  /** 日誌の `exchange` を、判定に使う形だけ取り出す。 */
  async function exchanges(stores: Stores) {
    return (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
      conversationId?: string;
    }[];
  }

  it('人間が chat を閉じた後にターンが失敗しても、日誌に残る（購読者は居ない）', async () => {
    const stores = createMemoryStores();
    // `setup` が購読するのは conv-1 だけ。conv-9 には聞き手が一人も居ない
    // ＝「発言 → chat を閉じる／切断 → そのターンが失敗」と同じ形。
    const s = setup(undefined, stores, { failWith: 'セッションを起こせない' });

    s.clone.post(humanMessage('やあ', 'conv-9'));

    await waitFor(
      async () =>
        (await exchanges(stores)).some(
          (entry) => entry.role === 'outbound' && entry.text.includes('失敗した'),
        ),
      'outbound の『失敗した』という exchange が日誌に積まれる',
    );

    /*
     * **`with` の期待値を `human` から `self` へ反転させた（#92）。**
     *
     * 元の期待値は現行の欠陥を仕様として固定していた — `with: 'human'` /
     * `role: 'outbound'` で書くと `GET /conversations/:id`（`with === 'human'`
     * だけで絞る）をそのまま通り、**SDK の生の文言が「クローンの返信」として
     * 会話に並ぶ**。人間が「英語の文言だけが返信される」と訴えたのがこれである。
     *
     * **保証は弱くなっていない。** このテストが守っているのは「購読者が居なくても
     * 失敗が日誌に残る」ことと「`conversationId` が載る」ことで、どちらも下で
     * そのまま見ている。加えて `with` を絞って**特定の1件**を掴むようにしたので
     * （元は `text.includes('失敗した')` の最初の1件で、人間へ返す1行と
     * 区別できていなかった）、生の理由がどちらに載るかまで固定できている。
     */
    const all = await exchanges(stores);
    const failure = all.find(
      (entry) =>
        entry.with === 'self' &&
        entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
    );
    expect(failure).toBeDefined();
    // 呼び出し側が構造化フィールドとして持っている値は載せる（#56 の線）。
    // 落とすと、どの会話の失敗だったかを時刻でしか突き合わせられなくなる。
    expect(failure?.conversationId).toBe('conv-9');
    expect(failure?.text).toContain('セッションを起こせない');

    // 人間の側には、生の文言を含まない1行が返っている（沈黙にしない）。
    const toHuman = all.filter(
      (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
    );
    expect(toHuman).toHaveLength(1);
    expect(toHuman[0]?.conversationId).toBe('conv-9');
    expect(toHuman[0]?.text).not.toContain('セッションを起こせない');

    await s.clone.stop();
  });

  it('購読者が例外を投げても、跡は残る（`#emit` は購読側の失敗を握り潰す）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { failWith: '読み取りが即死した' });
    // 聞き手は「居る」が、受け取れない。`#emit` が握り潰すので、chat へ流した
    // ことを記録の代わりにしていると、購読者が居ないときと同じ形で消える。
    s.clone.subscribe('conv-9', () => {
      throw new Error('購読側が壊れている');
    });

    s.clone.post(humanMessage('やあ', 'conv-9'));

    await waitFor(
      async () =>
        (await exchanges(stores)).some(
          (entry) => entry.role === 'outbound' && entry.text.includes('失敗した'),
        ),
      'outbound の『失敗した』という exchange が日誌に積まれる',
    );

    await s.clone.stop();
  });

  /**
   * 文脈窓（コンテキストウィンドウ）超過の失敗だけ、日誌に目印が入るか（Issue
   * #318 P4）。**対照（当たらない失敗には入らない）も見る** — 無いと、全部の
   * 失敗に目印を付ける実装が生存する。
   */
  describe('文脈窓超過の失敗には目印が入る', () => {
    it('該当する失敗: 目印（ASCII の検索語）と生の文言の両方が `with: self` に残る', async () => {
      const stores = createMemoryStores();
      const real = 'prompt is too long: 220000 tokens > 200000 maximum';
      const s = setup(undefined, stores, { failWith: real });

      s.clone.post(humanMessage('やあ', 'conv-9'));

      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) =>
              entry.with === 'self' &&
              entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
          ),
        "with: 'self' の『人間との対話ターンが失敗した』という exchange が日誌に積まれる",
      );

      const failure = (await exchanges(stores)).find(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
      );
      // ASCII の検索語（`journal_read q=` で引ける形。条件1）。
      expect(failure?.text).toContain('context_window_failure');
      expect(failure?.text).toContain('prompt_too_long');
      // 生の文言は逐語のまま（言い換えない）。
      expect(failure?.text).toContain(real);
      // 弱さ（条件2）: 「該当した」だけでなく型合わせであることを書く。
      expect(failure?.text).toContain('契約ではない');

      // 人間へ返す1行（`with: human`）に、目印と生の文言を持ち込まない線。
      //
      // **⚠️ この歯は「人間へ返す1行は一切変わらない」を測るものではない。**
      // 測っているのは「ASCII の目印（`context_window_failure`）と生の文言が
      // 混ざらない」ことだけである。**枠で保持している回には日本語の断り1文が
      // 足される**（`CONTEXT_WINDOW_ALSO_NOTICE`。下の describe が測る）。
      //
      // **そしてこの本は `failWith` で落としているので `#usageBlocked` は立って
      // いない ＝ 2×2 の左下（枠の保持なし × 長さに当たった）である。⟹ ここは
      // 意図して変えていない側であり、この歯はその不変の対照でもある。**
      const toHuman = (await exchanges(stores)).find(
        (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
      );
      expect(toHuman?.text).not.toContain('context_window_failure');
      expect(toHuman?.text).not.toContain(real);

      await s.clone.stop();
    });

    it('対照: 文脈窓と無関係な失敗には目印が入らない', async () => {
      const stores = createMemoryStores();
      // 枠（利用上限）の失敗——紛らわしいが別の種別（`usage-limits.ts` の対象）。
      const real = "You've hit your individual spend limit";
      const s = setup(undefined, stores, { failWith: real });

      s.clone.post(humanMessage('やあ', 'conv-9'));

      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) =>
              entry.with === 'self' &&
              entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
          ),
        "with: 'self' の『人間との対話ターンが失敗した』という exchange が日誌に積まれる",
      );

      const failure = (await exchanges(stores)).find(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
      );
      expect(failure?.text).toContain(real);
      expect(failure?.text).not.toContain('context_window_failure');

      await s.clone.stop();
    });
  });

  /**
   * **文脈窓（プロンプトの長さ）で落ちたら、セッションを畳んで作り直す**
   * （#553。人間の依頼「今後発生した際に落ちないように対策」）。
   *
   * ## 何が壊れていたか
   *
   * 失敗した `result` は例外ではないので `#read` の `for await` は回り続け、
   * `#query` は非 null のまま残る。⟹ 次のターンは `#ensureQuery` の早期 return で
   * **同じセッション**へ入り、同じ長すぎる会話を持ったまま同じところで落ちる。
   * 実測（#553）: 2026-08-29〜31 に 24 件。
   *
   * ## 対照を3本置く（無いと「何でも畳む」実装が生き残る）
   *
   * 1. **長さではない失敗** —— 畳まない
   * 2. **引き継がずに開いて1度も答えていないセッション** —— 畳んでも直らないので
   *    畳まず、そう名乗る（暴走の止め）
   * 3. **`#recycleForToken` と混ざっていない** —— トークンを回すだけでは
   *    `setCloneSessionId(null)` が打たれない（＝会話が切れない）
   */
  describe('文脈窓で落ちたら、セッションを畳んで作り直す', () => {
    /** 長さで落ちる `result`（実測の (B) 群の形）。 */
    const tooLong = 'Prompt is too long';

    /**
     * 1本目を成功させ、2本目を長さで落とす。
     *
     * **1本目を成功させるのが要点である** —— `#sessionAnswered` が立たないと
     * 暴走の止めに掛かって畳まれない（対照2 がそこを押す）。**固定値のスタブに
     * しない**（`resultFor` の doc と同じ理由）。
     */
    /**
     * @param failDistill 蒸留のサイドセッションを**起こせない**形にする。
     *   **枠が閉じている回の代役である** —— 実測では長さで落ちた24件のうち9件が
     *   「長さと枠が同時」だった（`#salvageTranscript` の doc）。
     */
    function setupFold(failText: string, failDistill = false) {
      const stores = createMemoryStores();
      let failNext = false;
      const { fn, calls } = fakeSdk(undefined, {
        resultFor: () =>
          failNext ? { subtype: 'success', isError: true, text: failText } : undefined,
      });
      // **サイドセッションだけを落とす。** 本セッションの `prompt` は非同期の
      // イテレータで来るので、**文字列で来る側が蒸留である。**
      const queryFn: typeof fn = (args) => {
        if (failDistill && typeof args.prompt === 'string') throw new Error('枠が閉じている');
        return fn(args);
      };
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, stores, calls, events, failFrom: () => (failNext = true) };
    }

    /**
     * 人間へ返った最後の1行（`with: 'human'` / `outbound`）。
     *
     * **`exchanges`（この describe の親が持つ）を通す。** 日誌の読み口を自前に
     * 書き分けると、親の歯と別の並び順・別の絞り方になりうる。
     */
    async function lastToHuman(stores: Stores): Promise<string | undefined> {
      // **`#reportFailure` が書く1行だけを採る。**`with: 'human'` の outbound には
      // **クローンの発言そのもの**も載る（失敗したターンでも、出ていた本文は
      // 印を付けて残される）。⟹ 単に最後の1件を採ると、そちらを拾う。
      const rows = (await exchanges(stores)).filter(
        (entry) =>
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          (entry.text.startsWith('この発言には返せなかった') ||
            entry.text.startsWith('いま利用上限に当たっているので')),
      );
      return rows[rows.length - 1]?.text;
    }

    it('畳んで、次のターンは新しいセッションで走る。resume 素材は捨てられている', async () => {
      const s = setupFold(tooLong);

      // 1本目は成功させる（`#sessionAnswered` を立てる）。
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      // 成功した時点で session id が控えられている。
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();

      // 2本目を長さで落とす。
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      // **印と同時に resume 素材が捨てられている**（畳んだ後ではない）。
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        'resume 素材が捨てられること',
      );

      // 3本目は**新しいセッション**で走る。
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      await s.clone.stop();

      expect(s.calls.length).toBeGreaterThan(1);
    });

    it('人間へ返す1行で「記録は消えていない」と言う（会話が失われたとは言わない）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      const text = await lastToHuman(s.stores);
      await s.clone.stop();

      expect(text).toContain('次の発言から新しく開き直す');
      // **⛔ 消えていないものを消えたことにしない。**
      expect(text).toContain('消えていない');
      expect(text).not.toContain('失われ');
      // 読み直す口の名前は、クローン側の断りが持つ（ここには出さない）。
      expect(text).not.toContain('context_window_failure');
    });

    it('対照1（長さではない失敗）: 畳まない。resume 素材も残る', async () => {
      const s = setupFold('何か別の理由で落ちた');
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      const text = await lastToHuman(s.stores);
      await new Promise((resolve) => setTimeout(resolve, 80));
      // **⭐ ここが「何でも畳む」実装を殺す。**
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();
      await s.clone.stop();
      expect(text).not.toContain('次の発言から新しく開き直す');
    });

    it('対照2（暴走の止め）: 引き継がずに開いて1度も答えていないなら、畳まずにそう言う', async () => {
      const s = setupFold(tooLong);
      // **最初のターンから落とす** ⟹ `#resumedFrom === null` かつ
      // `#sessionAnswered === false` ＝ 開き直しても材料が同じ状態。
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      const text = await lastToHuman(s.stores);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await s.clone.stop();

      // 畳んでいない（＝抑止が効いている）。
      expect(text).not.toContain('次の発言から新しく開き直す');
      // **抑止したことを名乗る。** 名乗らないと外から「なぜか動かない」に見える。
      expect(text).toContain('開き直していない');
      expect(text).toContain('プロンプトそのものが収まっていない可能性');
    });

    /** 日誌の判断の1行のうち、held の後に畳み直した回（issue #955 の (A)）。 */
    async function heldEscalationLines(stores: Stores): Promise<string[]> {
      return (await exchanges(stores))
        .filter(
          (entry) =>
            entry.with === 'self' &&
            entry.text.includes('1回目の長さの失敗では開き直さずに持ちこたえた'),
        )
        .map((entry) => entry.text);
    }

    it('🔴 #955 (A) 陰性: 1回目の長さの失敗だけなら畳まない（held）。畳み直しの行も出ない', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await new Promise((resolve) => setTimeout(resolve, 80));
      // **判定は stop() の前に取る。** stop() は同じセッションで蒸留のターン
      // （reason=shutdown）を回すので、偽 SDK がそれも落とすと「別の入力での
      // 2回目」になって畳み直す——それは (A) の正しい挙動である。
      const calls = s.calls.length;
      const lines = await heldEscalationLines(s.stores);
      const sessionId = await s.stores.sessions.getCloneSessionId();
      await s.clone.stop();

      expect(calls).toBe(1);
      expect(lines).toHaveLength(0);
      // held は resume 素材を捨てない（畳んでいない）。
      expect(sessionId).not.toBeNull();
    });

    it('🔴 #955 (A) 陽性: held した同じセッションで、別の入力でもう一度長さで落ちたら畳み、日誌と人間へ1行ずつ残す', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(
        () => s.events.filter((event) => event.type === 'error').length === 1,
        '1回目が落ちること',
      );
      s.clone.post(humanMessage('二つ目'));
      await waitFor(
        () => s.events.filter((event) => event.type === 'error').length === 2,
        '2回目が落ちること',
      );

      // 畳んだ: resume 素材が捨てられ、次のターンは新しいセッションで走る。
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        'resume 素材が捨てられること',
      );
      const lines = await heldEscalationLines(s.stores);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('連続 1 回目');
      expect(lines[0]).not.toContain('収まっていない可能性');
      // 人間の発言で落ちた回は、失敗の1行に「開き直す」が載る（黙って畳まない）。
      // （`lastToHuman` は日誌の並びの都合で古い側を拾うので、在るかを直接見る。）
      expect(
        (await exchanges(s.stores)).some(
          (entry) =>
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.text.startsWith('この発言には返せなかった') &&
            entry.text.includes('次の発言から新しく開き直す'),
        ),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('三つ目'));
      await waitFor(() => s.calls.length > 1, '新しいセッションが開くこと');
      await s.clone.stop();
    });

    it('#955 (A): 内部のターンで畳み直した回も、直近の人間の会話へ1行で知らせる（黙って畳まない）', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(
        () => s.events.filter((event) => event.type === 'error').length === 1,
        '人間の発言のターンが落ちること（held）',
      );
      s.clone.post({
        type: 'external',
        id: 'evt-ext-955',
        at: new Date().toISOString(),
        source: 'ci',
        payload: 'ビルドが落ちた',
      });
      await waitFor(
        async () => (await heldEscalationLines(s.stores)).length === 1,
        '内部のターンで畳み直すこと',
      );
      const notices = (await exchanges(s.stores)).filter(
        (entry) =>
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          entry.text.startsWith('文脈が収まらずに走れなくなっていたので'),
      );
      await s.clone.stop();

      expect(notices).toHaveLength(1);
      expect(notices[0]?.conversationId).toBe('conv-1');
      expect(notices[0]?.text).toContain('記録は残っている');
    });

    it('#955 (A): 開き直したセッションもまた答えないまま同じ形で畳み直したら、回数つきで「収まっていない可能性」を名乗る', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      const errors = (n: number) => s.events.filter((event) => event.type === 'error').length === n;
      s.clone.post(humanMessage('一つ目'));
      await waitFor(() => errors(1), '1回目');
      s.clone.post(humanMessage('二つ目'));
      await waitFor(() => errors(2), '2回目（畳む）');
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('三つ目'));
      await waitFor(() => errors(3), '3回目（新しいセッションで held）');
      // **新しいセッションの1回目は、また held である**（印はセッションごとに戻る）。
      // ここでいきなり畳み直すと、held を挟まない交互になる。
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(await heldEscalationLines(s.stores)).toHaveLength(1);
      s.clone.post(humanMessage('四つ目'));
      await waitFor(() => errors(4), '4回目（また畳む）');
      await waitFor(
        async () => (await heldEscalationLines(s.stores)).length >= 2,
        '畳み直しの行が2本',
      );
      // 日誌は新しい順に並ぶので古い順へ直す。stop() の蒸留の分が増える前に取る。
      const lines = (await heldEscalationLines(s.stores)).reverse();
      await s.clone.stop();

      expect(lines[1]).toContain('連続 2 回目');
      expect(lines[1]).toContain('収まっていない可能性');
      expect(lines[1]).toContain('held と畳み直しの交互');
    });

    /**
     * **⭐ 畳む直前に、生ログが器の外へ出る**（#553 / #564）。
     *
     * ## なぜ在り処を `PostToolUse` から控えるのか
     *
     * 既存の退避（`#onPreCompact`）は在り処を `PreCompact` フックの入力から
     * 受け取っている。**⟹ compaction 自体が失敗した回（＝ここで扱う回）は
     * そのフックが走らないので、在り処が誰にも分からない。**
     * `transcript_path` は `BaseHookInput` の必須フィールドなので、**既に張って
     * ある `PostToolUse` から控えられる**（フックを増やさない）。
     *
     * ## ⚠️ この歯が測っていないこと
     *
     * **蒸留（2段目）が走ったかは測っていない。** あちらはモデルを呼ぶので、
     * 枠が閉じている回では原理的に落ちる（実測で24件中9件がその形）。**この歯が
     * 固定しているのは「退避（1段目）はモデルを呼ばないので、そちらだけは通る」
     * ことである。**
     */
    it('畳む直前に生ログを退避する（在り処は PostToolUse から控えたもの）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      // 道具を1つ使った跡を作る ＝ 在り処が控えられる。**本物と同じ経路で叩く**
      // （既存の PreCompact / PostToolUse の歯と同じ形）。
      const dir = await makeTempDir('alteroid-ctxwin-');
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

        // **退避されている。**
        await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');
        const entries = await s.stores.archive.list();
        expect(await s.stores.archive.read(entries[0]?.id as string)).toEqual({
          kind: 'body',
          body: '畳む直前の生ログ',
        });
      } finally {
        await s.clone.stop();
      }
    });

    it('対照（在り処を控えていない）: 退避を試みず、日誌にノイズも増やさない', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      // 道具を1つも使っていない ＝ 控えは空である（`#transcriptPath` の弱さ）。
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await new Promise((resolve) => setTimeout(resolve, 80));
      await s.clone.stop();

      expect(await s.stores.archive.list()).toHaveLength(0);
      // **黙って通す側へ倒してある。**「退避に失敗した」を毎回書くとノイズになる。
      const selfRows = (await exchanges(s.stores)).filter((entry) => entry.with === 'self');
      expect(selfRows.some((entry) => entry.text.includes('生ログの退避に失敗した'))).toBe(false);
    });

    /**
     * **⭐ (i) 退避が落ちても (ii) 蒸留へ進む。**
     *
     * 直す前は (i) の `catch` で `return` していた。⟹ (i) は全文を 1 本の文字列に
     * するので、生ログが伸びて `ERR_STRING_TOO_LONG` になると**蒸留も道連れで
     * 止まる**（`readTranscriptTail` の doc）。ここはその制御の流れを固定する。
     *
     * ## 測り方
     *
     * 在り処の控えは残したまま**ファイルを消す**。⟹ (i) も (ii) も読めないので、
     * **(ii) の行が日誌に在ること自体が「(i) の後に進んだ」証拠になる。**
     *
     * ## 併せて、文言が嘘にならないことも測る
     *
     * 直す前の (ii) の文言は「生ログの退避は済んでいる」と固定だった。**(i) が
     * 落ちた回にそう書くと守れない約束になる**（AGENTS.md「静かに失敗する道具」と
     * 同じ形で、読む側は残っていると信じる）。
     */
    it('退避が落ちても蒸留へ進み、日誌は「どこにも残っていない」と言う', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-gone-');
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
      await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
      // **控えは残したまま、ファイルだけを消す。** ⟹ (i) と (ii) の両方が読めない。
      await rm(dir, { recursive: true, force: true });

      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      await waitFor(
        async () =>
          (await exchanges(s.stores)).some((entry) =>
            entry.text.includes('文脈窓で畳む前の蒸留に失敗した'),
          ),
        '蒸留まで進んで、その失敗が日誌に残ること',
      );
      const rows = await exchanges(s.stores);
      expect(
        rows.some((entry) => entry.text.includes('文脈窓で畳む前の生ログの退避に失敗した')),
      ).toBe(true);
      const distillRow = rows.find((entry) =>
        entry.text.includes('文脈窓で畳む前の蒸留に失敗した'),
      );
      expect(distillRow?.text).toContain('この区間はどこにも残っていない');
      expect(distillRow?.text).not.toContain('生ログの退避は済んでいる');
      // **⭐ 墓標も立たない**（#564 E1b の限界）。退避が落ちた回は拾う材料が
      // 器の外に無いので、指す先が無い。
      expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();

      await s.clone.stop();
    });

    /**
     * **⭐ 蒸留が落ちたら、退避の id を墓標として残す**（#564 E1b）。
     *
     * ここで蒸留が落ちる主な理由は**枠が閉じていること**で、枠は待てば開く。
     * ⟹ **印が無ければ、開いた後に拾う手がかりが1つも残らない。**
     *
     * 指すのは `archive` の id であってセッション id ではない —— この時点で
     * セッション id は既に捨ててある（`TranscriptGrave` の doc）。
     */
    it('蒸留が落ちたら、退避の id を墓標として残す', async () => {
      const s = setupFold(tooLong, true);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-grave-');
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

        await waitFor(
          async () => (await s.stores.sessions.getTranscriptGrave()) !== null,
          '墓標が立つこと',
        );
        const entries = await s.stores.archive.list();
        expect((await s.stores.sessions.getTranscriptGrave())?.archiveId).toBe(entries[0]?.id);
      } finally {
        await s.clone.stop();
      }
    });

    it('対照: 蒸留が通った回は墓標を残さない', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-grave-none-');
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
        await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');

        expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();
      } finally {
        await s.clone.stop();
      }
    });

    /**
     * **⭐ 畳んだ次のターンで、クローン自身にも1度だけ断る**（#553、依頼元の決裁）。
     *
     * ## なぜ人間への1行だけでは足りないのか
     *
     * 畳んだ次のターンで、クローンは**自分が文脈を失ったことを知らない。**
     * ⟹ 読み直すべきだと気づけない。⟹ 人間には「なぜか話が通じない」として出る。
     * **落ちなくなっても、人間から見た症状はそこで残る。**
     *
     * ## 対照を2本置く
     *
     * 1. **1度だけ** —— 次のターンには載らない（毎ターン載ると文脈を食う）
     * 2. **畳んでいない失敗では載らない**
     */
    it('畳んだ次のターンで、クローン自身へ1度だけ断る（読み口の名前つき）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        '畳むと決まること',
      );

      // 畳んだ後の新しいセッションで1ターン回す。
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      const next = s.calls.at(-1) as FakeCall;
      await waitFor(() => next.inputs.length > 0, '入力が届くこと');

      const first = next.inputs[0] as string;
      expect(first).toContain('前の会話を引き継がずに開き直した');
      // **⭐ 読み直す口の名前が在る**（依頼元の条件。無いと口を探すところから始まる）。
      expect(first).toContain('conversation_read');
      // **記憶は失われていない**ことも言う（そこを混同すると同一性の話になる）。
      expect(first).toContain('記憶');

      // 対照1: **1度だけ。**次のターンには載らない。
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => next.inputs.length > 1, '2ターン目の入力が届くこと');
      await s.clone.stop();
      expect(next.inputs[1] as string).not.toContain('前の会話を引き継がずに開き直した');
    });

    it('対照（畳んでいない失敗）: クローンへの断りも載らない', async () => {
      const s = setupFold('何か別の理由で落ちた');
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      const main = s.calls[0] as FakeCall;
      const before = main.inputs.length;
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => main.inputs.length > before, '次の入力が届くこと');
      await s.clone.stop();

      expect(main.inputs.at(-1) as string).not.toContain('前の会話を引き継がずに開き直した');
    });

    it('対照3: トークンを回すだけでは resume 素材を捨てない（会話が切れない）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      s.clone.recycleSessionForToken();
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      await s.clone.stop();

      // **2つの印が混ざっていない。** 混ざると、鍵を回すだけで会話が切れる。
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();
    });
  });

  /**
   * **枠で保持していると言うとき、そのターンが長さにも当たっていたらそう言う。**
   *
   * ## なぜこの1マスだけか
   *
   * `#reportFailure` が人間へ返す1行は、（枠で保持しているか）×（文脈窓に当たったか）
   * の 2×2 になる。**嘘になっていたのは「枠で保持 × 長さにも当たった」の1マス
   * だけである** —— そこは「枠が開いたら試し直して返信する」と言い切るが、長さが
   * 同じままなら枠が開いても同じところへ落ちる ＝ 守れない約束になる。
   *
   * ## 実機の形（依頼元の実測、2026-08-29〜31 に24件。うち9件がこの形）
   *
   * ```
   * Prompt is too long · automatic compaction failed: You've hit your or…
   * ```
   *
   * **1本の文字列に両方が入っている。** CLI が見出し（`Prompt is too long`）と
   * compaction の失敗の詳細を合成しているためで、`classifyUsageNotice` は
   * `includes` で `You've hit your` に当たり、`classifyContextWindowFailure` は
   * `prompt is too long` に当たる。**⟹ 2つとも真になる。**
   *
   * ## 対照を2本置く（無いと「常に足す」実装が生き残る）
   *
   * 1. **枠で保持 × 長さではない** —— 断りが**出ない**こと
   * 2. **枠の保持なし × 長さに当たった** —— 断りが**出ない**こと（＝上の
   *    「目印が入る」の本が測っている左下のマス。**意図して変えていない側**）
   */
  describe('枠で保持していて、長さにも当たっていたら、両方言う', () => {
    /** 実機の (A) 群の形。1本の文字列に枠と長さの両方が入っている。 */
    const bothMessage =
      "Prompt is too long · automatic compaction failed: You've hit your org's monthly spend limit";
    /** 枠だけ（長さの語を含まない）。対照1 用。 */
    const usageOnlyMessage = "You've hit your individual spend limit for this account.";

    /** 直近の `toHumanAfterFailure` が読んだ行の `turnFailure` の印。 */
    let markOfLastLine: string | undefined;

    /** 失敗した `result` で1ターン落とし、人間へ返った1行を取り出す。 */
    async function toHumanAfterFailure(resultText: string): Promise<string | undefined> {
      const stores = createMemoryStores();
      const s = setup(undefined, stores, {
        resultFor: () => ({ subtype: 'success', isError: true, text: resultText }),
      });

      // **既定の会話（`conv-1`）へ出す。**`setup` が `subscribe` を張っているのは
      // そこだけなので、別の会話へ出すと `waitForTerminal` が永久に待つ。
      s.clone.post(humanMessage('やあ'));
      await waitForTerminal(s.events);
      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
          ),
        '人間への1行',
      );

      const toHuman = (await exchanges(stores)).find(
        (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
      );
      await s.clone.stop();
      markOfLastLine = toHuman?.turnFailure;
      return toHuman?.text;
    }

    it('枠で保持 × 長さにも当たった: 保持の1行に「枠が開いても落ちる」が足される', async () => {
      const toHuman = await toHumanAfterFailure(bothMessage);

      // 前半（保持している事実）は否定しない。**保持は正しい** —— compaction は
      // 本物の枠に当たっており、やめれば閉じた枠を叩き続けることになる。
      expect(toHuman).toContain('いま利用上限に当たっているので');
      expect(toHuman).toContain('枠が開いたら試し直して返信する');
      // 足す側: 長さにも当たっていることと、待つだけでは足りないこと。
      expect(toHuman).toContain('文脈窓');
      expect(toHuman).toContain('枠が開いても');
      // **⛔ ASCII の目印と生の文言は人間へ返す1行に持ち込まない**（日誌側の道具）。
      expect(toHuman).not.toContain('context_window_failure');
      expect(toHuman).not.toContain(bothMessage);
    });

    it('対照1（枠だけ）: 長さの語を含まない上限では、断りが出ない', async () => {
      const toHuman = await toHumanAfterFailure(usageOnlyMessage);

      // 保持の1行は「失敗」ではなく「保持」の印を持つ（画面が文面を見ずに見分けるため）。
      expect(markOfLastLine).toBe('held');
      expect(toHuman).toContain('枠が開いたら試し直して返信する');
      // **ここが出たら「常に足す」実装である。**
      expect(toHuman).not.toContain('文脈窓');
    });

    it('対照2（保持なし × 長さ）: 枠に当たっていない長さの失敗では、1行は変わらない', async () => {
      // 枠の文言を1つも含まない（`classifyUsageNotice` に当たらない）長さの失敗。
      const toHuman = await toHumanAfterFailure('prompt is too long: 1206750 tokens > 1000000');

      // 既存の文言のまま。**⟹ この1マスは意図して変えていない**（依頼元の判定が
      // 「2×2 の右下1マスだけ」であり、ここは範囲の外）。
      expect(toHuman).toContain('この発言には返せなかった');
      expect(toHuman).not.toContain('文脈窓');
      expect(toHuman).not.toContain('いま利用上限に当たっているので');
      // 失敗の1行は「failed」の印を持つ。文面（上）は1文字も変えていない。
      expect(markOfLastLine).toBe('failed');
    });
  });

  it('日誌にも書けなければ stderr に1行。ただし本文は出さない', async () => {
    // `#reportFailure` の `message` は `String(error)` ＝ SDK・API・ストアの
    // ドライバが決める文字列で、**こちらが値を決めていない**（ドライバは失敗した
    // クエリのパラメータを添えてくることがある）。そこを素で stderr へ出すと
    // **日誌にすら入らなかった本文がホスティング先のログには残る**（#52 の逆転）。
    // ここではその形を、秘密を含む例外で作る。
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';
    const stores = failingJournalAppend(createMemoryStores(), '器が閉じている');

    const lines = await captureStderr(async () => {
      const s = setup(undefined, stores, { failWith: `クエリが失敗した params=["${secret}"]` });
      // 失敗が `#reportFailure` まで届いたことは chat 側の `error` で見る
      // （日誌は落ちるので、そちらでは待てない）。
      const { events: seen } = wireEvents(s.clone, 'conv-9');
      s.clone.post(humanMessage('やあ', 'conv-9'));
      await waitFor(() => seen.some((event) => event.type === 'error'), 'error イベントが届く');
      await s.clone.stop();
    });

    const outbound = lines.filter(
      (line) => line.includes('日誌を記録できませんでした') && line.includes('role=outbound'),
    );
    /*
     * **件数を1から2へ変えた（#92）。** 会話のある失敗は日誌へ2件書く —
     * 生の理由（`with: 'self'`）と、人間へ返す1行（`with: 'human'`）である
     * （`#reportFailure` の doc）。器が閉じていればどちらも落ちるので跡も2行出る。
     *
     * **保証は弱くなっていない。** 守っているのは「跡は出る」「本文は出さない」で、
     * 下の3つ（理由・長さの形・秘密を含まないこと）を**全行に**課している
     * （元は `outbound[0]` だけを見ていたので、2行目が本文を漏らしても通った）。
     */
    expect(outbound).toHaveLength(2);
    for (const line of outbound) {
      // 理由だけは出す（`reasonOf` を通っている）。
      expect(line).toContain('器が閉じている');
      // 本文は出さない。長さだけ出す（「空だった」と「書けなかった」が区別できる）。
      expect(line).toMatch(/role=outbound chars=[1-9]\d*/u);
    }
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    expect(lines.join('')).not.toContain('params=');
  });
});
