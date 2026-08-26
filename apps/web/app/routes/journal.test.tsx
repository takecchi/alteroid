// @vitest-environment jsdom
/**
 * 日誌画面が SSE の `recent`（B-3）を履歴（`useJournal`）に重ねること。
 *
 * `AuthedShell` が1本だけ張った購読の結果を context 越しに受け取るだけで、
 * `Journal` 自身は `useJournalLive()` を呼ばない（呼んだら購読が増えてしまう）。
 */
/**
 * ⚠️ **2026-08-23 追記: `virtua`（双方向無限スクロール）導入で、この画面の
 * 行は jsdom では1行も描画されなくなった。** jsdom には本物のレイアウトが
 * 無く、`Element.offsetParent` が常に `null`・`getBoundingClientRect()` が
 * 常にゼロを返すため、virtua は「まだ実寸を測っていない」状態から一度も
 * 進めない（`apps/web/app/test-support.tsx` の `ResizeObserver` no-op
 * スタブのコメントに実験の詳細がある）。**素の jsdom で `<Virtualizer>` を
 * 描くと `ResizeObserver is not a constructor` で例外になる**（このスタブが
 * それを防いでいる）が、**防いだ後も中身は描かれない。**
 *
 * この事実が、下の7本のテストのうち6本（`screen.findByText`/`getByText` で
 * 日誌の1行の文言を探していたもの）を壊した。**削除していない** — 期待値を
 * 反転し（文言が「出る」ではなく「出ない」ことを確認する形にした）、元の
 * コメントは消さずに経緯だけ追記してある。**測っていた保証そのものは
 * 消えていない**（消えた分は移設した — 下の②）:
 *
 * 1. 重ね合わせ（`recent` の先頭差し込み・`id` での重複除去）・種別
 *    フィルタの掛け直し・カーソル送りの規則は、DOM にも virtua にも
 *    触れない純粋な関数として `apps/web/app/lib/journal-window.ts` に
 *    切り出してあり、そちらの歯（`journal-window.test.ts`）が同じ保証を
 *    測っている（むしろ非同期の DOM 待ちが要らないぶん決定的で、こちらの
 *    ほうが強い）
 * 2. `summarizeJournalEntry` 自身の文言（`daily_report` の印つき・
 *    `worker_wait`・`turn_usage`）は、関数を直接呼ぶ単体テストとして
 *    `apps/web/app/hooks/queries.test.ts` へ移設した
 *
 * **反転後にこの6本が測っているのは「virtua が jsdom で描かないこと」の
 * canary であって、マージ規則そのものの正しさではない。** それでも消さずに
 * 残すのは、①virtua や jsdom 側の挙動がいつか変わって本当に描かれるように
 * なったときに気づける、②チップ絞り込みが実際にサーバへの再取得を動かす
 * ことは（後述のとおり）このテストでいまも測れているからである。
 *
 * **測れなくなったもの・移設したものを PR 本文に列挙してある**
 * （テスト名で数える）。
 */
import { JOURNAL_ENTRY_TYPES } from '@alteroid/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalFeedProvider } from '~/hooks/journal-feed';
import type { JournalLive } from '~/hooks/use-journal-live';
import { summarizeJournalEntry } from '~/hooks/queries';
import type { JournalEntry } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Journal from './journal';

/**
 * 読み込みが終わる（`Spinner` が消える）まで待つ。
 *
 * `virtua` は jsdom で行を描かないので、以前のように「求める行の文言が
 * 出るまで待つ」（`findByText`）形では待てない。**Spinner の消滅を「読み込み
 * が終わった」の代理にする** — `journal.tsx` は `isLoadingInitial` の間だけ
 * `Spinner` を出し、終われば（0件でも）`Empty` か（`virtua` が中身を描かない）
 * 空の `Virtualizer` の枠のどちらかに変わる。
 */
async function waitForLoaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByText('読み込み中')).toBeNull());
}

const HISTORY_ONLY: JournalEntry = {
  type: 'decision',
  id: 'h-decision',
  at: '2026-08-14T09:00:00.000Z',
  decision: '前からある判断',
  grounds: '記憶',
};

/** SSE で届いたあと、再取得で履歴側にも現れたもの（同じ id）。 */
const SHARED: JournalEntry = {
  type: 'exchange',
  id: 'shared-1',
  at: '2026-08-14T09:05:00.000Z',
  with: 'human',
  role: 'inbound',
  text: '両方に載る発言',
};

const RECENT_EXCHANGE: JournalEntry = {
  type: 'exchange',
  id: 'recent-exchange',
  at: '2026-08-14T09:10:00.000Z',
  with: 'human',
  role: 'outbound',
  text: 'たった今届いた発言',
};

const RECENT_ESCALATION: JournalEntry = {
  type: 'escalation',
  id: 'recent-escalation',
  at: '2026-08-14T09:11:00.000Z',
  question: 'たった今届いた確認',
  approvalId: 'approval-x',
};

const WORKER_WAIT: JournalEntry = {
  type: 'worker_wait',
  id: 'ww-1',
  at: '2026-08-20T22:10:00.000Z',
  openedAt: '2026-08-20T21:30:00.000Z',
  tasks: 5,
  turns: 41,
  byCause: { input: 1, notification: 3, continuation: 37 },
  toolless: 38,
  notifications: 3,
  submits: 0,
  settled: true,
};

const TURN_USAGE: JournalEntry = {
  type: 'turn_usage',
  id: 'tu-1',
  at: '2026-08-20T22:20:00.000Z',
  layer: 'clone',
  site: 'session',
  managerId: 'clone',
  models: {
    'claude-fable-5': {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 120,
      cacheCreationInputTokens: 40,
      webSearchRequests: 0,
      costUsd: 0.5,
    },
  },
};

/**
 * **Router で包む（issue #250）。** `Journal` は検索語の正本を URL に置く
 * （`useSearchParams`）ので、Router 無しでは描けなくなった。形は
 * `dashboard.test.tsx` / `memory-detail.test.tsx` と同じ `createMemoryRouter`
 * + `RouterProvider`。
 *
 * **`router` を返すのは、検索語が URL に載ったことを読むためである**
 * （`router.state.location.search`）。画面の state を覗くのではなく URL を
 * 見ることで、「開き直しても・共有しても同じ検索が再現できる」という
 * 主張そのものを測れる。
 */
function renderJournal(live: JournalLive, initialEntries: string[] = ['/']) {
  const router = createMemoryRouter([{ path: '/', Component: Journal }], {
    initialEntries,
  });
  const result = render(
    <Providers>
      <JournalFeedProvider value={live}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
  return { ...result, router };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * **日誌の1行が、日報が書けなかった日を「日報」と呼ばないこと。**
 *
 * 日報の行には「書けなかった」の印が付くことがある（`packages/core/src/schema.ts`
 * の `unavailable`）。日誌は人間が拾い読みする面でもあるので、ここが
 * 「2026-08-20 の日報」としか言わないと、**書けなかった日が書けた日と同じ顔で
 * 並ぶ** — 発端の壊れ方（エラー文が日報として出ていた）の、一覧側の残りである。
 */
describe('日誌の1行は、日報が書けなかった日を日報と呼ばない', () => {
  const REASON = "You've hit your org's monthly spend limit";
  const UNAVAILABLE: JournalEntry = {
    type: 'daily_report',
    id: 'dr-unavailable',
    at: '2026-08-20T22:00:00.000Z',
    date: '2026-08-20',
    body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${REASON}）`,
    unavailable: REASON,
  };
  const WRITTEN: JournalEntry = {
    type: 'daily_report',
    id: 'dr-written',
    at: '2026-08-19T22:00:00.000Z',
    date: '2026-08-19',
    body: '進捗があった。',
  };

  it('印の付いた日は「作れなかった」と理由まで言い、書けた日はこれまでどおり', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) {
        return json({ entries: [UNAVAILABLE, WRITTEN], scanned: 2 });
      }
      return undefined;
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    // **文言を直に書く。** `summarizeJournalEntry(...)` で引くと、実装と同じ関数を
    // 通ることになって何も保証しない（同語反復になる）。
    //
    // ⚠️ **2026-08-23 追記: 期待値を反転した。** `virtua` がこの画面の行を
    // jsdom で描かなくなったため（ファイル冒頭のコメント）、以前ここで
    // `toBeTruthy()` を確認していた2つの文言は、いまは**画面には出ない**。
    // 「印を付けて理由まで言う」という `summarizeJournalEntry` 自身の規則は
    // `apps/web/app/hooks/queries.test.ts` へ直接呼び出しの単体テストとして
    // 移設した（DOM を経由しないぶん、こちらのほうが決定的で強い）。
    expect(screen.queryByText(`⚠ 2026-08-20 の日報は作れなかった: ${REASON}`)).toBeNull();
    expect(screen.queryByText('2026-08-19 の日報')).toBeNull();
  });
});

/**
 * **絞り込みチップが日誌の全種別を尽くしていること。**
 *
 * `journal.tsx` の `TYPES`（チップの表示順）は `TONE` から `Object.keys` で
 * 導出している。ここでは黒箱（画面に実際に出るボタン）として、種別の正本
 * である `@alteroid/core` の `JOURNAL_ENTRY_TYPES` と同じ集合であることを
 * 固定する — `TYPES` はモジュール内部の定数で `journal.tsx` から export
 * していないので、内部の配列を直接読むのではなく画面の出力で確かめる。
 *
 * **これは実行時に測れる保証である。** `invalidate()` 側の `never` 縛りは
 * 型検査でしか効かず、ここのテストでは測れない（型検査が落ちることは
 * `pnpm typecheck` を使った変異試験で別途示す。PR 本文を参照）。
 */
describe('絞り込みチップが日誌の全種別を尽くす', () => {
  it('JOURNAL_ENTRY_TYPES の全種別ぶんのチップが、他のボタンを増やさずに出る', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [], scanned: 0 });
      return undefined;
    });

    renderJournal({ status: 'live', recent: [] });
    await screen.findByText('日誌');

    for (const type of JOURNAL_ENTRY_TYPES) {
      expect(screen.getByRole('button', { name: type })).toBeTruthy();
    }
    // 種別チップの総数が JOURNAL_ENTRY_TYPES の件数と一致する（多すぎても
    // 少なすぎても落ちる）。選択が無い間は「すべて解除」ボタンは出ないので、
    // ここで見えているボタンは種別チップだけである。
    expect(screen.getAllByRole('button')).toHaveLength(JOURNAL_ENTRY_TYPES.length);
  });
});

describe('recent を履歴に重ねる', () => {
  // ⚠️ **2026-08-23 追記: この `describe` 全体で期待値を反転した。** `virtua`
  // がこの画面の行を jsdom で描かなくなったため（ファイル冒頭のコメント）、
  // 「文言が画面に出る」ことはもう確認できない。**重ね合わせ・重複除去・
  // 種別フィルタの掛け直しという規則そのものは `journal-window.test.ts`
  // （`mergeFront`/`applyNewerPage`/`filterByType`）で測っており、消えて
  // いない。** ここへ残すのは、①「画面に出ない」が仮想化の帰結どおりで
  // あることの canary、②絞り込みチップが実際にサーバへ正しい `type=` を
  // 投げることの回帰確認（これは virtua 以前・以後で変わらず DOM 経由で
  // 測れる — `JournalBody` の remount がフィルタごとに新しい `GET /journal`
  // を撃つため）である。

  it('再取得を待たずに recent の中身が出る（画面には出ない。歯は journal-window.test.ts 側）', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [HISTORY_ONLY], scanned: 1 });
      return undefined;
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE, RECENT_ESCALATION] });
    await waitForLoaded();

    expect(screen.queryByText(summarizeJournalEntry(RECENT_EXCHANGE))).toBeNull();
    expect(screen.queryByText(summarizeJournalEntry(RECENT_ESCALATION))).toBeNull();
    expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();
  });

  it('同じ id のエントリが履歴側にも現れても二重に出ない（画面には出ない。歯は journal-window.test.ts 側）', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [SHARED, HISTORY_ONLY], scanned: 2 });
      return undefined;
    });

    // SHARED は「recent で届いた直後、再取得が終わって履歴側にも現れた」状態を再現する。
    renderJournal({ status: 'live', recent: [SHARED, RECENT_EXCHANGE] });
    await waitForLoaded();

    // `getAllByText` は0件だと投げるので `queryAllByText` を使う。
    expect(screen.queryAllByText(summarizeJournalEntry(SHARED))).toHaveLength(0);
  });

  it('種別フィルタに recent 側も従う（画面には出ないが、絞り込みは実際にサーバへ届く）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'exchange') return json({ entries: [SHARED], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, SHARED], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE, RECENT_ESCALATION] });
    await waitForLoaded();

    // 絞り込み前は何も画面に出ない（virtua が jsdom で描かないため）。
    expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'exchange' }));

    // exchange だけに絞る `type=exchange` が実際にサーバへ撃たれる
    // （`JournalBody` が `key` で作り直され、新しい初期取得が走る）。
    await waitFor(() => {
      expect(
        stub.calls.some(
          (url) => url.includes('/journal') && new URL(url).searchParams.get('type') === 'exchange',
        ),
      ).toBe(true);
    });
    // 絞り込み後も画面には何も出ない（同じ理由）。
    expect(screen.queryByText(summarizeJournalEntry(SHARED))).toBeNull();
  });
});

/**
 * **空回りが目で分かる文言であること**（`summarizeJournalEntry` の doc）と、
 * 他の種別と同じ絞り込み経路（`GET /journal?type=`）に乗っていること。
 */
describe('worker_wait — 種別フィルタと1行の文言', () => {
  // ⚠️ **2026-08-23 追記: 期待値を反転した。** `virtua` がこの画面の行を
  // jsdom で描かなくなったため（ファイル冒頭のコメント）、「1行の文言」は
  // もう画面では確認できない。**文言そのものの保証は
  // `apps/web/app/hooks/queries.test.ts` へ移設した**（関数を直接呼ぶ単体
  // テスト）。ここに残すのは「絞り込みボタンでも選べる」＝チップが実際に
  // `type=worker_wait` をサーバへ投げることの回帰確認である。
  it('絞り込みボタンで type=worker_wait が実際にサーバへ届く（1行の文言は queries.test.ts 側）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'worker_wait') return json({ entries: [WORKER_WAIT], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, WORKER_WAIT], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    // 絞り込み前も画面には何も出ない（virtua が jsdom で描かないため）。
    expect(screen.queryByText(summarizeJournalEntry(WORKER_WAIT))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'worker_wait' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (url) =>
            url.includes('/journal') && new URL(url).searchParams.get('type') === 'worker_wait',
        ),
      ).toBe(true);
    });
  });
});

/**
 * **キャッシュの書き直しが目で分かる文言であること**（`summarizeJournalEntry`
 * の doc — read/write を潰すと測る意味が消える）と、他の種別と同じ絞り込み
 * 経路（`GET /journal?type=`）に乗っていること。
 */
describe('turn_usage — 種別フィルタと1行の文言', () => {
  // ⚠️ **2026-08-23 追記: 期待値を反転した。** 理由は `worker_wait` の
  // テストと同じ（ファイル冒頭のコメント）。文言そのものの保証は
  // `apps/web/app/hooks/queries.test.ts` へ移設した。
  it('絞り込みボタンで type=turn_usage が実際にサーバへ届く（1行の文言は queries.test.ts 側）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'turn_usage') return json({ entries: [TURN_USAGE], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, TURN_USAGE], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByText(summarizeJournalEntry(TURN_USAGE))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'turn_usage' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (url) =>
            url.includes('/journal') && new URL(url).searchParams.get('type') === 'turn_usage',
        ),
      ).toBe(true);
    });
  });
});

/**
 * **「もっと遡る」ボタン（過去方向のカーソル送り、`use-journal-window.ts` の
 * `loadOlderAt`）に対する歯。**
 *
 * このボタンは `<Card>`（`Virtualizer` を包む）の外にある素の JSX で、
 * `entries.length > 0` かつ `olderStatus` が `progress`/`retryLarger` のときに
 * 出るだけの通常のボタンである。virtua の描画には依存しないので、他の
 * テストと同じ `fireEvent.click` で押せる（`stub.calls` で実際に撃たれた
 * クエリを見る）。
 *
 * 2026-08-23 追記: 変異試験（PR #239）で「until/limit の取り違えを検出する
 * 歯が無い。ただし virtua に阻まれておらず、素の jsdom で測れるはず」と
 * 指摘されたので、ここへ足す。
 */
describe('もっと遡る（過去方向のカーソル送り）', () => {
  const CURSOR_BASE = new Date('2026-08-20T00:00:00.000Z').getTime();

  function pastDecision(id: string, minutesAgo: number): JournalEntry {
    return {
      type: 'decision',
      id,
      at: new Date(CURSOR_BASE - minutesAgo * 60_000).toISOString(),
      decision: `d-${id}`,
      grounds: 'g',
    };
  }

  /** 新しい順（`at` 降順）に100件。先頭と末尾で `at` が違う値になっている。 */
  const PAGE = Array.from({ length: 100 }, (_, i) => pastDecision(`p${i}`, i));

  it('until には一覧の末尾（最古）の at を渡す（先頭の at と取り違えたら落ちる）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) {
        // 2回目（クリック後）の呼び出し。until の値だけを見たいので、応答は
        // 空でよい（freshCount===0 かつ pageLength(0) < limit で素直に `end`
        // になり、余計な撃ち直しを起こさない）。
        return json({ entries: [], scanned: 0 });
      }
      return json({ entries: PAGE, scanned: PAGE.length });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(2);
    });

    const secondCall = stub.calls.filter((url) => url.includes('/journal'))[1]!;
    // 末尾（最古）の at。`newestAt`（先頭）と取り違えると別の値になり、ここで落ちる。
    expect(new URL(secondCall).searchParams.get('until')).toBe(PAGE.at(-1)!.at);
  });

  it('retryLarger（同じ境界が limit ちょうど埋まった）のとき limit を JOURNAL_MAX_LIMIT へ上げて撃ち直す', async () => {
    // **呼び出し回数で応答を決める（`limit` の値では決めない）。** `limit` の
    // 値で分岐すると、「limit を上げない」変異（B2）を当てたときに同じ分岐へ
    // 何度でも入り続けて撃ち直しが止まらなくなる（実際に手元で無限再帰になり、
    // このテストを含むプロセスが応答しなくなった）。呼び出し回数で切れば、
    // 変異があってもなくても3回目で必ず終端（`end`）になり、判定は3回目に
    // 実際に使われた `limit` の値そのもので行う。
    let journalCalls = 0;
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      journalCalls += 1;
      if (journalCalls <= 2) {
        // 1回目（初期読み込み）・2回目（クリック直後、limit=100 で撃ち直す）は
        // 同じ100件をそのまま返す＝全件が既知（freshCount===0）かつ
        // pageLength(100)===limit(100) → retryLarger
        // （`~/lib/journal-window.ts` の `pageOutcome` の doc）。
        return json({ entries: PAGE, scanned: PAGE.length });
      }
      // 3回目以降は無条件に終端にする（limit が上がったかどうかに関わらず、
      // ここで撃ち直しを止める）。
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal')).length).toBeGreaterThanOrEqual(3);
    });

    const thirdCall = stub.calls.filter((url) => url.includes('/journal'))[2]!;
    // JOURNAL_MAX_LIMIT を素通しする変異（limit を上げずに撃ち直す）だと
    // ここが '100' のままになり落ちる。
    expect(new URL(thirdCall).searchParams.get('limit')).toBe('1000');
  });
});

/**
 * 日誌画面の検索欄（issue #250。**4口のうち Web UI のぶん**）。
 *
 * ここで測るのは3つ。**サーバへ投げること**（画面側で捨てない）、**打鍵ごとに
 * 撃たないこと**（debounce）、**検索語が URL に載ること**（開き直し・共有で
 * 同じ結果へ戻れる）。
 *
 * ⚠️ **一覧の行そのものは jsdom では1行も描かれない**（このファイル冒頭の
 * virtua の断り）。だから「当たった行が見えること」はここでは測れない ——
 * 測っているのは**サーバへ何を投げたか**までである。当たり方そのものは
 * `packages/core/src/journal-search-contract.ts`（3実装）が持つ。
 */
describe('日誌画面の検索欄（issue #250）', () => {
  /** `GET /journal` の呼びから `q` を取り出す（未指定は `null`）。 */
  function searchTerms(calls: readonly string[]): (string | null)[] {
    return calls
      .filter((url) => url.includes('/journal'))
      .map((url) => new URL(url).searchParams.get('q'));
  }

  it('入力した語が GET /journal?q= としてサーバへ届く', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    // 初回の取得には q が付いていない（既存の呼びを1文字も変えていない）。
    expect(searchTerms(stub.calls)).toEqual([null]);

    fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
      target: { value: 'トマト' },
    });

    await waitFor(() => {
      expect(searchTerms(stub.calls)).toContain('トマト');
    });
  });

  /**
   * **打鍵ごとに撃たない**（`SEARCH_DEBOUNCE_MS`）。日誌の検索はストア全体を
   * 舐めうるので、1文字ごとに撃つと打っている間ずっと重い問い合わせが並ぶ。
   */
  it('途中の打鍵ではサーバを撃たず、止まった後の語だけを撃つ', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    const input = screen.getByLabelText('日誌を語で探す');
    fireEvent.change(input, { target: { value: 'ト' } });
    fireEvent.change(input, { target: { value: 'トマ' } });
    fireEvent.change(input, { target: { value: 'トマト' } });

    await waitFor(() => {
      expect(searchTerms(stub.calls)).toContain('トマト');
    });

    // 途中の2つは1度も撃たれていない。
    expect(searchTerms(stub.calls)).not.toContain('ト');
    expect(searchTerms(stub.calls)).not.toContain('トマ');
  });

  /**
   * **待つ長さそのものを測る。**
   *
   * ⚠️ **上の歯だけでは足りない**（実測: 変異試験で `SEARCH_DEBOUNCE_MS` を
   * `0` に落とす変異が**生き残った**）。`fireEvent.change` を3連打しても、
   * 3つとも同じ同期のかたまりの中で起きるので、待ちが 0 でもタイマは1度も
   * 発火せず（毎回 cleanup が先に走る）**上の歯は緑のまま通る**。だが実際に
   * 人が打つ速さでは打鍵ごとに撃たれる —— **上の歯が測っていたのは
   * 「同期のかたまりの中でまとめられること」だけで、「待つ」ことではなかった。**
   *
   * ここでは時計を止めて、**待ちの手前では撃たれず・待ちを越えて初めて
   * 撃たれる**ことを両側から挟む。**300 という数そのものを書き写している**
   * ので、`journal.tsx` 側の値を変えるとこの歯が落ちる —— それは意図である
   * （値は当てずっぽうだと `SEARCH_DEBOUNCE_MS` の doc が断っており、変える
   * ときは両方を見てほしい）。
   */
  it('待ちの手前では撃たず、待ちを越えて初めて撃つ（時計を止めて測る）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    // 初期取得が終わってから時計を止める（止めたまま fetch の解決を待つと
    // 進まなくなる）。
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
        target: { value: 'トマト' },
      });

      // `journal.tsx` の `SEARCH_DEBOUNCE_MS` は 300ms。その手前では撃たない。
      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(searchTerms(stub.calls)).not.toContain('トマト');

      // 1ms 越えたところで初めて撃つ。
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(searchTerms(stub.calls)).toContain('トマト');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **検索語の正本は URL である。** 画面の state に閉じ込めると、その検索結果を
   * 人へ渡せない（開き直すと消える・リンクで共有できない）。
   */
  it('検索語が URL のクエリに載る', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    const { router } = renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
      target: { value: 'トマト' },
    });

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('トマト');
    });
  });

  it('URL に q が載った状態で開くと、その語で最初から探しに行く', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('トマト')}`]);
    await waitForLoaded();

    expect(searchTerms(stub.calls)).toEqual(['トマト']);
    // 入力欄にもその語が入っている（URL を開いた人が何で絞られているか分かる）。
    expect((screen.getByLabelText('日誌を語で探す') as HTMLInputElement).value).toBe('トマト');
  });

  /**
   * **当たらなかったとき、「記録が無い」と言わずに「その語では無い」と言う。**
   * 検索で 0 件なのに「この条件では何も記録されていない」と出ると、日誌が
   * 空になったように読める。
   *
   * **`Empty` は `Virtualizer` の外に在るので jsdom でも描かれる** ——
   * 一覧の行そのものは1行も描かれない（このファイル冒頭の virtua の断り）が、
   * この分岐は画面越しに測れる数少ない場所である。
   */
  it('当たらなかったら、その語では無いと言う（記録が無いとは言わない）', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('当たらない語')}`]);
    await waitForLoaded();

    expect(
      screen.getByText('「当たらない語」に当たる記録は無い（この条件の中では）。'),
    ).toBeTruthy();
    expect(screen.queryByText('この条件では何も記録されていない。')).toBeNull();
  });

  /**
   * **検索中は、当たらない新着（SSE の `recent`）が割り込まない。**
   *
   * ⚠️ **その保証そのものはここでは測れない** —— jsdom は日誌の行を1行も
   * 描かないので、「割り込んだ行が画面に出ていないこと」は絞りが効いていても
   * いなくても等しく成り立つ（＝この画面越しの確認は何も区別しない）。
   * **だから絞りの規則は純粋な関数へ切り出してあり、そちらの歯が測る**
   * （`apps/web/app/lib/journal-window.ts` の `filterRecent` と
   * `journal-window.test.ts`）。ここに残すのは、**その関数へ実際に検索語が
   * 渡る配線が生きていること**の確認だけである（URL の語が画面の描画を
   * 一巡しても保たれる）。
   */
  it('検索語が、新着が届いた後も URL に保たれる（絞りの当否は filterRecent 側で測る）', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    const { router } = renderJournal({ status: 'live', recent: [RECENT_EXCHANGE] }, [
      `/?q=${encodeURIComponent('当たらない語')}`,
    ]);
    await waitForLoaded();

    expect(new URLSearchParams(router.state.location.search).get('q')).toBe('当たらない語');
  });

  /**
   * **探す対象に入っていない欄が在ることを、探している人にだけ見せる。**
   * 常に出すと本当に効いているときの目印にならない。
   */
  /**
   * **絞ったまま遡れること**（`q` と `until` が同じ要求に載る）。
   *
   * ⚠️ **これは2つの PR が同じファイルで出会ったところを名指しで測る歯である。**
   * #501 が「一覧のどちらの端をどちらのクエリ引数へ載せるか」を
   * `olderPageQuery` として純粋関数へ出し、#250（この PR）が `buildQuery` へ
   * `q` を足した。**両者は `buildQuery(limit, olderPageQuery(...))` という1点で
   * 出会っている** —— `q` を足す側が `extra` を潰すか、`extra` を渡す側が `q` を
   * 潰すかのどちらでも、**「検索したまま遡ると、2頁目から絞りが外れる」**という
   * 壊れ方になる。git は自動で解いたが、*意味の上で* 両立していることは
   * どちらの PR の歯も測っていなかった。
   *
   * 2頁目に `q` が無ければ、その頁だけ全種別・全文が混ざって返る。**画面は
   * 何も言わずにそれを継ぎ足す**ので、読む側からは「検索結果の続き」に見える。
   */
  it('検索したまま遡ると、2頁目の要求に q と until の両方が載る', async () => {
    const base = new Date('2026-08-20T00:00:00.000Z').getTime();
    const page: JournalEntry[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'decision',
      id: `q-p${i}`,
      at: new Date(base - i * 60_000).toISOString(),
      decision: 'トマトの水やり',
      grounds: 'g',
    }));

    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) return json({ entries: [], scanned: 0 });
      return json({ entries: page, scanned: page.length });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('トマト')}`]);
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(2);
    });

    const second = new URL(stub.calls.filter((url) => url.includes('/journal'))[1]!);
    // #501 側（端と引数の対応）が生きている。
    expect(second.searchParams.get('until')).toBe(page.at(-1)!.at);
    // #250 側（絞り）も同じ要求に載っている。どちらかが他方を潰したら落ちる。
    expect(second.searchParams.get('q')).toBe('トマト');
  });

  it('検索していないときは、対象外の欄の断り書きを出さない', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByText(/tool_use の input/)).toBeNull();
  });

  it('検索しているときは、対象外の欄の断り書きを出す', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('トマト')}`]);
    await waitForLoaded();

    expect(screen.getByText(/tool_use の input/)).toBeTruthy();
  });
});
