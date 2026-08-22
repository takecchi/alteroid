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
 * この事実が、下の6本のテストのうち5本（`screen.findByText`/`getByText` で
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
 * **反転後にこの5本が測っているのは「virtua が jsdom で描かないこと」の
 * canary であって、マージ規則そのものの正しさではない。** それでも消さずに
 * 残すのは、①virtua や jsdom 側の挙動がいつか変わって本当に描かれるように
 * なったときに気づける、②チップ絞り込みが実際にサーバへの再取得を動かす
 * ことは（後述のとおり）このテストでいまも測れているからである。
 *
 * **測れなくなったもの・移設したものを PR 本文に列挙してある**
 * （テスト名で数える）。
 */
import { JOURNAL_ENTRY_TYPES } from '@alteroid/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

function renderJournal(live: JournalLive) {
  return render(
    <Providers>
      <JournalFeedProvider value={live}>
        <Journal />
      </JournalFeedProvider>
    </Providers>,
  );
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
