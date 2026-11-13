import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSdk, setup, waitFor, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// `Clone` の「失敗側」の文面・判定（`#reportFailure` の人間へ返す 1 行・失敗の日誌行・拒否の判定と日誌、
// `#noteHeldEscalation`・`#noteUnproductiveUsageBlockFold` の日誌）を、`createClone` 経由で逐語に固定する。
// 日誌の `exchange`（`with` が `self` / `human` の outbound）を、書かれた順のまま全文で観測する。
// 期待の文字列は仕様を先に書いたものではない: 今の作りの出力を `vitest -u` で生成し、目で読んで確かめたものを置いている。
// 「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 既存の `clone-session-refusal.test.ts`・`clone-turn-failure-trace.test.ts`・`clone-quota-*.test.ts` は
// 大半が `toContain` / `startsWith` で一部だけを縛るので、ここで全文を縛る（枝は各 describe の冒頭に書く）。
// 時刻の入る文面（待ち行列の見出し）が入力の文字数を動かすので、`Date` だけを止める（タイマーは本物のまま）。

const FROZEN_AT = '2026-11-01T09:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

interface Row {
  with: string;
  role: string;
  text: string;
  conversationId?: string;
  turnFailure?: string;
  turnFailureKind?: string;
}

/**
 * 失敗側の記録だけを、書かれた順に 1 行ずつ文字列にする。`self` は `[障害]` `[判断]` `[間引き]` の接頭辞のもの、
 * `human` は人間へ返した 1 行（`turnFailure` を持つもの、または拒否・開き直しの知らせ）。
 * 開き直し本体（`reopenSession`）の日誌行・人間の発言の控えは、別の塊の文面なので外す。
 */
async function trace(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['exchange'] })) as Row[];
  const out: string[] = [];
  // `journal.list` は新しい順に返すので、書かれた順（古い順）へ直す
  for (const row of [...rows].reverse()) {
    if (row.role !== 'outbound') continue;
    const where = row.conversationId === undefined ? 'internal' : row.conversationId;
    if (row.with === 'self') {
      if (!/^\[(障害|判断|間引き)\] /.test(row.text)) continue;
      if (row.text.includes('クローンの自動判定でセッションを開き直すと決めた')) continue;
      // 受信箱から合図を外した記録（`#forget` 側。別の塊）
      if (row.text.startsWith('[判断] ターンが枠以外の理由で失敗したので')) continue;
      out.push(`self@${where} | ${row.text}`);
    } else if (row.with === 'human') {
      if (row.turnFailure === undefined && !/安全分類器|自動の開き直し/.test(row.text)) continue;
      const mark =
        row.turnFailure === undefined
          ? ''
          : ` {turnFailure=${row.turnFailure}, kind=${row.turnFailureKind ?? '-'}}`;
      out.push(`human@${where}${mark} | ${row.text}`);
    }
  }
  return out;
}

const countOf = async (stores: Stores, prefix: string): Promise<number> =>
  (await trace(stores)).filter((line) => line.includes(prefix)).length;

function errorsOf(s: { readonly events: Setup['events'] }): number {
  return s.events.filter((event) => event.type === 'error').length;
}

describe('人間へ返す失敗の 1 行（humanText）と失敗の日誌行の逐語固定', () => {
  // 枝: 通常の失敗 / 枠で保持 / 枠 × 長さ / 長さ（held・畳む・畳み直し）/ 内部ターン
  async function failOnce(resultText: string): Promise<Stores> {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: () => ({ subtype: 'success', isError: true, text: resultText }),
    });
    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    await waitFor(async () => (await countOf(stores, 'human@')) >= 1, '人間への 1 行');
    await s.clone.stop();
    return stores;
  }

  // 失敗のあとに受信箱へ戻った合図の内部ターンが、`stop()` との競合で出たり出なかったりするので、人間への 1 行までを採る
  async function upToFirstHumanLine(stores: Stores): Promise<string[]> {
    const lines = await trace(stores);
    return lines.slice(0, lines.findIndex((line) => line.startsWith('human@')) + 1);
  }

  it('通常の失敗（枠なし・長さなし・拒否なし）: 「この発言には返せなかった」', async () => {
    const stores = await failOnce('何か別の理由で落ちた');

    expect(await upToFirstHumanLine(stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / 何か別の理由で落ちた",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
      ]
    `);
  });

  it('枠で保持（利用上限）: 「いま利用上限に当たっているので」。turnFailure は held・kind は quota', async () => {
    const stores = await failOnce("You've hit your individual spend limit for this account.");

    expect(await upToFirstHumanLine(stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / You've hit your individual spend limit for this account.",
        "human@conv-1 {turnFailure=held, kind=quota} | いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。",
      ]
    `);
  });

  it('枠 × 長さ: 保持の 1 行に「枠が開いても落ちる」が足され、失敗の日誌行には文脈窓の目印が付く', async () => {
    const stores = await failOnce(
      "Prompt is too long · automatic compaction failed: You've hit your org's monthly spend limit",
    );

    expect(await upToFirstHumanLine(stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long · automatic compaction failed: You've hit your org's monthly spend limit（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
        "human@conv-1 {turnFailure=held, kind=quota} | いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。⚠️ ただし、このターンは文脈窓（プロンプトの長さ）にも当たっている。⟹ 枠が開いても、長さが同じままなら同じところで落ちる。待つだけでは返せない可能性がある（詳しい理由は日誌に残してある）。⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。⟹ プロンプトそのものが収まっていない可能性がある。",
      ]
    `);
  });

  it('保持なし × 長さ（セッションが未だ答えていない）: held（畳まない）。1 行は「開き直していない」', async () => {
    const stores = await failOnce('prompt is too long: 1206750 tokens > 1000000');

    expect(await upToFirstHumanLine(stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / prompt is too long: 1206750 tokens > 1000000（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。⟹ プロンプトそのものが収まっていない可能性がある。",
      ]
    `);
  });

  describe('長さで落ちる（#955 の held・畳み直し）', () => {
    const tooLong = 'Prompt is too long';

    function setupFold() {
      const stores = createMemoryStores();
      let failNext = false;
      const { fn, calls } = fakeSdk(undefined, {
        resultFor: () =>
          failNext ? { subtype: 'success', isError: true, text: tooLong } : undefined,
      });
      const clone = createClone({
        stores,
        queryFn: fn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, stores, calls, events, failFrom: () => (failNext = true) };
    }

    it('答えた後のセッションが長さで落ちる: 畳む。1 行は「次の発言から新しく開き直す」。畳み直しの日誌は出ない（答えているので held ではない）', async () => {
      const s = setupFold();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1 本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2 本目が落ちること');
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        'resume 素材が捨てられること',
      );
      await waitFor(async () => (await countOf(s.stores, 'human@')) === 1, '人間への 1 行');
      await s.clone.stop();

      expect(await trace(s.stores)).toMatchInlineSnapshot(`
        [
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。この会話はここで一区切りにして、次の発言から新しく開き直す。⚠️ それまでのやりとりは消えていない（記録は残っている）が、私はその続きを覚えていない状態で始まるので、必要なら読み直す。",
        ]
      `);
    });

    it('held の後にもう一度: 畳み直し（連続 1 回目）の日誌行が [判断] で出る。1 行は「次の発言から新しく開き直す」', async () => {
      const s = setupFold();
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(() => errorsOf(s) === 1, '1 回目（held）');
      s.clone.post(humanMessage('二つ目'));
      await waitFor(() => errorsOf(s) === 2, '2 回目（畳む）');
      await waitFor(async () => (await countOf(s.stores, '連続 1 回目')) === 1, '畳み直しの日誌行');
      await waitFor(async () => (await countOf(s.stores, 'human@')) === 2, '人間への 2 行目');
      await s.clone.stop();

      expect(await trace(s.stores)).toMatchInlineSnapshot(`
        [
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。⟹ プロンプトそのものが収まっていない可能性がある。",
          "self@internal | [判断] 会話を引き継がずに開いたこのセッションは、1度も答えを返せないまま、1回目の長さの失敗では開き直さずに持ちこたえた（held）が、別の入力でもう一度同じ長さで落ちた。⟹ 拒まれた入力がセッションに残って送り直されている可能性があるので、ここで畳んで新しいセッションで開き直す（issue #955。答えを返せないままの畳み直しは連続 1 回目）。",
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。この会話はここで一区切りにして、次の発言から新しく開き直す。⚠️ それまでのやりとりは消えていない（記録は残っている）が、私はその続きを覚えていない状態で始まるので、必要なら読み直す。",
        ]
      `);
    });

    it('開き直したセッションもまた答えないまま畳み直す: 連続 2 回目に「収まっていない可能性」が付く', async () => {
      const s = setupFold();
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(() => errorsOf(s) === 1, '1 回目');
      s.clone.post(humanMessage('二つ目'));
      await waitFor(() => errorsOf(s) === 2, '2 回目（畳む）');
      await waitFor(async () => (await countOf(s.stores, 'human@')) === 2, '人間への 2 行目');
      s.clone.post(humanMessage('三つ目'));
      await waitFor(() => errorsOf(s) === 3, '3 回目（新しいセッションで held）');
      await waitFor(async () => (await countOf(s.stores, 'human@')) === 3, '人間への 3 行目');
      s.clone.post(humanMessage('四つ目'));
      await waitFor(() => errorsOf(s) === 4, '4 回目（また畳む）');
      await waitFor(
        async () => (await countOf(s.stores, '連続 2 回目')) === 1,
        '畳み直しの日誌行が 2 本目',
      );
      await waitFor(async () => (await countOf(s.stores, 'human@')) === 4, '人間への 4 行目');
      await s.clone.stop();

      expect(await trace(s.stores)).toMatchInlineSnapshot(`
        [
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。⟹ プロンプトそのものが収まっていない可能性がある。",
          "self@internal | [判断] 会話を引き継がずに開いたこのセッションは、1度も答えを返せないまま、1回目の長さの失敗では開き直さずに持ちこたえた（held）が、別の入力でもう一度同じ長さで落ちた。⟹ 拒まれた入力がセッションに残って送り直されている可能性があるので、ここで畳んで新しいセッションで開き直す（issue #955。答えを返せないままの畳み直しは連続 1 回目）。",
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。この会話はここで一区切りにして、次の発言から新しく開き直す。⚠️ それまでのやりとりは消えていない（記録は残っている）が、私はその続きを覚えていない状態で始まるので、必要なら読み直す。",
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。⟹ プロンプトそのものが収まっていない可能性がある。",
          "self@internal | [判断] 会話を引き継がずに開いたこのセッションは、1度も答えを返せないまま、1回目の長さの失敗では開き直さずに持ちこたえた（held）が、別の入力でもう一度同じ長さで落ちた。⟹ 拒まれた入力がセッションに残って送り直されている可能性があるので、ここで畳んで新しいセッションで開き直す（issue #955。答えを返せないままの畳み直しは連続 2 回目）。 ⚠ 開き直した新しいセッションも、1度も答えないまま同じ形で落ちている。システムプロンプトや記憶の焼き込みそのものが文脈窓に収まっていない可能性がある（held と畳み直しの交互）。",
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。この会話はここで一区切りにして、次の発言から新しく開き直す。⚠️ それまでのやりとりは消えていない（記録は残っている）が、私はその続きを覚えていない状態で始まるので、必要なら読み直す。",
        ]
      `);
    });

    it('内部のターン（会話なし）で畳み直した回: 「内部ターンが失敗した」と畳み直しの日誌だけで、人間への行は無い', async () => {
      const s = setupFold();
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(() => errorsOf(s) === 1, '人間の発言のターンが落ちること（held）');
      s.clone.post({
        type: 'external',
        id: 'evt-ext-955',
        at: FROZEN_AT,
        source: 'ci',
        payload: 'ビルドが落ちた',
      });
      await waitFor(
        async () => (await countOf(s.stores, '連続 1 回目')) === 1,
        '内部のターンで畳み直すこと',
      );
      await waitFor(
        async () => (await countOf(s.stores, '[障害] 内部ターンが失敗した')) >= 1,
        '内部ターンの失敗の行',
      );
      await s.clone.stop();

      expect(await trace(s.stores)).toMatchInlineSnapshot(`
        [
          "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
          "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。⟹ プロンプトそのものが収まっていない可能性がある。",
          "self@internal | [判断] 会話を引き継がずに開いたこのセッションは、1度も答えを返せないまま、1回目の長さの失敗では開き直さずに持ちこたえた（held）が、別の入力でもう一度同じ長さで落ちた。⟹ 拒まれた入力がセッションに残って送り直されている可能性があるので、ここで畳んで新しいセッションで開き直す（issue #955。答えを返せないままの畳み直しは連続 1 回目）。",
          "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: success（result_is_error） / Prompt is too long（文脈窓（コンテキストウィンドウ）に当たった可能性がある: context_window_failure kind=prompt_too_long。⚠️ この判定は文言の型合わせであって契約ではない — 新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が「文脈窓ではない」とも限らない）",
        ]
      `);
    });
  });
});

describe('枠で保持している間の、畳まれた 1 行（[間引き]）と、枠に当たり続けた畳みの逐語固定', () => {
  const spendLimit = "You've hit your individual spend limit for this account.";

  it('[間引き]: 同じ 1 行を既に返してあれば畳み、何件目かと同じ 1 行を日誌（self）へ残す', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimit }),
    });
    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    await waitFor(async () => (await countOf(s.stores, '[障害] ')) === 1, '1 件目の失敗');
    s.clone.post(humanMessage('二件目'));
    await waitFor(
      async () => (await countOf(s.stores, '[障害] ')) === 3,
      '一件目の再試行と二件目の短絡',
    );
    s.clone.post({ type: 'self_initiative', id: 'evt-tick-1', at: FROZEN_AT, reason: '定期 tick' });
    await waitFor(
      async () => (await countOf(s.stores, '[障害] ')) === 5,
      'tick で保持分が試し直される',
    );
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / You've hit your individual spend limit for this account.",
        "human@conv-1 {turnFailure=held, kind=quota} | いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。",
        "self@internal | [間引き] 枠の解除を試す。新しい合図が届いたので、保持していた 1 件を配り直す。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / You've hit your individual spend limit for this account.",
        "human@conv-1 {turnFailure=held, kind=quota} | いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 枠が閉じているので、いまは投げていない。合図は保持してある。次に別の合図が届いたとき、保持した分から順に試し直す（利用上限に当たった。この文言で仕事が止まっている: You've hit your individual spend limit for this account.）",
        "self@conv-1 | [間引き] 人間へ返す1行は畳んだ（最後に返した1行から数えて 1 件目）。同じ1行を既に返してあり、そのあと人間からの新しい発言は届いていない: いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。",
        "self@internal | [間引き] 枠の解除を試す。新しい合図が届いたので、保持していた 2 件を配り直す。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / You've hit your individual spend limit for this account.",
        "self@conv-1 | [間引き] 人間へ返す1行は畳んだ（最後に返した1行から数えて 2 件目）。同じ1行を既に返してあり、そのあと人間からの新しい発言は届いていない: いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 枠が閉じているので、いまは投げていない。合図は保持してある。次に別の合図が届いたとき、保持した分から順に試し直す（利用上限に当たった。この文言で仕事が止まっている: You've hit your individual spend limit for this account.）",
        "self@conv-1 | [間引き] 人間へ返す1行は畳んだ（最後に返した1行から数えて 3 件目）。同じ1行を既に返してあり、そのあと人間からの新しい発言は届いていない: いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。",
      ]
    `);
  });

  describe('枠に当たったまま 1 度も答えず、積んだ入力が閾値（200,000 字）に達した畳み', () => {
    const BIG_BODY = 'x'.repeat(90_000);
    // id を明示する（`humanMessage` の id は本文から作られ、9 万字になるため）
    const bigMessage = (id: string): InboxEvent => ({ ...humanMessage(BIG_BODY), id });
    const tick = (id: string): InboxEvent => ({
      type: 'self_initiative',
      id,
      at: FROZEN_AT,
      reason: 'テスト用tick',
    });

    async function releaseAttempts(stores: Stores): Promise<number> {
      const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.filter((entry) => entry.text.includes('枠の解除を試す')).length;
    }

    async function drive(ticks: number): Promise<Setup> {
      const stores = createMemoryStores();
      const s = setup(undefined, stores, {
        resultSubtype: 'error_during_execution',
        resultText: spendLimit,
      });
      s.clone.post(bigMessage('evt-big-1'));
      await waitFor(() => s.clone.usageBlocked, '1 回目で枠に当たって保持される');
      for (let i = 1; i <= ticks; i += 1) {
        s.clone.post(tick(`evt-si-${String(i)}`));
        await waitFor(
          async () => (await releaseAttempts(stores)) === i,
          `解除の試行が ${String(i)} 回`,
        );
        await waitFor(() => s.clone.usageBlocked, `再試行 ${String(i)} 回目もまた枠に当たる`);
      }
      return s;
    }

    it('閾値の手前（2 本ぶん）: 畳みの日誌行は出ない', async () => {
      const s = await drive(1);
      await s.clone.stop();

      const lines = await trace(s.stores);
      expect(lines.filter((line) => line.includes('Issue #1240'))).toEqual([]);
    });

    it('閾値超え（3 本ぶん）: [判断] の日誌行（積んだ文字数・閾値）と、1 行の「理由は文脈窓ではなく、枠」', async () => {
      const s = await drive(2);
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        '積算が閾値を超え、resume 素材が捨てられる',
      );
      await s.clone.stop();

      const lines = await trace(s.stores);
      expect(lines.filter((line) => line.includes('Issue #1240'))).toMatchInlineSnapshot(`
        [
          "self@internal | [判断] 枠に当たったまま1度も答えを返せないうちに、積んだ入力が 274434 文字（閾値 200000）に達した。同じセッションへ積み続けると枠が開いた頃には文脈が伸びきっているので、ここでセッションを畳んで作り直す（Issue #1240）。",
        ]
      `);
      expect(
        lines.filter((line) => line.startsWith('human@') && line.includes('理由は文脈窓ではなく')),
      ).toMatchInlineSnapshot(`
        [
          "human@conv-1 {turnFailure=held, kind=quota} | いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。この会話はここで一区切りにして、次の発言から新しく開き直す。⚠️ 理由は文脈窓ではなく、枠（利用上限）に当たったまま1度も答えを返せずに再試行を繰り返しているため——同じセッションへ積み続けると、枠が開いたときには文脈が伸びきっている。それまでのやりとりは消えていない（記録は残っている）が、私はその続きを覚えていない状態で始まるので、必要なら読み直す。",
        ]
      `);
    });
  });
});

describe('安全分類器の拒否の判定・日誌・人間への知らせの逐語固定', () => {
  const FLAGGED =
    "Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]";

  type Signal = 'none' | 'refusal';

  function build(options: { env?: NodeJS.ProcessEnv } = {}) {
    const stores = createMemoryStores();
    // 回数ではなく可変フラグで駆動する: 側道（蒸留）も同じ関数を通り、通し番号だとずれるため
    const state: {
      mode: 'ok' | 'refuse';
      failText: string;
      signal: Signal;
      apiCategory: string | undefined;
    } = {
      mode: 'refuse',
      failText: FLAGGED,
      signal: 'none',
      apiCategory: 'cyber',
    };
    const sdk = fakeSdk(() => 'わかった', {
      resultFor: () =>
        state.mode === 'refuse'
          ? { subtype: 'error_during_execution', text: state.failText, isError: true }
          : { subtype: 'success', text: 'わかった' },
      beforeAssistant: () =>
        state.signal === 'none'
          ? []
          : [
              {
                type: 'system',
                subtype: 'model_refusal_no_fallback',
                original_model: 'claude-opus-5-5',
                ...(state.apiCategory === undefined
                  ? {}
                  : { api_refusal_category: state.apiCategory }),
                content: 'refused',
                uuid: 'uuid-refusal',
                session_id: 'sess-fake',
              } as never,
            ],
    });
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: options.env ?? {},
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    async function turn(event: InboxEvent): Promise<void> {
      const before = events.filter((e) => e.type === 'error' || e.type === 'done').length;
      clone.post(event);
      await waitFor(
        () => events.filter((e) => e.type === 'error' || e.type === 'done').length > before,
        'ターンが終わること',
      );
    }
    let n = 0;
    let failedTurns = 0;
    // 失敗したターンは、人間への 1 行（`turnFailure` 付き）を書き終えるまで待つ（`stop()` との競合で最後の行が欠けないように）
    const human = async (): Promise<void> => {
      await turn(humanMessage(`発言${(n += 1)}`));
      if (state.mode === 'ok') return;
      failedTurns += 1;
      await waitFor(
        async () => (await countOf(stores, '{turnFailure=')) === failedTurns,
        `人間への ${String(failedTurns)} 行目`,
      );
    };
    return { clone, stores, state, events, turn, human };
  }

  it('構造の合図（refusal）あり・失敗文に category 無し: 1 回目は数えるだけ。[障害] 行の末尾に印（category は構造の合図の cyber）', async () => {
    const s = build();
    s.state.failText = 'something broke';
    s.state.signal = 'refusal';
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / something broke（safeguards: cyber）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / something broke（safeguards: cyber）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: cyber、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しが有効なので、開き直す。",
        "self@internal | [判断] 開き直す前の生ログ（古い session id: sess-fake）: 退避するものが無かった",
      ]
    `);
  });

  it('構造の合図あり・合図に category 無し: 失敗文の Details から category を穴埋めする（bio）。失敗文にも無ければ「不明」', async () => {
    const withDetails = build();
    withDetails.state.signal = 'refusal';
    withDetails.state.apiCategory = undefined;
    withDetails.state.failText = 'something broke. Details: [bio]';
    await withDetails.human();
    const first = (await trace(withDetails.stores)).filter((line) =>
      line.startsWith('self@conv-1'),
    );
    await withDetails.clone.stop();

    const without = build();
    without.state.signal = 'refusal';
    without.state.apiCategory = undefined;
    without.state.failText = 'something broke';
    await without.human();
    const second = (await trace(without.stores)).filter((line) => line.startsWith('self@conv-1'));
    await without.clone.stop();

    expect(first).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / something broke. Details: [bio]（safeguards: bio）",
      ]
    `);
    expect(second).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / something broke（safeguards: 不明）",
      ]
    `);
  });

  it('構造の合図なし・失敗文の safeguards flagged（大小無視）で数える。category は Details から拾う', async () => {
    const s = build();
    s.state.failText = 'SAFEGUARDS FLAGGED this session. Details: [bio]';
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / SAFEGUARDS FLAGGED this session. Details: [bio]（safeguards: bio）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / SAFEGUARDS FLAGGED this session. Details: [bio]（safeguards: bio）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: bio、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しが有効なので、開き直す。",
        "self@internal | [判断] 開き直す前の生ログ（古い session id: sess-fake）: 退避するものが無かった",
      ]
    `);
  });

  it('category が読めない: [障害] 行の印は「不明」', async () => {
    const s = build();
    s.state.failText = 'safeguards flagged this session';
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: 不明、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しが有効なので、開き直す。",
        "self@internal | [判断] 開き直す前の生ログ（古い session id: sess-fake）: 退避するものが無かった",
      ]
    `);
  });

  it('答えが返ったターンの本文に safeguards flagged があっても数えない（印も日誌も出ない）', async () => {
    const s = build();
    s.state.mode = 'ok';
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toEqual([]);
  });

  it('2 回目・自動の開き直しが有効（既定）: [判断] の日誌行（有効）と、人間への「新しく開き直した」', async () => {
    const s = build();
    await s.human();
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: cyber、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しが有効なので、開き直す。",
        "human@conv-1 | 安全分類器（safeguards: cyber）に 2 回続けて弾かれたので、クローンのセッションを新しく開き直した。それまでのやりとりの記録は消えていない。古いセッションの生ログは退避した。新しいセッションのクローンは、それまでの続きを覚えていない状態で始まる。",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [判断] 開き直す前の生ログ（古い session id: sess-fake）: 退避するものが無かった",
      ]
    `);
  });

  it('2 回目・自動の開き直しを外した: [判断] の日誌行（外してある）と、人間への「開き直していない」。3 回目は何も足さない', async () => {
    const s = build({ env: { ALTEROID_REFUSAL_AUTO_REOPEN: 'off' } });
    await s.human();
    await s.human();
    const afterSecond = await trace(s.stores);
    await s.human();
    await s.clone.stop();

    expect(afterSecond).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: cyber、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しは外してあるので、開き直さない（人間へ知らせる）。",
        "human@conv-1 | クローンのセッションが安全分類器（safeguards: cyber）に 2 回続けて弾かれている。自動の開き直しは外してあるので、開き直していない。開き直す口: \`alteroid reopen\` / 設定画面の「クローンのセッションを開き直す」 / \`POST /clone/session/reopen\`",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
      ]
    `);
    const afterThird = await trace(s.stores);
    expect(afterThird.slice(0, afterSecond.length)).toEqual(afterSecond);
    // 3 回目は [障害] 行と失敗の 1 行が増えるだけで、判断の行・人間への知らせ（`{turnFailure=` の無い human 行）は増えない
    const added = afterThird.slice(afterSecond.length);
    expect(added.some((line) => line.startsWith('self@conv-1 | [障害] '))).toBe(true);
    expect(added.some((line) => line.includes('[判断]'))).toBe(false);
    expect(added.some((line) => line.startsWith('human@conv-1 |'))).toBe(false);
  });

  it('設定の綴りが読めない（maybe）: 有効として扱い、日誌行の末尾に「読めない」の断りが付く', async () => {
    const s = build({ env: { ALTEROID_REFUSAL_AUTO_REOPEN: 'maybe' } });
    await s.human();
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: cyber、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しが有効なので、開き直す。 ⚠ ALTEROID_REFUSAL_AUTO_REOPEN の値「maybe」は読めないので有効として扱った。",
        "human@conv-1 | 安全分類器（safeguards: cyber）に 2 回続けて弾かれたので、クローンのセッションを新しく開き直した。それまでのやりとりの記録は消えていない。古いセッションの生ログは退避した。新しいセッションのクローンは、それまでの続きを覚えていない状態で始まる。",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [判断] 開き直す前の生ログ（古い session id: sess-fake）: 退避するものが無かった",
      ]
    `);
  });

  it('category 不明のまま 2 回続く: 日誌行・人間への知らせとも「不明」', async () => {
    const s = build({ env: { ALTEROID_REFUSAL_AUTO_REOPEN: 'off' } });
    s.state.failText = 'safeguards flagged this session';
    await s.human();
    await s.human();
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: 不明、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しは外してあるので、開き直さない（人間へ知らせる）。",
        "human@conv-1 | クローンのセッションが安全分類器（safeguards: 不明）に 2 回続けて弾かれている。自動の開き直しは外してあるので、開き直していない。開き直す口: \`alteroid reopen\` / 設定画面の「クローンのセッションを開き直す」 / \`POST /clone/session/reopen\`",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
      ]
    `);
  });

  it('自動で開き直したセッションが答えないまま弾かれる: [判断] の日誌行（止めた）と、人間への「自動の開き直しは止めた」', async () => {
    const s = build();
    await s.human();
    await s.human();
    const beforeHalt = (await trace(s.stores)).length;
    await s.human();
    await s.clone.stop();

    expect((await trace(s.stores)).slice(beforeHalt)).toMatchInlineSnapshot(`
      [
        "self@internal | [判断] 開き直した: sess-fake → sess-fake（退避するものが無かった）",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "self@internal | [判断] 自動で開き直したセッションが、1度も答えを返さないまま安全分類器に弾かれた（category: cyber、session id: sess-fake）。⟹ 自動の開き直しはもうしない（記憶の焼き込みや届き続ける合図そのものが弾かれている可能性。ターンは回り続ける。解けるのは、このセッションが1度答えたとき、または人間が手動で開き直したとき）。",
        "human@conv-1 | 自動で開き直したセッションが、1度も答えを返さないうちにまた安全分類器（safeguards: cyber）に弾かれた。記憶の焼き込みや届き続ける合図そのものが弾かれている可能性がある。自動の開き直しは止めた（人間が開き直すか、このセッションが1度答えを返すまで再開しない）。開き直す口: \`alteroid reopen\` / 設定画面の「クローンのセッションを開き直す」 / \`POST /clone/session/reopen\`",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
      ]
    `);
  });

  it('止めた枝で category が読めない: 日誌行・人間への知らせとも「不明」', async () => {
    const s = build();
    s.state.failText = 'safeguards flagged this session';
    await s.human();
    await s.human();
    const beforeHalt = (await trace(s.stores)).length;
    await s.human();
    await s.clone.stop();

    expect((await trace(s.stores)).slice(beforeHalt)).toMatchInlineSnapshot(`
      [
        "self@internal | [判断] 開き直した: sess-fake → sess-fake（退避するものが無かった）",
        "self@conv-1 | [障害] 人間との対話ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
        "self@internal | [判断] 自動で開き直したセッションが、1度も答えを返さないまま安全分類器に弾かれた（category: 不明、session id: sess-fake）。⟹ 自動の開き直しはもうしない（記憶の焼き込みや届き続ける合図そのものが弾かれている可能性。ターンは回り続ける。解けるのは、このセッションが1度答えたとき、または人間が手動で開き直したとき）。",
        "human@conv-1 | 自動で開き直したセッションが、1度も答えを返さないうちにまた安全分類器（safeguards: 不明）に弾かれた。記憶の焼き込みや届き続ける合図そのものが弾かれている可能性がある。自動の開き直しは止めた（人間が開き直すか、このセッションが1度答えを返すまで再開しない）。開き直す口: \`alteroid reopen\` / 設定画面の「クローンのセッションを開き直す」 / \`POST /clone/session/reopen\`",
        "human@conv-1 {turnFailure=failed, kind=other} | この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / safeguards flagged this session（safeguards: 不明）",
      ]
    `);
  });

  it('内部のターン（会話なし）が 2 回弾かれる: 日誌行は残り、人間への知らせは無い', async () => {
    const s = build();
    s.state.mode = 'ok';
    await s.human();
    s.state.mode = 'refuse';
    const external = (id: string): InboxEvent => ({
      type: 'external',
      id,
      at: FROZEN_AT,
      source: 'ci.main',
      payload: { status: 'failure' },
    });
    s.clone.post(external('e1'));
    await waitFor(async () => (await countOf(s.stores, '内部ターンが失敗した')) >= 1, '1 件目');
    s.clone.post(external('e2'));
    await waitFor(async () => (await countOf(s.stores, '内部ターンが失敗した')) >= 2, '2 件目');
    await waitFor(
      async () => (await countOf(s.stores, 'セッションごと弾かれていると見る')) >= 1,
      '日誌に判断の行が残ること',
    );
    await s.clone.stop();

    expect(await trace(s.stores)).toMatchInlineSnapshot(`
      [
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "self@internal | [障害] 内部ターンが失敗した: 結果なしで終了: error_during_execution（result_subtype） / Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]（safeguards: cyber）",
        "self@internal | [判断] 別の入力で 2 回続けて安全分類器に弾かれた（category: cyber、session id: sess-fake）。⟹ セッションごと弾かれていると見る。自動の開き直しが有効なので、開き直す。",
        "self@internal | [判断] 開き直す前の生ログ（古い session id: sess-fake）: 退避するものが無かった",
      ]
    `);
  });
});
