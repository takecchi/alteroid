// @vitest-environment jsdom
/**
 * ダッシュボードについて3つ。
 *
 * 1. 「今日の利用」カードが、`/usage` 画面・CLI と同じ嘘をつかない規約を守っていること
 *    （`apps/cli/src/usage.ts` の docstring と同じ規約）
 * 2. 日誌を `AuthedShell` の購読から context 越しに受け取り、**自分では SSE を張らない**こと
 * 3. 「今日の利用」カードの「詳しく見る」が、カードの数字と同じ今日で `/usage` へ飛ぶこと
 *    （issue #2078）
 */
import { USAGE_ESTIMATE_NOTICE, usageDate, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalFeedProvider } from '~/hooks/journal-feed';
import { summarizeJournalEntry } from '~/hooks/queries';
import type { JournalLive } from '~/hooks/use-journal-live';
import type { JournalEntry } from '~/lib/types';
import {
  json,
  Providers,
  renderedMoneyTexts,
  stubFetch,
  storeTestBaseUrl,
  type FetchStub,
} from '~/test-support';

import Dashboard from './dashboard';

/*
  **`usageDate(new Date())` はローカル時刻を読むので、「今日」を固定するには
  TZ も固定する必要がある。** 理由（`vi.hoisted` でなければ静かに効かない
  事情、CI が UTC で手元が JST であること）は
  `apps/web/app/routes/reports.test.tsx` の冒頭に逐語で在るので、ここには
  写さない——同じ形をそのまま使う。
*/
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

const RECENT: JournalEntry = {
  type: 'decision',
  id: 'recent-decision',
  at: '2026-08-14T09:00:00.000Z',
  decision: 'たった今届いた判断',
  grounds: '記憶',
};

const EMPTY_FEED: JournalLive = { status: 'live', recent: [], receivedCount: 0 };

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

function renderDashboard(
  usageBody: {
    rows: unknown[];
    since: string | null;
    beforeLedger: boolean;
    notice?: string;
    turnRows?: unknown[];
  },
  live: JournalLive = EMPTY_FEED,
  // 既定は空のまま（既存のテストは全部これで、最新の日報カードを一度も
  // 描画経路に乗せていない）。「最新の日報」のテストだけがここへ渡す。
  // `unavailable` は「日報が書けなかった印」（`schema.ts`）。既定では付けないので、
  // 既存のテストは1つも振る舞いが変わらない。
  reports: Array<{
    type: 'daily_report';
    id: string;
    at: string;
    date: string;
    body: string;
    unavailable?: string;
  }> = [],
  // 概要カードが打ち切る側の分岐へ入れるための材料。既定は空なので、
  // 既存のテストは1つも振る舞いが変わらない。
  lists: { approvals?: unknown[]; managers?: unknown[] } = {},
  // 「次の自動実行」カードの材料。既定は空なので既存のテストは変わらない。
  scheduleEntries: Array<{ kind: string; description: string; nextAt: string }> = [],
  // **`/approvals` / `/schedule` を読めなかったことにする（issue #2138）。**
  // 既定はどちらも真っ当に取れるので、既存のテストは1つも振る舞いが変わらない。
  failures: { approvals?: boolean; schedule?: boolean } = {},
): FetchStub {
  // **`/journal/stream` の経路を置いていない。** 置くと購読が増えたことに気づけない
  // （知らない URL は `stubFetch` が「繋がらない」にするので、張りに行けば必ず出る）。
  const stub = stubFetch((url) => {
    if (url.includes('/reports')) return json({ reports });
    if (url.includes('/approvals')) {
      return failures.approvals === true
        ? json({ error: 'internal' }, 500)
        : json({ approvals: lists.approvals ?? [] });
    }
    if (url.includes('/managers')) return json({ managers: lists.managers ?? [] });
    if (url.includes('/schedule')) {
      return failures.schedule === true
        ? json({ error: 'internal' }, 500)
        : json({ entries: scheduleEntries });
    }
    if (url.includes('/usage')) {
      return json({
        ...usageBody,
        notice: usageBody.notice ?? USAGE_ESTIMATE_NOTICE,
        turnRows: usageBody.turnRows ?? [],
        breakdown: null,
      });
    }
    return undefined;
  });

  const router = createMemoryRouter([{ path: '/', Component: Dashboard }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <JournalFeedProvider value={live}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
  return stub;
}

describe('ダッシュボードの「今日の利用」', () => {
  it('台帳がまだ空（since が null）なら金額を1つも出さない', async () => {
    renderDashboard({ rows: [], since: null, beforeLedger: false });

    expect(await screen.findByText('まだ記録が無い。')).toBeTruthy();
    // ⛔ ここは `queryByText('$0.00')` だった。**`formatUsd` は `$0.00` を
    // 原理的に出さない**（`$1` 未満は小数4桁）ので、あの行は入力が何であっても
    // 真で、金額が出たかどうかを一度も測っていなかった（#935）。
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('beforeLedger が真なら、0 ではなく記録が無いと言い、金額を1つも出さない', async () => {
    renderDashboard({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: true });

    expect(await screen.findByText(/今日の分はまだ記録が無い/)).toBeTruthy();
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('金額が出ているときは但し書きも一緒に出す', async () => {
    renderDashboard({
      rows: [
        {
          date: '2026-08-14',
          managerId: 'm1',
          model: 'claude-opus-4',
          updatedAt: '2026-08-14T10:00:00.000Z',
          totals: { ...ZERO_USAGE, costUsd: 0.02 },
        },
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    expect(await screen.findByText('$0.0200')).toBeTruthy();
    expect(screen.getByText(USAGE_ESTIMATE_NOTICE)).toBeTruthy();
    // ⭐ **上の2本の陰性対照の対照である**（`renderedMoneyTexts` の doc）。網が壊れて
    // 常に空集合を返すようになったら、ここだけが赤くなる —— 陰性対照の側は緑のままで、
    // 「空で緑」と「正しく緑」は区別が付かない。
    expect(renderedMoneyTexts()).toEqual(new Set(['$0.0200']));
  });
});

/**
 * **「詳しく見る」が、カードの数字と同じ今日で `/usage` へ飛ぶ（issue #2078）。**
 *
 * 直す前は素の `/usage` へ飛んでいた——`/usage` は期間が無ければ絞らないので、
 * 今日の合計を見て押すと今日ではない期間が開く（issue 本文）。ここで固定するのは
 * 「今日」そのもの（`vi.setSystemTime`）と TZ（ファイル冒頭の `vi.hoisted`）——
 * どちらもカードが `usageDate(new Date())` で「今日」を作るときに読む値である。
 */
describe('「今日の利用」カードの「詳しく見る」は今日の期間へ飛ぶ（issue #2078）', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('カードの today と同じ from/to を持つ /usage を開く', () => {
    // 2026-08-14T05:00:00.000Z は TZ=Asia/Tokyo で 08/14 14:00（日を跨がない）。
    const fixedNow = new Date('2026-08-14T05:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      renderDashboard(USAGE);

      // **「詳しく見る」は「次の自動実行」カードとも文言が同じ**（#347 のテスト
      // が同じ理由でやっているのと同じ手当て）。href で `/usage` 宛てのものを選ぶ。
      const links = screen.getAllByRole('link', { name: '詳しく見る' });
      const usageLink = links.find((link) =>
        (link.getAttribute('href') ?? '').startsWith('/usage'),
      );
      expect(usageLink).toBeTruthy();

      // `usageDate` はカードが使っているのと同じ関数——書き写した期待値では
      // なく、同じ入力（固定した `fixedNow`）に対する同じ関数の戻り値と比べる。
      const today = usageDate(fixedNow);
      expect(usageLink!.getAttribute('href')).toBe(`/usage?from=${today}&to=${today}`);
      // 具体の日付でも固定して落ちることを確かめておく（TZ・system time の
      // 固定が本当に効いているかの対照）。
      expect(today).toBe('2026-08-14');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 「最新の日報」カードが本文を実際に描く経路を1度は通す。
 *
 * これまでの `renderDashboard` は `/reports` を常に空で固定していたので、
 * このカードは `Empty` の分岐しか通ったことが無かった。**Markdown 化した
 * こと自体を保証するテストではない**（それは `markdown.test.tsx` の仕事）
 * — ここが保証するのは「日報の本文がこのカードの描画経路へ実際に渡る」
 * ことだけ。見出し記法（`## 見出し`）を混ぜているのは、素通しの
 * `whitespace-pre-wrap` の文字列表示のままでは無いこと（＝描画経路を
 * 通したのが `report.body` の生文字列比較ではないこと）を区別するため。
 */
describe('「最新の日報」', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('日報の本文が Markdown の描画経路を通って出る', async () => {
    renderDashboard(USAGE, EMPTY_FEED, [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-14T22:00:00.000Z',
        date: '2026-08-14',
        body: '## 今日やったこと\n\n進捗があった。',
      },
    ]);

    expect(await screen.findByRole('heading', { name: '今日やったこと' })).toBeTruthy();
    expect(screen.getByText('進捗があった。')).toBeTruthy();
  });

  /**
   * **「日報が書けなかった」印の行を「最新の日報」として描かないこと。**
   *
   * ここは人間が最初に開く面である。発端の壊れ方（日報の本文が丸ごと
   * `You've hit your org's monthly spend limit …`）が最も目に付く形で残るのは
   * このカードなので、`/reports` と別に歯を置く（判定と文言は `reports.tsx` の
   * 1本を共有しているが、**このカードがそれを呼んでいるか**は別の事実である）。
   */
  it('日報が作れなかった日は、印として出す（本文を日報として描かない）', async () => {
    const reason = "You've hit your org's monthly spend limit · ask your admin to raise it";
    renderDashboard(USAGE, EMPTY_FEED, [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-20T22:00:00.000Z',
        date: '2026-08-20',
        // 見出し記法を混ぜてある。Markdown の経路へ流れたら見出しになるので、
        // 日報として描いていないことを区別できる。
        body: `## ${reason}`,
        unavailable: reason,
      },
    ]);

    expect(await screen.findByText('この日の日報は作れなかった')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: reason })).toBeNull();
  });
});

/**
 * 概要カードは全件を出さない（それは要件である）。**要件でないのは、切ったことが
 * 出力から消えることである。**
 *
 * 保証しているのは2方向で、片方だけでは足りない。
 *
 * - 上限を越えたら残数が出る — 出ないと「全部でこれだけ」と読める
 * - **ちょうど上限のときは出ない** — 常に出る但し書きは、出ていることが情報に
 *   ならない（「残り 0 件」を作ると、取れない軸に 0 の行を作るのと同じになる）
 */
describe('概要カードが打ち切ったことを言う', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  const approval = (n: number) => ({
    id: `approval-${n}`,
    createdAt: '2026-08-14T09:00:00.000Z',
    question: `質問 ${n}`,
  });

  const manager = (n: number) => ({
    managerId: `mgr-${n}`,
    status: 'running',
    live: true,
    cwd: '/workspace',
    request: `依頼 ${n}`,
    startedAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
  });

  const decision = (n: number): JournalEntry => ({
    type: 'decision',
    id: `decision-${n}`,
    at: '2026-08-14T09:00:00.000Z',
    decision: `判断 ${n}`,
    grounds: '記憶',
  });

  it('承認待ちが上限を越えたら、出していない件数を言う', async () => {
    const approvals = Array.from({ length: 8 }, (_, i) => approval(i));
    renderDashboard(USAGE, EMPTY_FEED, [], { approvals });

    // 上限は5なので、出るのは残り3件。
    expect(await screen.findByText(/残り 3 件は出していない/)).toBeTruthy();
    expect(screen.getByText('質問 0')).toBeTruthy();
    expect(screen.queryByText('質問 5')).toBeNull();
  });

  it('承認待ちがちょうど上限なら、但し書きを出さない', async () => {
    const approvals = Array.from({ length: 5 }, (_, i) => approval(i));
    renderDashboard(USAGE, EMPTY_FEED, [], { approvals });

    expect(await screen.findByText('質問 4')).toBeTruthy();
    expect(screen.queryByText(/件は出していない/)).toBeNull();
  });

  it('稼働中のマネージャーが上限を越えたら、出していない件数を言う', async () => {
    const managers = Array.from({ length: 7 }, (_, i) => manager(i));
    renderDashboard(USAGE, EMPTY_FEED, [], { managers });

    expect(await screen.findByText(/残り 2 件は出していない/)).toBeTruthy();
    expect(screen.getByText('依頼 0')).toBeTruthy();
    expect(screen.queryByText('依頼 5')).toBeNull();
  });

  it('届いている出来事が上限を越えたら、出していない件数を言う', async () => {
    const recent = Array.from({ length: 32 }, (_, i) => decision(i));
    renderDashboard(USAGE, { status: 'live', recent }, [], {});

    // 上限は30なので、出るのは残り2件。
    expect(await screen.findByText(/残り 2 件は出していない/)).toBeTruthy();
    expect(screen.getByText(summarizeJournalEntry(decision(0)))).toBeTruthy();
    expect(screen.queryByText(summarizeJournalEntry(decision(31)))).toBeNull();
  });
});

/**
 * 「稼働中のマネージャー」カードの件数が `m.status === 'running'` を直書き
 * していると、将来「実行中」を意味する新しい値が `jobStatusSchema`
 * （`packages/core/src/schema.ts`）へ足されても、この画面は**型検査にも
 * 落ちず、画面も落ちず**、件数からその分だけ静かに漏れる（9回目の横断
 * レビュー指摘。Issue は無い）。
 *
 * **まだ存在しない値を模して確かめる。** `jobStatusSchema` の現行6値は
 * すでに正しく扱えているので（直上の `describe`）、ここで踏みたいのは
 * *まだ無い将来の値*である——本物の値を1つ増やす改修は要件を動かすので、
 * 型を迂回したフィクスチャで代用する（`lists.managers` は `unknown[]`
 * なので、ここでのキャストは画面の型を1文字も緩めない）。
 *
 * `@alteroid/core/job-status-running` の `isRunningJobStatus` が安全側
 * （知らない値は実行中として数える）を選んでいるので、直した後はここが緑に
 * なる。直す前（`m.status === 'running'` の直書き）は、このマネージャーが
 * 一覧にも件数にも出ない。
 */
describe('「稼働中のマネージャー」は知らない status を静かに落とさない', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('jobStatusSchema にまだ無い「実行中」相当の値も、一覧と件数に含める', async () => {
    const managers = [
      {
        managerId: 'mgr-future-running',
        // **まだ `jobStatusSchema` に無い値。** 将来「実行中」を意味する
        // 値が足された、という状況を模す（上のファイル doc）。
        status: 'executing-in-background',
        live: true,
        cwd: '/workspace',
        request: '将来のrunning相当ステータス',
        startedAt: '2026-08-14T09:00:00.000Z',
        updatedAt: '2026-08-14T09:00:00.000Z',
      },
    ];
    renderDashboard(USAGE, EMPTY_FEED, [], { managers });

    // **先に非同期側（`findByText`）を待つ。** データが届く前に同期の
    // `queryByText` を読むと、読み込み中の空表示と区別が付かないまま
    // 「無かった」と誤判定する（このテストが実際にその形で一度落ちた）。
    // 直す前（`m.status === 'running'` の直書き）は、このマネージャーが
    // 一覧からも件数からも漏れて、`findByText` がタイムアウトして落ちる。
    expect(await screen.findByText('将来のrunning相当ステータス')).toBeTruthy();
    // ここまで来ればデータは届いている——「いま走っているものはない」
    // （0件の空表示）が同時に出ていないことを確かめられる。
    expect(screen.queryByText('いま走っているものはない。')).toBeNull();
  });
});

/**
 * 「一覧」は、カード自身の絞り込み（`isRunningJobStatus` が真にする状態）と
 * 同じ母集合で `/managers` へ飛ぶ（issue #2090）。**素の `/managers` へ戻すと、
 * 終わった・止まった委譲まで混ざった一覧が開く**——直す前の症状そのものを
 * 歯にする。値の組み立ては `~/lib/managers-links` の `managersHref`（そちらの
 * 単体テストが href の形そのものを見る）に任せ、ここでは「呼ばれているか・
 * `status` が空でないか」だけを見る。
 */
describe('「稼働中のマネージャー」の「一覧」は稼働中で絞り込む（issue #2090）', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('「一覧」の href が status=running を持つ', async () => {
    const managers = [
      {
        managerId: 'mgr-1',
        status: 'running',
        live: true,
        cwd: '/workspace',
        request: '依頼 1',
        startedAt: '2026-08-14T09:00:00.000Z',
        updatedAt: '2026-08-14T09:00:00.000Z',
      },
    ];
    renderDashboard(USAGE, EMPTY_FEED, [], { managers });

    const list = await screen.findByRole('link', { name: '一覧' });
    expect(list.getAttribute('href')).toBe('/managers?status=running');
  });
});

/**
 * 「次の自動実行」カードは、この画面の他5枚（最新の日報／承認待ち／稼働中の
 * マネージャー／今日の利用／いま届いている出来事）と違って `action` を持たず、
 * かつ `entry.description` を `truncate` で切っている唯一のカードだった
 * （本5「省略の出口」）。
 *
 * **ここで言えること / 言えないこと**: `action` の `<Link>` と `title` 属性は
 * DOM に出るので `getByRole('link', { name })` の `href` と `getByTitle` で
 * 引ける — 「リンクが在り行き先が `/schedule` であること」「`title` に
 * `entry.description` と同じ値が入っていること」はここで踏める。
 * jsdom はレイアウトを持たないので、「実際に狭い画面で文字が切れて hover で
 * 続きが読めること」はここでは確かめられない（クラス名が書かれたことまで）。
 */
describe('「次の自動実行」カードの出口', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };
  const LONG_DESCRIPTION =
    '毎朝5時に日報を締めて要約する定期ジョブ（設定を長くすると狭い画面では確実に切れる長さの説明文）';

  it('他5枚と同じ形で action にスケジュール画面へのリンクを持つ', async () => {
    renderDashboard(USAGE, EMPTY_FEED, [], {}, [
      { kind: 'daily_report', description: LONG_DESCRIPTION, nextAt: '2026-08-15T05:00:00.000Z' },
    ]);

    // 「今日の利用」カードの action も同じ文言（「詳しく見る」）を使っているので
    // `getByRole` 単体では一意にならない。href で `/schedule` へのものを選ぶ。
    await screen.findByText(LONG_DESCRIPTION, { exact: false });
    const links = screen.getAllByRole('link', { name: '詳しく見る' });
    const hrefs = links.map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/schedule');
  });

  it('entry.description が truncate で切られていても title で全文が引ける', async () => {
    renderDashboard(USAGE, EMPTY_FEED, [], {}, [
      { kind: 'daily_report', description: LONG_DESCRIPTION, nextAt: '2026-08-15T05:00:00.000Z' },
    ]);

    expect(await screen.findByTitle(LONG_DESCRIPTION)).toBeTruthy();
  });
});

/**
 * **「次の自動実行」カードが `/schedule` を読めないとき（issue #2138 の1）。**
 *
 * 直す前は `schedule.data` しか見ていなかったので、取れなかったときも
 * `data === undefined` の空表示（`—`）のままで、「予定が無い」と「読めて
 * いない」が見分けられなかった。ここで測るのは、失敗したら `ErrorNote`
 * （`role="alert"`）が出て、その代わりの空表示（`—`）にも予定の一覧にも
 * ならないこと——`error !== undefined` の分岐を外す変異（元のバグと同じ
 * 形）を当てると、`—` の空表示に戻って `alert` が見つからず赤くなる。
 */
describe('「次の自動実行」カードが読めないとき（issue #2138 の1）', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('取り直しに失敗すると ErrorNote を出す（空表示 `—` のままにしない）', async () => {
    renderDashboard(
      USAGE,
      EMPTY_FEED,
      [],
      {},
      [{ kind: 'daily_report', description: '古い予定', nextAt: '2026-08-15T05:00:00.000Z' }],
      { schedule: true },
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    // 一覧（古い予定）にはならない。既存の空表示（`—`）にも戻らない。
    expect(screen.queryByText('古い予定')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });
});

/**
 * **「承認待ち」カード見出しの「答える」リンクが、読めていないときに出ない
 * こと（issue #2138 の2）。**
 *
 * 直す前は `pending.length > 0` だけを見ていたので、一度取れた後に取り直しが
 * 失敗しても（SWR は直前の `data` を残す）「答える」だけが古い件数のまま
 * 出続け、本文の `ErrorNote`（「読めていない」）と同じカードに同時に出て
 * いた。**単発の失敗スタブでは `data` が一度も定まらず `pending` が常に0件
 * になるので、`pending.length > 0` だけを見ていた旧コードでもリンクは出ず、
 * この分岐の欠落を見分けられない** —— だから、いったん成功させて
 * `pending` を非0にしたあと `/approvals` だけを失敗に切り替え、`window`
 * の `focus` イベント（SWR 既定の `revalidateOnFocus` が拾う）で再取得を
 * 起こし、`data` が古いまま残る状態を作る。
 */
describe('「承認待ち」カードが読めないとき、「答える」を出さない（issue #2138 の2）', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };
  const approval = (n: number) => ({
    id: `approval-${n}`,
    createdAt: '2026-08-14T09:00:00.000Z',
    question: `質問 ${n}`,
  });

  it('一度取れた後に /approvals が失敗すると、古い件数のまま「答える」を出し続けない', async () => {
    const stub = renderDashboard(USAGE, EMPTY_FEED, [], { approvals: [approval(0)] });

    // まず正常系——「答える」が出ていることを確かめてから話を壊す。
    await screen.findByRole('link', { name: '答える' });

    // `/approvals` だけを失敗に切り替える（他の経路は元のまま存続させる）。
    stub.setRoute((url) => {
      if (url.includes('/approvals')) return json({ error: 'internal' }, 500);
      if (url.includes('/reports')) return json({ reports: [] });
      if (url.includes('/managers')) return json({ managers: [] });
      if (url.includes('/schedule')) return json({ entries: [] });
      if (url.includes('/usage')) {
        return json({ ...USAGE, notice: USAGE_ESTIMATE_NOTICE, turnRows: [], breakdown: null });
      }
      return undefined;
    });
    // SWR 既定の `revalidateOnFocus` を使って再取得を起こす（`dedupingInterval: 0`
    // なので即座に飛ぶ——`test-support.tsx` の `Providers` の設定）。
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByRole('alert')).toBeTruthy();
    // 古い `pending`（質問0）が残っていても「答える」は出ない。
    expect(screen.queryByRole('link', { name: '答える' })).toBeNull();
  });
});

describe('日誌は AuthedShell の購読から受け取る', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('context の recent をそのまま出す', async () => {
    renderDashboard(USAGE, { status: 'live', recent: [RECENT], receivedCount: 1 });

    expect(await screen.findByText(summarizeJournalEntry(RECENT))).toBeTruthy();
  });

  /**
   * **行が指している実体の詳細へつなぐ（issue #2071）。** マネージャー発の
   * `escalation` は委譲へ、`memory_update` は記憶へ。つなぐ先の無い `decision`
   * （`RECENT`）の行にはリンクを出さない。どれをつなぐかの規則そのものは
   * `lib/journal-links.test.tsx` が持つ。
   */
  it('recent の行から委譲の詳細・記憶へ飛べる（つなぐ先の無い行には出さない）', async () => {
    const escalation: JournalEntry = {
      type: 'escalation',
      id: 'recent-escalation',
      at: '2026-08-14T09:01:00.000Z',
      question: '進めてよいか',
      approvalId: 'a-1',
      managerId: 'mgr-42',
    };
    const memory: JournalEntry = {
      type: 'memory_update',
      id: 'recent-memory',
      at: '2026-08-14T09:02:00.000Z',
      slug: 'values',
      summary: '価値観を足した',
      cause: 'human',
    };
    renderDashboard(USAGE, {
      status: 'live',
      recent: [memory, escalation, RECENT],
      receivedCount: 3,
    });

    const decisionRow = (await screen.findByText(summarizeJournalEntry(RECENT))).closest('li');
    expect(decisionRow).not.toBeNull();
    expect(decisionRow!.querySelector('a')).toBeNull();

    const toManager = screen.getByRole('link', { name: '委譲 mgr-42 の詳細' });
    expect(toManager.getAttribute('href')).toBe('/managers/mgr-42');
    expect(toManager.textContent).toBe('委譲 →');
    const toMemory = screen.getByRole('link', { name: '記憶 values（いまの版）' });
    expect(toMemory.getAttribute('href')).toBe('/memory/values');
    expect(toMemory.textContent).toBe('記憶 →');
  });

  it('自分では SSE を張らない（購読は AuthedShell の1本だけ）', async () => {
    const stub = renderDashboard(USAGE, {
      status: 'live',
      recent: [RECENT],
      receivedCount: 1,
    });

    // 画面が出揃うまで待ってから見る（描画前に数えると、張っていても空になる）。
    await screen.findByText(summarizeJournalEntry(RECENT));
    expect(stub.calls.filter((url) => url.includes('/journal/stream'))).toEqual([]);
  });

  /**
   * **切ったことを言う（Issue #426 の G3）。** `recent` は購読側
   * （`use-journal-live.ts`）の `RECENT_LIMIT`（200件）で頭打ちにしてある
   * ので、`recent.length` を但し書きの `total` に使うと 200件を超えて届いた
   * 分が消える。`receivedCount`（上限を掛けずに1件ごと積んだ値）を使う
   * ことで、`recent.length` が小さいままでも本当の総数が出せることを
   * 固定する — この歯は `total={live.recent.length}` へ戻す変異で赤くなる
   * （`recent` は1件だけなので、その変異では但し書きが出なくなる）。
   */
  it('但し書きの total は recent.length ではなく receivedCount を使う', async () => {
    renderDashboard(USAGE, { status: 'live', recent: [RECENT], receivedCount: 999 });

    await screen.findByText(summarizeJournalEntry(RECENT));
    expect(await screen.findByText(/残り 969 件は出していない/)).toBeTruthy();
  });
});
