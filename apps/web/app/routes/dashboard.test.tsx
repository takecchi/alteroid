// @vitest-environment jsdom
/**
 * ホーム（`dashboard.tsx`）の小さなカードと、「承認待ち一覧」の段。
 *
 * 旧ダッシュボードのテストから引き継いだ保証（どこへ移ったか）:
 * - 「今日の利用」の嘘をつかない規約・「詳しく見る」の行き先・デーモンの暦の今日・読めずに外した行
 *   → 「今日の利用」カードの describe 群（中身は同じ）
 * - 「最新の日報」: 印の付いた行を日報として描かない → 同じ。**全幅の枠で本文を Markdown として描く**
 *   ようになった（`dashboard-report.tsx`）
 * - 承認待ちの打ち切り・「答える」を読めていないときに出さない → 「承認待ち一覧」の describe
 * - 「次の自動実行」の出口・読めないとき・読めない継続中の依頼 → 同じ
 * - 「稼働中のマネージャー」カードと「いま届いている出来事」は**ホームから外した**。前者の
 *   「読めない委譲を隠さない」は地図の下の断りへ、「知らない status を静かに落とさない」は
 *   `packages/logic/src/topology-scene.test.ts`（unknown へ倒す）へ、後者の「自分では SSE を張らない」
 *   は本ファイルの「日誌の購読を張らない」へ移した
 */
import { USAGE_ESTIMATE_NOTICE, usageDate, ZERO_USAGE } from '@alteroid/core/usage';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderedMoneyTexts, storeTestBaseUrl } from '~/test-support';

import { homeRoute, PROGRESS_BODY, renderHome } from './dashboard-test-helpers';

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

const USAGE = { rows: [], since: null, beforeLedger: false };

/** 「詳しく見る」は複数のカードが持つ。href で行き先を選ぶ。 */
function linkTo(prefix: string): HTMLElement | undefined {
  return screen
    .getAllByRole('link', { name: '詳しく見る' })
    .find((link) => (link.getAttribute('href') ?? '').startsWith(prefix));
}

describe('ホームの構成', () => {
  it('見出しはホームで、旧ダッシュボードの2枚（稼働中のマネージャー・いま届いている出来事）は無い', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: 'ホーム' })).toBeTruthy();
    expect(screen.getByText('稼働状況')).toBeTruthy();
    for (const title of ['最新の日報', '作業の進捗', '次の自動実行', '今日の利用']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.queryByText('稼働中のマネージャー')).toBeNull();
    expect(screen.queryByText('いま届いている出来事')).toBeNull();
  });

  it('日誌の購読（/journal/stream）を張らない。購読は AuthedShell の1本だけ', async () => {
    // **`/journal/stream` の経路を置いていない。** 張りに行けば `stubFetch` が「繋がらない」にし、
    // `calls` に残る。
    const stub = renderHome();
    await screen.findByText(/^まだ記録が無い。/);

    expect(stub.calls.filter((url) => url.includes('/journal'))).toEqual([]);
  });
});

describe('「今日の利用」', () => {
  it('台帳がまだ空（since が null）なら金額を1つも出さない', async () => {
    renderHome({ usage: { rows: [], since: null, beforeLedger: false } });

    expect(await screen.findByText(/^まだ記録が無い。/)).toBeTruthy();
    // ⛔ ここは `queryByText('$0.00')` だった。**`formatUsd` は `$0.00` を
    // 原理的に出さない**（`$1` 未満は小数4桁）ので、あの行は入力が何であっても
    // 真で、金額が出たかどうかを一度も測っていなかった（#935）。
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('beforeLedger が真なら、0 ではなく記録が無いと言い、金額を1つも出さない', async () => {
    renderHome({ usage: { rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: true } });

    expect(await screen.findByText(/今日の分はまだ記録が無い/)).toBeTruthy();
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('金額が出ているときは但し書きも一緒に出す', async () => {
    renderHome({
      usage: {
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
      },
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
 * 「今日」そのもの（`vi.setSystemTime`）と TZ（ファイル冒頭の `vi.hoisted`）。
 */
describe('「今日の利用」カードの「詳しく見る」は今日の期間へ飛ぶ（issue #2078）', () => {
  it('カードの today と同じ from/to を持つ /usage を開く', async () => {
    // 2026-08-14T05:00:00.000Z は TZ=Asia/Tokyo で 08/14 14:00（日を跨がない）。
    const fixedNow = new Date('2026-08-14T05:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixedNow);
    try {
      renderHome({ usage: USAGE });

      // 応答の `today` が来てからリンクが出る（それまでは出さない。issue #2268）。
      await screen.findByText(/^まだ記録が無い。/);
      const usageLink = linkTo('/usage');
      expect(usageLink).toBeTruthy();

      // 「今日」は応答の `today`（デーモンの暦）。ここではブラウザの今日と同じ日にしてある。
      const today = usageDate(fixedNow);
      expect(usageLink!.getAttribute('href')).toBe(`/usage?from=${today}&to=${today}`);
      // 具体の日付でも固定して落ちることを確かめておく（TZ・system time の固定が本当に
      // 効いているかの対照）。
      expect(today).toBe('2026-08-14');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * **「今日」はブラウザの TZ ではなくデーモンの暦で決まる（issue #2268）。**
 *
 * 直す前は `usageDate(new Date())`（ブラウザの今日）で `from = to = 今日` を引いていたので、
 * デーモンの TZ とブラウザの TZ が違う日に、別の日の行を「今日の利用」に出し、リンクも
 * 別の日へ飛んだ。
 */
describe('「今日の利用」の今日はデーモンの応答の today で決まる（issue #2268）', () => {
  // ブラウザ（TZ=Asia/Tokyo、冒頭の `vi.hoisted`）の今日は 2026-10-01（09-30T20:00Z = 10/01 05:00）。
  const browserNow = new Date('2026-09-30T20:00:00.000Z');
  // デーモンは別の TZ で、まだ 2026-09-30。
  const DAEMON_TODAY = '2026-09-30';
  const row = (date: string, costUsd: number) => ({
    date,
    managerId: 'm1',
    model: 'claude-opus-4',
    updatedAt: '2026-09-30T10:00:00.000Z',
    totals: { ...ZERO_USAGE, costUsd },
  });

  it('ブラウザの今日の前後2日で1回だけ引き、応答の today の行とリンクを使う', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(browserNow);
    try {
      const stub = renderHome({
        usage: {
          // 応答の today（09-30）の行と、ブラウザの今日（10-01）の行が別の金額で並ぶ。
          rows: [row('2026-09-29', 0.01), row(DAEMON_TODAY, 0.02), row('2026-10-01', 0.04)],
          since: '2026-08-01T00:00:00.000Z',
          beforeLedger: false,
          today: DAEMON_TODAY,
        },
      });

      // 応答の today の行だけが「今日の利用」になる（ブラウザの今日の行 $0.0400 ではない）。
      expect(await screen.findByText('$0.0200')).toBeTruthy();
      expect(renderedMoneyTexts()).toEqual(new Set(['$0.0200']));
      expect(linkTo('/usage')!.getAttribute('href')).toBe(
        `/usage?from=${DAEMON_TODAY}&to=${DAEMON_TODAY}`,
      );

      // 引くのは1回だけで、窓はブラウザの今日（2026-10-01）の前後2日。
      const usageCalls = stub.calls.filter((url) => url.includes('/usage'));
      expect(usageCalls).toHaveLength(1);
      const query = new URL(usageCalls[0]!).searchParams;
      expect(query.get('from')).toBe('2026-09-29');
      expect(query.get('to')).toBe('2026-10-03');
    } finally {
      vi.useRealTimers();
    }
  });

  it('応答に today が無い（古いデーモン）とき、ブラウザの今日にせず、分からないと出す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(browserNow);
    try {
      renderHome({
        usage: {
          rows: [row('2026-10-01', 0.04)],
          since: '2026-08-01T00:00:00.000Z',
          beforeLedger: false,
          today: null,
        },
      });

      expect(await screen.findByText(/サーバの今日が分からない/)).toBeTruthy();
      // ブラウザの今日の行の金額を出さず、ブラウザの今日へのリンクも作らない。
      expect(renderedMoneyTexts()).toEqual(new Set());
      expect(linkTo('/usage')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * **「今日の利用」カードの、読めずに集計から外した行（#2427）。** 窓（今日の前後2日）から、
 * 今日の行か、日が取れない行だけに絞って断る。
 */
describe('「今日の利用」カードの読めずに外した行（#2427）', () => {
  const unreadable = (date?: string) => ({
    ...(date === undefined ? {} : { date }),
    reason: '不正な欄: totals',
  });
  const base = { rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false };

  it('今日の行が読めずに外れていれば、合計に入っていないと言う', async () => {
    renderHome({ usage: { ...base, unreadableRows: [unreadable('2026-08-14')] } });

    expect(await screen.findByText(/合計に入っていない/)).toBeTruthy();
  });

  it('今日ではない日の行は、このカードでは言わない', async () => {
    renderHome({ usage: { ...base, unreadableRows: [unreadable('2026-08-13')] } });

    await screen.findByText('推定');
    expect(screen.queryByText(/合計に入っていない/)).toBeNull();
  });

  it('日が取れない行は、今日ではないと言い切れないので言う', async () => {
    renderHome({ usage: { ...base, unreadableRows: [unreadable()] } });

    expect(await screen.findByText(/合計に入っていない/)).toBeTruthy();
  });

  it('#3614: 記録が空（since が null）でも外した行が在れば、「記録が無い」と言い切らない', async () => {
    renderHome({
      usage: { ...base, since: null, unreadableRows: [unreadable('2026-08-14')] },
    });

    expect(await screen.findByText(/読めずに外した行がある/)).toBeTruthy();
    expect(screen.queryByText(/まだ記録が無い/)).toBeNull();
  });

  it('#3614: 外した行が無ければ、since が null の文言は変わらない', async () => {
    renderHome({ usage: { ...base, since: null, unreadableRows: [unreadable('2026-08-13')] } });

    expect(await screen.findByText(/まだ記録が無い/)).toBeTruthy();
    expect(screen.queryByText(/読めずに外した行がある/)).toBeNull();
  });

  it('#3614: 記録の始点より前（beforeLedger）でも外した行が在れば、「記録が無い」と言い切らない', async () => {
    renderHome({
      usage: { ...base, beforeLedger: true, unreadableRows: [unreadable()] },
    });

    expect(await screen.findByText(/今日の分は、読めた記録が無い/)).toBeTruthy();
    expect(screen.queryByText(/今日の分はまだ記録が無い/)).toBeNull();
  });

  it('#3614: beforeLedger で外した行が無ければ、文言は変わらない', async () => {
    renderHome({
      usage: { ...base, beforeLedger: true, unreadableRows: [unreadable('2026-08-13')] },
    });

    expect(await screen.findByText(/今日の分はまだ記録が無い/)).toBeTruthy();
    expect(screen.queryByText(/読めずに外した行がある/)).toBeNull();
  });

  it('対照: 欄が無い・空配列なら、何も出さない', async () => {
    renderHome({ usage: { ...base, unreadableRows: [] } });

    await screen.findByText('推定');
    expect(screen.queryByText(/合計に入っていない/)).toBeNull();
  });
});

/**
 * 日報の本文の枠が実際にはみ出しているかを、jsdom に与える。
 *
 * **jsdom はレイアウトを持たない**（`scrollHeight` / `clientHeight` は常に 0）ので、枠が
 * 「切れているか」は何も入れなければ永久に偽になる。製品が読むのは枠の `scrollHeight` と
 * `clientHeight` の2つだけなので、そこだけを枠（`data-slot="home-report-body"`）に限って
 * 差し込む。**固定値を全要素へ返すスタブにしない**（ほかの要素の寸法まで嘘になる）。
 */
function stubReportOverflow(scrollHeight: number, clientHeight: number): void {
  const forFrame = (value: number) =>
    function (this: HTMLElement) {
      return this.dataset.slot === 'home-report-body' ? value : 0;
    };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(forFrame(scrollHeight));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(forFrame(clientHeight));
}

describe('「最新の日報」', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const report = (extra: Record<string, unknown>) => ({
    type: 'daily_report',
    id: 'r1',
    at: '2026-08-14T22:00:00.000Z',
    date: '2026-08-14',
    body: '本文',
    ...extra,
  });

  it('本文は Markdown として描かれ（見出し・強調）、日報一覧への入口を持つ', async () => {
    stubReportOverflow(900, 384);
    renderHome({ reports: [report({ body: '## 今日やったこと\n\n- **進捗**があった。' })] });

    expect(await screen.findByRole('heading', { name: '今日やったこと' })).toBeTruthy();
    expect(screen.getByText('進捗').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: '日報一覧' }).getAttribute('href')).toBe('/reports');
  });

  it('長い本文でも、本文の枠は高さで切られ（overflow-hidden・max-h）、「全文を表示」が出る', async () => {
    stubReportOverflow(2400, 384);
    const body = Array.from({ length: 80 }, (_, i) => `段落 ${i}`).join('\n\n');
    renderHome({ reports: [report({ body })] });

    await screen.findByText('段落 0');
    const frame = document.querySelector('[data-slot="home-report-body"]')!;
    // 切れているときだけフェードを掛ける。
    expect(frame.getAttribute('data-truncated')).toBe('true');
    expect(document.querySelector('[data-slot="home-report-fade"]')).not.toBeNull();
    expect(frame.className).toContain('overflow-hidden');
    expect(frame.className).toContain('max-h-96');
    expect(frame.className).toContain('min-w-0');
    expect(screen.getByRole('button', { name: '全文を表示' })).toBeTruthy();
  });

  /**
   * #2771: 1行しかない日報の本文が、薄れで読めなくなり、続きの無い「続きを読む」だけが出ていた。
   * 切れていない（`scrollHeight` が `clientHeight` に収まっている）ときは、どちらも出さない。
   */
  it('短くて切れていない本文には、フェードも「全文を表示」も出さない', async () => {
    stubReportOverflow(24, 24);
    renderHome({ reports: [report({ body: '同日2件目の日報。' })] });

    await screen.findByText('同日2件目の日報。');
    const frame = document.querySelector('[data-slot="home-report-body"]')!;
    expect(frame.getAttribute('data-truncated')).toBe('false');
    expect(document.querySelector('[data-slot="home-report-fade"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /全文を表示|畳む/ })).toBeNull();
    // 日報一覧への入口は残る。
    expect(screen.getByRole('link', { name: '日報一覧' })).toBeTruthy();
  });

  /** オーナーの依頼（2026-10-05）: 「すべて見る」で日報のページへ飛ばず、その場で全文に広げる。 */
  it('「全文を表示」でその場に全文へ広がり、「畳む」で戻る（aria-expanded が追う）', async () => {
    stubReportOverflow(2400, 384);
    const body = Array.from({ length: 80 }, (_, i) => `段落 ${i}`).join('\n\n');
    renderHome({ reports: [report({ body })] });

    await screen.findByText('段落 0');
    const frame = document.querySelector('[data-slot="home-report-body"]')!;
    const button = screen.getByRole('button', { name: '全文を表示' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(frame.id);

    fireEvent.click(button);
    const opened = screen.getByRole('button', { name: '畳む' });
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    expect(frame.className).not.toContain('max-h-96');
    expect(frame.className).not.toContain('overflow-hidden');
    expect(document.querySelector('[data-slot="home-report-fade"]')).toBeNull();
    // 日報のページへは移らず、本文も同じ場所に在る。
    expect(screen.getByText('段落 79')).toBeTruthy();

    fireEvent.click(opened);
    expect(screen.getByRole('button', { name: '全文を表示' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(frame.className).toContain('max-h-96');
    expect(document.querySelector('[data-slot="home-report-fade"]')).not.toBeNull();
  });

  it('本文の秘密は描画の直前に伏せる（偽のトークン。40桁の sha は残す）', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const sha = '0123456789abcdef0123456789abcdef01234567';
    renderHome({ reports: [report({ body: `x ${token} y ${sha}` })] });

    const excerpt = await screen.findByText(/y 0123456789abcdef/);
    expect(excerpt.textContent).not.toContain(token);
    expect(excerpt.textContent).toContain(sha);
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
    renderHome({
      reports: [report({ date: '2026-08-20', body: `## ${reason}`, unavailable: reason })],
    });

    expect(await screen.findByText('この日の日報は作れなかった')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    // 本文としても出ない（Markdown の描画を通らない）。
    expect(screen.queryByRole('button', { name: '全文を表示' })).toBeNull();
    expect(screen.queryByText(`## ${reason}`)).toBeNull();
    expect(screen.queryByRole('heading', { name: reason })).toBeNull();
  });

  it('日報が無いとき、読み込み中は空の文言を出さず、取れたら出す', async () => {
    renderHome({ reports: [] });

    expect(await screen.findByText(/まだ日報がない/)).toBeTruthy();
  });
});

/**
 * 承認待ちの行は全件を出さない（それは要件である）。**要件でないのは、切ったことが出力から
 * 消えることである。**
 *
 * - 上限を越えたら残数が出る — 出ないと「全部でこれだけ」と読める
 * - **ちょうど上限のときは出ない** — 常に出る但し書きは、出ていることが情報にならない
 *   （「残り 0 件」を作ると、取れない軸に 0 の行を作るのと同じになる）
 */
describe('「承認待ち一覧」が打ち切ったことを言う', () => {
  const approval = (n: number) => ({
    id: `approval-${n}`,
    createdAt: '2026-08-14T09:00:00.000Z',
    question: `質問 ${n}`,
  });

  it('承認待ちが上限を越えたら、出していない件数を言う', async () => {
    renderHome({ approvals: Array.from({ length: 8 }, (_, i) => approval(i)) });

    // 上限は5なので、出るのは残り3件。
    expect(await screen.findByText(/残り 3 件は出していない/)).toBeTruthy();
    expect(screen.getByText('質問 0')).toBeTruthy();
    expect(screen.queryByText('質問 5')).toBeNull();
  });

  it('承認待ちがちょうど上限なら、但し書きを出さない', async () => {
    renderHome({ approvals: Array.from({ length: 5 }, (_, i) => approval(i)) });

    expect(await screen.findByText('質問 4')).toBeTruthy();
    expect(screen.queryByText(/件は出していない/)).toBeNull();
  });
});

describe('「承認待ち一覧」', () => {
  const approval = (n: number) => ({
    id: `approval-${n}`,
    createdAt: '2026-08-14T09:00:00.000Z',
    question: `質問 ${n}`,
  });

  it('承認待ちが0件なら、1行に畳む（見出しも「答える」も出さない）', async () => {
    renderHome({ approvals: [] });

    expect(await screen.findByText('承認待ちはない')).toBeTruthy();
    expect(screen.queryByText('承認待ち一覧')).toBeNull();
    expect(screen.queryByRole('link', { name: '答える' })).toBeNull();
  });

  it('承認待ちがあれば、質問・「答える」・未了の仕事の件数を出す。件数は全体で、人間の番とは言わない', async () => {
    renderHome({ approvals: [approval(0)] });

    expect(await screen.findByText('質問 0')).toBeTruthy();
    expect(screen.getByRole('link', { name: '答える' }).getAttribute('href')).toBe('/approvals');
    const row = (await screen.findByRole('link', { name: '仕事へ' })).closest('li')!;
    expect(within(row).getByText('5')).toBeTruthy();
    expect(within(row).getByRole('link', { name: '仕事へ' }).getAttribute('href')).toBe(
      '/commitments',
    );
    expect(screen.queryByText(/人間の番/)).toBeNull();
  });

  it('未了の数が欠けうる（読めない行がある）ときは、下限だと言う。欠けていなければ言わない', async () => {
    renderHome({
      approvals: [approval(0)],
      progress: {
        ...PROGRESS_BODY,
        backlog: {
          ...PROGRESS_BODY.backlog,
          completeness: { unreadable: 1, trimmedClosed: 0, unreadableJobs: 0 },
        },
      },
    });

    const row = (await screen.findByRole('link', { name: '仕事へ' })).closest('li')!;
    expect(row.textContent).toContain('下限');
  });

  it('刈られた完了済みの行だけ（unreadable が 0）なら、未了の数を下限と言わない（#3698）', async () => {
    renderHome({
      approvals: [approval(0)],
      progress: {
        ...PROGRESS_BODY,
        backlog: {
          ...PROGRESS_BODY.backlog,
          completeness: { unreadable: 0, trimmedClosed: 4, unreadableJobs: 0 },
        },
      },
    });

    const row = (await screen.findByRole('link', { name: '仕事へ' })).closest('li')!;
    expect(row.textContent).not.toContain('下限');
  });

  it('対照: 欠けていない既定の応答では、下限と言わない', async () => {
    renderHome({ approvals: [approval(0)] });

    const row = (await screen.findByRole('link', { name: '仕事へ' })).closest('li')!;
    expect(row.textContent).not.toContain('下限');
  });

  it('進捗を読めないときは、未了の行を出さない（0 件と描かない）。承認待ちはそのまま出る', async () => {
    renderHome({ approvals: [approval(0)], progress: 'fail' });

    expect(await screen.findByText('質問 0')).toBeTruthy();
    // 進捗のカード側の「未了の仕事 N 件」も出ない（読めていない）ので、行き先ごと無い。
    expect(screen.queryByRole('link', { name: '仕事へ' })).toBeNull();
  });
});

/**
 * **「答える」リンクが、読めていないときに出ないこと（issue #2138 の2）。**
 *
 * 直す前は `pending.length > 0` だけを見ていたので、一度取れた後に取り直しが失敗しても
 * （SWR は直前の `data` を残す）「答える」だけが古い件数のまま出続け、本文の `ErrorNote`
 * （「読めていない」）と同じカードに同時に出ていた。**単発の失敗スタブでは `data` が一度も
 * 定まらず `pending` が常に0件になるので、この分岐の欠落を見分けられない** —— だから、
 * いったん成功させて `pending` を非0にしたあと `/approvals` だけを失敗に切り替え、`window` の
 * `focus` イベント（SWR 既定の `revalidateOnFocus` が拾う）で再取得を起こし、`data` が古いまま
 * 残る状態を作る。
 */
describe('「承認待ち一覧」が読めないとき、「答える」を出さない（issue #2138 の2）', () => {
  it('一度取れた後に /approvals が失敗すると、古い件数は残し、取り直せなかったと注記する（issue #3346）', async () => {
    const stub = renderHome({
      topology: { frames: [] },
      approvals: [{ id: 'approval-0', createdAt: '2026-08-14T09:00:00.000Z', question: '質問 0' }],
    });

    // まず正常系——「答える」が出ていることを確かめてから話を壊す。
    await screen.findByRole('link', { name: '答える' });

    // `/approvals` だけを失敗に切り替える（他の経路は元のまま存続させる）。
    stub.setRoute(homeRoute({ approvals: 'fail', topology: { frames: [] } }));
    // SWR 既定の `revalidateOnFocus` を使って再取得を起こす（`dedupingInterval: 0` なので即座に
    // 飛ぶ——`test-support.tsx` の `Providers` の設定）。
    window.dispatchEvent(new Event('focus'));

    // 進捗のタイルと同じ形（#3069 / #3346）: 中身は残し、画面を奪わず、その場で失敗を言う。
    expect(await screen.findByText(/最新の承認待ちを取り直せなかった/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('質問 0')).toBeTruthy();
    expect(screen.getByRole('link', { name: '答える' })).toBeTruthy();
  });
});

/**
 * 「次の自動実行」カード: 他のカードと同じ形で `action` にスケジュール画面へのリンクを持ち、
 * `entry.description` を `truncate` で切るので `title` で全文を引けるようにしてある。
 *
 * **ここで言えること / 言えないこと**: `action` の `<Link>` と `title` 属性は DOM に出るので
 * `href` と `getByTitle` で引ける。jsdom はレイアウトを持たないので、「実際に狭い画面で文字が
 * 切れて hover で続きが読めること」はここでは確かめられない（クラス名が書かれたことまで）。
 */
describe('「次の自動実行」カード', () => {
  const LONG_DESCRIPTION =
    '毎朝5時に日報を締めて要約する定期ジョブ（設定を長くすると狭い画面では確実に切れる長さの説明文）';
  const entry = (description: string, nextAt: string) => ({
    kind: description,
    description,
    nextAt,
  });

  it('スケジュール画面へのリンクを持つ', async () => {
    renderHome({
      schedule: { entries: [entry(LONG_DESCRIPTION, '2026-08-15T05:00:00.000Z')] },
    });

    await screen.findByText(LONG_DESCRIPTION, { exact: false });
    expect(screen.getByRole('link', { name: '予定へ' }).getAttribute('href')).toBe('/schedule');
  });

  it('description が truncate で切られていても title で全文が引ける', async () => {
    renderHome({
      schedule: { entries: [entry(LONG_DESCRIPTION, '2026-08-15T05:00:00.000Z')] },
    });

    expect(await screen.findByTitle(LONG_DESCRIPTION)).toBeTruthy();
  });

  it('いちばん近い1件を出し、残りは件数で言う（並びの先頭ではなく時刻で選ぶ）', async () => {
    renderHome({
      schedule: {
        entries: [
          entry('遠い予定', '2026-08-20T05:00:00.000Z'),
          entry('近い予定', '2026-08-15T05:00:00.000Z'),
          entry('中くらい', '2026-08-17T05:00:00.000Z'),
        ],
      },
    });

    expect(await screen.findByText('近い予定')).toBeTruthy();
    expect(screen.queryByText('遠い予定')).toBeNull();
    expect(screen.getByText('ほか 2 件')).toBeTruthy();
  });

  it('予定が0件のとき、読み込み中ではなく「予定はない」と言う', async () => {
    renderHome({ schedule: { entries: [] } });

    expect(await screen.findByText('予定はない。')).toBeTruthy();
  });

  it('予定が0件でも読めない依頼が在るときは、「予定はない」と言い切らない（#3538）', async () => {
    renderHome({
      schedule: { entries: [], unreadable: [{ kind: 'broken-1', reason: '不正な欄: spec' }] },
    });

    expect(await screen.findByText('読めた範囲では、予定はない。')).toBeTruthy();
    expect(screen.queryByText('予定はない。')).toBeNull();
  });

  /**
   * **読めないとき（issue #2138 の1）。** 直す前は `schedule.data` しか見ていなかったので、
   * 取れなかったときも空表示のままで、「予定が無い」と「読めていない」が見分けられなかった。
   */
  it('取り直しに失敗すると ErrorNote を出す（予定が無いことにしない）', async () => {
    renderHome({ schedule: 'fail' });

    const card = (await screen.findByText('次の自動実行')).closest<HTMLElement>(
      '[data-slot="card"]',
    )!;
    expect(await within(card).findByRole('alert')).toBeTruthy();
    expect(within(card).queryByText('予定はない。')).toBeNull();
  });

  /**
   * **読めない継続中の依頼を「予定が無い」の顔で隠さない（#2343）。** 0件（鍵が無い）のとき
   * は何も出さない。
   */
  it('読めない行が在るとき、件数と kind を断る。読めた予定はそのまま出る', async () => {
    renderHome({
      schedule: {
        entries: [entry('毎日 22:00 に日報', '2026-08-15T05:00:00.000Z')],
        unreadable: [{ kind: 'broken-1', reason: '不正な欄: spec' }],
      },
    });

    expect(await screen.findByText('毎日 22:00 に日報')).toBeTruthy();
    const note = await screen.findByText(/読めない継続中の依頼が 1 件ある/);
    expect(note.textContent).toContain('kind: broken-1');
    expect(note.textContent).toContain('消された依頼ではない');
  });

  it('対照: 鍵が無ければ（0件）、断りは出ない', async () => {
    renderHome({ schedule: { entries: [entry('毎日 22:00 に日報', '2026-08-15T05:00:00.000Z')] } });

    expect(await screen.findByText('毎日 22:00 に日報')).toBeTruthy();
    expect(screen.queryByText(/読めない継続中の依頼/)).toBeNull();
  });
});

describe('ホームのカードの文に内部の語を出さない（#2772）', () => {
  const INTERNAL = /委譲|台帳/;

  it('作業の進捗: 大きな数字が何の件数かを言い、「委譲」「台帳」を出さない', async () => {
    renderHome();

    const card = (await screen.findByText('作業の進捗')).closest<HTMLElement>(
      '[data-slot="card"]',
    )!;
    await within(card).findByText('実行中の任せた作業');
    expect(card.textContent).not.toMatch(INTERNAL);
    // 件数ごとに名前が付いている（0 件が何の 0 件か迷わない）。
    expect(card.textContent).toContain('閉じた仕事 12 件');
  });

  it('作業の進捗が空のときは、次に何をすればよいかを言う', async () => {
    renderHome({
      progress: {
        ...PROGRESS_BODY,
        backlog: { ...PROGRESS_BODY.backlog, total: 0 },
        inProgress: { ...PROGRESS_BODY.inProgress, running: 0 },
      },
    });

    expect(await screen.findByText(/何かを任せると、ここに出る/)).toBeTruthy();
  });

  it('今日の利用: 記録が無いときも「台帳」と言わず、待てばよいことを言う', async () => {
    renderHome({ usage: { rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: true } });
    const early = await screen.findByText(/今日の分はまだ記録が無い/);
    expect(early.textContent).not.toMatch(INTERNAL);
    expect(early.textContent).toContain('この先の分が記録される');
    cleanup();

    renderHome({ usage: { rows: [], since: null, beforeLedger: false } });
    const none = await screen.findByText(/^まだ記録が無い/);
    expect(none.textContent).not.toMatch(INTERNAL);
    expect(none.textContent).toContain('ここに記録される');
  });
});

describe('「作業の進捗」カード', () => {
  it('実行中の任せた作業・未了・閉じた件数を出し、割合は出さない。詳しくは /progress', async () => {
    renderHome();

    expect(await screen.findByText('実行中の任せた作業')).toBeTruthy();
    expect(screen.getByText(/未了の仕事 5 件・直近 7 日で閉じた仕事 12 件/)).toBeTruthy();
    expect(screen.queryByText('%')).toBeNull();
    expect(linkTo('/progress')).toBeTruthy();
  });

  it('刈られた完了済みの行だけ（unreadable が 0）なら、下限と言わず、空なら「無い」と言う（#3698）', async () => {
    const empty = {
      ...PROGRESS_BODY,
      backlog: {
        ...PROGRESS_BODY.backlog,
        total: 0,
        completeness: { unreadable: 0, trimmedClosed: 3, unreadableJobs: 0 },
      },
      inProgress: { ...PROGRESS_BODY.inProgress, running: 0 },
    };
    renderHome({ progress: empty });

    expect(await screen.findByText(/いま動いている作業も未了の仕事も無い/)).toBeTruthy();
    expect(screen.queryByText(/数は下限/)).toBeNull();
  });

  it('読めなかった行が在るときは、数が下限だと言う', async () => {
    renderHome({
      progress: {
        ...PROGRESS_BODY,
        backlog: {
          ...PROGRESS_BODY.backlog,
          completeness: { unreadable: 2, trimmedClosed: 0, unreadableJobs: 0 },
        },
      },
    });

    expect(await screen.findByText(/読めなかった行があり、数は下限/)).toBeTruthy();
  });

  it('数が空でも下限のときは、「無い」と言い切らず下限の注記だけを出す（#3538）', async () => {
    const empty = {
      ...PROGRESS_BODY,
      backlog: { ...PROGRESS_BODY.backlog, total: 0 },
      inProgress: { ...PROGRESS_BODY.inProgress, running: 0 },
    };
    const partials = [
      { unreadable: 1, trimmedClosed: 0, unreadableJobs: 0 },
      { unreadable: 0, trimmedClosed: 0, unreadableJobs: 1 },
    ];
    for (const completeness of partials) {
      renderHome({ progress: { ...empty, backlog: { ...empty.backlog, completeness } } });

      expect(await screen.findByText(/読めなかった行があり、数は下限/)).toBeTruthy();
      expect(screen.queryByText(/未了の仕事も無い/)).toBeNull();
      cleanup();
    }
  });

  it('読めないときは ErrorNote（0 件と描かない）', async () => {
    renderHome({ progress: 'fail' });

    const card = (await screen.findByText('作業の進捗')).closest<HTMLElement>(
      '[data-slot="card"]',
    )!;
    expect(await within(card).findByRole('alert')).toBeTruthy();
    expect(within(card).queryByText('実行中の任せた作業')).toBeNull();
  });

  /**
   * **一度取れたあとの取り直しの失敗（issue #3069）。** SWR は直前の `data` を残して `error` を立てる
   * ので、`data` だけ見ると止まった数が今の値に見えた。方針は「画面を奪わず、その場で言う」——
   * 古い数は残し、数の上に注記を出す。取り直しが成功したら注記は消える。
   */
  it('取れたあとの取り直しが失敗しても、古い数は残したまま、その場で失敗を言う', async () => {
    renderHome();
    expect(await screen.findByText(/未了の仕事 5 件/)).toBeTruthy();
    expect(screen.queryByText(/取り直せなかった/)).toBeNull();

    const healthy = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/progress')
        ? Promise.resolve(new Response('{"error":"internal"}', { status: 500 }))
        : healthy(input, init);
    }) as typeof fetch;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText(/最新の数を取り直せなかった/)).toBeTruthy();
    expect(screen.getByText(/未了の仕事 5 件/)).toBeTruthy();

    globalThis.fetch = healthy;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.queryByText(/取り直せなかった/)).toBeNull());
    expect(screen.getByText(/未了の仕事 5 件/)).toBeTruthy();
  });
});
