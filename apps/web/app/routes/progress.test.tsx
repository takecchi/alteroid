// @vitest-environment jsdom
/**
 * `/progress` 画面（Issue #2241 の 4）。
 *
 * ここで固定したいのは:
 *
 * - 4枚（積み上がり・実施中・片付いた速度・見込み）の見出しと、それぞれの数
 * - 見込みの3状態: `estimated` は時間と notice、`not_converging` / `unavailable` は
 *   時間を作らず理由を出す。知らない state / reason でも落ちない（版のずれ）
 * - 取れない値（`null`）は「—」で、0 とは書かない
 * - `completeness` が 0 でないとき、数が欠けうる但し書きを出す
 * - GitHub は「観測していない（0 件ではない）」と `github.reason` をそのまま出す
 * - 期間の切替が URL（`?windowHours=`）と要求の `windowHours` の両方を変える
 * - 404（この版のデーモンにこの口が無い）と一般のエラーが分かれる
 * - **描いた文字に `%` が1つも無い**（分母が定まらないので割合は出さない）
 *
 * 時刻は相対（「3日前」）でしか assert しないので、時間帯には依らない。
 * 待ちは `findBy*` だけで、実時間の `setTimeout` は使わない。
 */
import { describeGithubCi } from '@alteroid/core';
import { GITHUB_CI_COUNT_LABEL, GITHUB_CI_COUNT_ORDER } from '@alteroid/logic';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import ProgressPage from './progress';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
});

const OBSERVED_AT = '2026-09-30T03:00:00.000Z';
const GITHUB_REASON = 'デーモンは GitHub を見に行かない（fixture の理由）';

function basis(overrides: Record<string, unknown> = {}) {
  return {
    open: 12,
    closedInWindow: 9,
    openedInWindow: 4,
    windowHours: 168,
    method: 'open / (closedInWindow / windowHours)',
    unreadable: 0,
    minClosedInWindow: 3,
    ...overrides,
  };
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: OBSERVED_AT,
    window: { hours: 168, from: '2026-09-23T03:00:00.000Z', to: OBSERVED_AT },
    backlog: {
      total: 12,
      byOrigin: { human: 5, manager: 3, external: 2, self: 2 },
      age: {
        oldestAt: '2026-09-27T03:00:00.000Z',
        medianHours: 30.25,
        buckets: { under1h: 1, under24h: 4, under7d: 6, over7d: 1 },
      },
      byState: { untouched: 6, responded: 3, delegated: 2, notApplicable: 4 },
      completeness: { unreadable: 0, trimmedClosed: 0, unreadableJobs: 0 },
    },
    inProgress: {
      running: 3,
      awaitingHuman: 1,
      lost: 2,
      lastReport: {
        oldestAt: '2026-09-29T03:00:00.000Z',
        newestAt: '2026-09-30T02:00:00.000Z',
        withoutReport: 1,
      },
    },
    throughput: {
      commitmentsOpened: 4,
      commitmentsClosed: 9,
      delegationsEnded: { count: 7, basis: 'updatedAt' },
    },
    forecast: {
      state: 'estimated',
      hoursToDrain: 224,
      basis: basis(),
      notice: '推定であり約束ではない。窓の中の流入は数えていない',
    },
    github: { state: 'not_observed', reason: GITHUB_REASON },
    ...overrides,
  };
}

function stubProgress(options: { status?: number; body?: unknown } = {}) {
  const { status = 200, body = baseBody() } = options;
  return stubFetch((url) => {
    if (url.includes('/progress')) return json(body, status);
    return undefined;
  });
}

function renderPage(initialEntry = '/progress') {
  const router = createMemoryRouter(
    [
      {
        path: '/progress',
        element: (
          <Providers>
            <ProgressPage />
          </Providers>
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** カード（見出しの祖先の枠）の中だけを見る。 */
async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name });
  const el = heading.closest('[data-slot="card"]');
  if (!(el instanceof HTMLElement)) throw new Error(`card not found: ${name}`);
  return el;
}

function forecastBody(forecast: unknown) {
  return baseBody({ forecast });
}

describe('/progress 画面 — 4枚', () => {
  it('積み上がり・実施中・片付いた速度・見込みの4枚を、この順で出す', async () => {
    stubProgress();
    renderPage();

    await card('未完了の仕事');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['未完了の仕事', '実行中の依頼', '完了の速度', '見込み']);
  });

  it('積み上がり: 未了の件数と、誰からの依頼か・経過時間・進み具合を並べる', async () => {
    stubProgress();
    renderPage();

    const backlog = within(await card('未完了の仕事'));
    expect(backlog.getByText('未完了')).toBeTruthy();
    expect(backlog.getByText('12')).toBeTruthy();
    expect(backlog.getByText(/人間 5 \/ マネージャー 3 \/ 外部 2 \/ 自分で始めた 2/)).toBeTruthy();
    expect(backlog.getByText(/3日前/)).toBeTruthy();
    expect(backlog.getByText('30.3 時間')).toBeTruthy();
    expect(backlog.getByText(/1時間未満 1 \/ 24時間未満 4 \/ 7日未満 6 \/ 7日以上 1/)).toBeTruthy();
    expect(
      backlog.getByText(
        /未着手 6 \/ 返答済み（まだ閉じていない） 3 \/ マネージャーに任せた 2（他の項目と重なることがあります） \/ 人間からの依頼ではない 4/,
      ),
    ).toBeTruthy();
    // 欠けが無いときは但し書きを出さない。
    expect(backlog.queryByText(/数が実際より少ない可能性/)).toBeNull();
  });

  it('実施中: 実行中・返答待ち・連絡が取れないと、最後の報告の古さ・まだ報告が無い依頼を出す', async () => {
    stubProgress();
    renderPage();

    const inProgress = within(await card('実行中の依頼'));
    expect(inProgress.getByText('実行中').nextElementSibling?.textContent).toContain('3');
    expect(inProgress.getByText('返答待ち').nextElementSibling?.textContent).toContain('1');
    expect(inProgress.getByText('連絡が取れない').nextElementSibling?.textContent).toContain('2');
    expect(inProgress.getByText(/1日前/)).toBeTruthy();
    expect(inProgress.getByText(/1時間前/)).toBeTruthy();
    expect(inProgress.getByText('1 件')).toBeTruthy();
  });

  it('片付いた速度: 引き受けた・完了にした・終わった依頼（概算）を出す', async () => {
    stubProgress();
    renderPage();

    const throughput = within(await card('完了の速度'));
    expect(throughput.getByText('引き受けた').nextElementSibling?.textContent).toContain('4');
    expect(throughput.getByText('完了にした').nextElementSibling?.textContent).toContain('9');
    expect(throughput.getByText('終わった依頼').nextElementSibling?.textContent).toContain('7');
    expect(throughput.getByText(/概算です/)).toBeTruthy();
    expect(throughput.queryByText(/updatedAt/)).toBeNull();
    expect(throughput.getByText(/直近 168 時間/)).toBeTruthy();
  });
});

describe('/progress 画面 — 見込みの3状態と版のずれ', () => {
  it('estimated: 時間（長いときは日にちも）と目安の断りを出し、式やフィールド名は折りたたみの先へ置く', async () => {
    stubProgress();
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText('224 時間（約 9.3 日）')).toBeTruthy();
    expect(
      forecast.getByText(/目安です。期間内に新しく引き受けた分は計算に入れていません/),
    ).toBeTruthy();
    expect(forecast.getByText('未完了').nextElementSibling?.textContent).toBe('12 件');
    // 式・フィールド名は、折りたたみ（閉じている）の先にだけ在る。
    const details = forecast.getByText('計算の詳細（開発者向け）').closest('details');
    expect(details?.open).toBe(false);
    const formula = forecast.getByText('open / (closedInWindow / windowHours)');
    expect(details?.contains(formula)).toBe(true);
    expect(forecast.getByText('推定であり約束ではない。窓の中の流入は数えていない')).toBeTruthy();
    expect(
      details?.contains(forecast.getByText('推定であり約束ではない。窓の中の流入は数えていない')),
    ).toBe(true);
  });

  it('estimated: 48時間未満は日にちを添えない', async () => {
    stubProgress({
      body: forecastBody({
        state: 'estimated',
        hoursToDrain: 6.25,
        basis: basis(),
        notice: 'n',
      }),
    });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText('6.3 時間')).toBeTruthy();
    expect(forecast.queryByText(/日）/)).toBeNull();
  });

  it('not_converging: 時間を作らず、流入と消化の件数で理由を言う', async () => {
    stubProgress({
      body: forecastBody({
        state: 'not_converging',
        basis: basis({ openedInWindow: 9, closedInWindow: 9 }),
      }),
    });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText('収束していない')).toBeTruthy();
    expect(forecast.getByText(/引き受けた件数（9 件）が完了にした件数（9 件）以上/)).toBeTruthy();
    expect(forecast.getByText('—')).toBeTruthy();
    expect(forecast.queryByText(/あと約/)).toBeNull();
    expect(forecast.queryByText(/時間（/)).toBeNull();
  });

  it.each([
    ['closed_too_few', '期間内に完了した仕事が少なすぎて'],
    ['ledger_younger_than_window', '記録が期間ぶんたまるまで待つか、短い期間に切り替えてください'],
    ['history_incomplete', '古い完了済みの記録が整理されていて'],
  ])('unavailable（%s）: 時間を作らず、理由を文で出す', async (reason, text) => {
    stubProgress({
      body: forecastBody({ state: 'unavailable', reason, basis: basis({ closedInWindow: 1 }) }),
    });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText('見込みを出せない')).toBeTruthy();
    expect(forecast.getByText(new RegExp(text))).toBeTruthy();
    expect(forecast.getByText('—')).toBeTruthy();
    expect(forecast.queryByText(/あと約/)).toBeNull();
    // 計算の元になった数は並べる。
    expect(forecast.getByText('期間内に完了にした').nextElementSibling?.textContent).toBe('1 件');
  });

  it('知らない reason でも落ちず、識別子は見せずに言う', async () => {
    stubProgress({
      body: forecastBody({ state: 'unavailable', reason: 'brand_new_reason', basis: basis() }),
    });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText(/目安を出せない理由が、この画面では分かりません/)).toBeTruthy();
    expect(forecast.queryByText(/brand_new_reason/)).toBeNull();
    expect(forecast.queryByText(/あと約/)).toBeNull();
  });

  it('知らない state でも落ちず、時間を出さない', async () => {
    stubProgress({ body: forecastBody({ state: 'from_the_future', basis: basis() }) });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText('不明な状態')).toBeTruthy();
    expect(forecast.getByText(/この画面が知らない状態です/)).toBeTruthy();
    expect(forecast.queryByText(/from_the_future/)).toBeNull();
    expect(forecast.queryByText(/あと約/)).toBeNull();
  });

  it('知らない state で basis も無くても落ちない', async () => {
    stubProgress({ body: forecastBody({ state: 'from_the_future' }) });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText(/この画面が知らない状態です/)).toBeTruthy();
    expect(forecast.queryByText('計算の元になった数')).toBeNull();
  });

  it('読み取れなかった記録が計算の元にあれば、但し書きを出す', async () => {
    stubProgress({
      body: forecastBody({
        state: 'estimated',
        hoursToDrain: 10,
        basis: basis({ unreadable: 2 }),
        notice: 'n',
      }),
    });
    renderPage();

    const forecast = within(await card('見込み'));
    expect(forecast.getByText(/読み取れなかった記録が 2 件あるため/)).toBeTruthy();
  });
});

describe('/progress 画面 — 取れない値と但し書き', () => {
  it('未完了が0件のとき、いちばん古いものと中央値は「—」で、0 と書かない', async () => {
    stubProgress({
      body: baseBody({
        backlog: {
          ...baseBody().backlog,
          total: 0,
          age: {
            oldestAt: null,
            medianHours: null,
            buckets: { under1h: 0, under24h: 0, under7d: 0, over7d: 0 },
          },
        },
      }),
    });
    renderPage();

    const backlog = within(await card('未完了の仕事'));
    expect(backlog.getByText('いちばん古いもの').nextElementSibling?.textContent).toMatch(/^—/);
    expect(backlog.getByText('経過時間の中央値').nextElementSibling?.textContent).toMatch(/^—/);
    expect(backlog.getByText('いちばん古いもの').nextElementSibling?.textContent).not.toMatch(/^0/);
    expect(backlog.getByText('経過時間の中央値').nextElementSibling?.textContent).not.toMatch(
      /0 時間/,
    );
  });

  it('報告のある依頼が無いとき、最後の報告は「—」で、まだ報告が無い依頼は件数で出す', async () => {
    stubProgress({
      body: baseBody({
        inProgress: {
          running: 2,
          awaitingHuman: 0,
          lost: 0,
          lastReport: { oldestAt: null, newestAt: null, withoutReport: 2 },
        },
      }),
    });
    renderPage();

    const inProgress = within(await card('実行中の依頼'));
    expect(
      inProgress.getByText('最後の報告（いちばん古い）').nextElementSibling?.textContent,
    ).toMatch(/^—/);
    expect(
      inProgress.getByText('最後の報告（いちばん新しい）').nextElementSibling?.textContent,
    ).toMatch(/^—/);
    expect(inProgress.getByText('まだ報告が無い依頼').nextElementSibling?.textContent).toBe('2 件');
  });

  it('completeness が 0 でなければ、数が少ない可能性の但し書きを出す', async () => {
    stubProgress({
      body: baseBody({
        backlog: {
          ...baseBody().backlog,
          completeness: { unreadable: 2, trimmedClosed: 5 },
        },
      }),
    });
    renderPage();

    const backlog = within(await card('未完了の仕事'));
    expect(
      backlog.getByText(
        /数が実際より少ない可能性があります（読み取れなかった記録 2 件 \/ 古くて整理された完了済みの記録 5 件）/,
      ),
    ).toBeTruthy();
  });

  it('completeness.unreadableJobs が 0 でなければ、「実施中」に委譲の欠けの但し書きを出す（#2345）', async () => {
    stubProgress({
      body: baseBody({
        backlog: {
          ...baseBody().backlog,
          completeness: { unreadable: 0, trimmedClosed: 0, unreadableJobs: 2 },
        },
      }),
    });
    renderPage();

    const inProgress = within(await card('実行中の依頼'));
    expect(inProgress.getByText(/読み取れなかった依頼の記録が 2 件あります/)).toBeTruthy();
    expect(inProgress.getByText(/依頼が無いわけではありません/)).toBeTruthy();
    // 台帳の欠けの但し書きは、委譲の欠けだけでは出ない。
    const backlog = within(await card('未完了の仕事'));
    expect(backlog.queryByText(/数が実際より少ない可能性/)).toBeNull();
  });

  it('対照: unreadableJobs が 0 なら、委譲の欠けの但し書きは出ない（#2345）', async () => {
    stubProgress();
    renderPage();
    expect(within(await card('実行中の依頼')).queryByText(/読み取れなかった依頼/)).toBeNull();
  });

  it('対照: 欄が無い（古いデーモン）でも、委譲の欠けの但し書きは出ず、落ちない（#2345）', async () => {
    stubProgress({
      body: baseBody({
        backlog: {
          ...baseBody().backlog,
          completeness: { unreadable: 0, trimmedClosed: 0 },
        },
      }),
    });
    renderPage();
    expect(within(await card('実行中の依頼')).queryByText(/読み取れなかった依頼/)).toBeNull();
  });

  it('GitHub は「まだ記録がありません（0 件という意味ではありません）」と reason を出し、0 を作らない', async () => {
    stubProgress();
    renderPage();

    const backlog = within(await card('未完了の仕事'));
    const label = backlog.getByText('開いている Issue / PR');
    const stat = label.parentElement;
    expect(stat?.textContent).toContain('まだ記録がありません（0 件という意味ではありません）');
    expect(stat?.textContent).toContain(GITHUB_REASON);
    expect(stat?.textContent).toContain('—');
    expect(stat?.textContent).not.toMatch(/(^|[^\d])0 ?件(?!という)/);
  });

  describe('観測の記録がある（#2245 段1）', () => {
    const okRow = {
      repo: 'takecchi/alteroid',
      latestOk: {
        observedAt: '2026-09-30T01:00:00.000Z',
        observedBy: 'clone',
        query: 'gh issue list --state open',
        limit: 100,
        openIssues: 12,
        openPulls: 0,
        truncated: false,
      },
      latestFailed: null,
    };

    it('数に、記録元・記録した時刻・数えた範囲を添える（古さは判定しない）。開いている PR の 0 は記録された 0 として出る', async () => {
      stubProgress({
        body: baseBody({
          github: { state: 'observed', repos: [okRow], scan: { limit: 500, reachedLimit: false } },
        }),
      });
      renderPage();

      const backlog = within(await card('未完了の仕事'));
      expect(backlog.getByText(/記録された数です/)).toBeTruthy();
      expect(
        backlog.getByText('takecchi/alteroid 開いている Issue').parentElement?.textContent,
      ).toContain('12');
      expect(
        backlog.getByText('takecchi/alteroid 開いている PR').parentElement?.textContent,
      ).toContain('0');
      expect(backlog.getByText(/記録したのは: クローン/)).toBeTruthy();
      expect(backlog.getByText('上限 100 件')).toBeTruthy();
      // 数えた条件の原文（CLI の文字列）は、閉じた折りたたみの外に出さない
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('details').forEach((el) => el.remove());
      const outside = clone.textContent ?? '';
      expect(outside).not.toContain('gh ');
      expect(outside).not.toContain('--state');
      // 折りたたみの中には残る（開発者が確かめられる）
      const details = backlog.getByText('数えた条件の詳細（開発者向け）').closest('details');
      expect(details?.textContent).toContain('gh issue list --state open');
      // GitHub 全体が未観測のときの文言（句点で終わる）。CI の軸の「観測していない（0 件ではない）」とは別
      expect(backlog.queryByText(/観測していない（0 件ではない）。/)).toBeNull();
    });

    it('CI: ci があれば内訳と数えたもの、ciUnavailable は理由、無ければ「観測していない」。0 と読ませない（#2549）', async () => {
      const render = async (extra: Record<string, unknown>) => {
        stubProgress({
          body: baseBody({
            github: {
              state: 'observed',
              repos: [
                { repo: 'x/y', latestOk: { ...okRow.latestOk, ...extra }, latestFailed: null },
              ],
              scan: { limit: 500, reachedLimit: false },
            },
          }),
        });
        renderPage();
        return within(await card('未完了の仕事'));
      };
      const view = await render({
        ci: { pulls: 3, success: 2, failure: 1, pending: 0, checks: '必須チェックだけ' },
      });
      const text = view.getByText(/3 件の PR を確認/).textContent ?? '';
      expect(text).toContain('成功 2 / 失敗 1 / 実行中・待ち 0');
      expect(text).toContain('必須チェックだけ');
    });

    it('CI の文言は core の describeGithubCi（原本）と、先頭の「CI: 」と件数の軸の名前（表で写す3語）を除いて同じ（#2608）', async () => {
      const cases: Record<string, unknown>[] = [
        { ci: { pulls: 5, success: 3, failure: 1, pending: 0, checks: '必須チェックだけ' } },
        { ci: { pulls: 2, success: 2, failure: 0, pending: 0, checks: 'x', truncated: true } },
        { ciUnavailable: 'HTTP 403' },
        {},
      ];
      for (const extra of cases) {
        cleanup();
        stubProgress({
          body: baseBody({
            github: {
              state: 'observed',
              repos: [
                { repo: 'x/y', latestOk: { ...okRow.latestOk, ...extra }, latestFailed: null },
              ],
              scan: { limit: 500, reachedLimit: false },
            },
          }),
        });
        renderPage();
        const view = within(await card('未完了の仕事'));
        const original = describeGithubCi(extra as Parameters<typeof describeGithubCi>[0]);
        expect(original.startsWith('CI: ')).toBe(true);
        // 原本の値（success / failure / pending）を、表（GITHUB_CI_COUNT_LABEL）が持つ写しだけで置き換える。
        // 表に無い差があれば（並び・数・断り書き）、ここで落ちる。
        let expected = original.slice('CI: '.length);
        for (const key of GITHUB_CI_COUNT_ORDER) {
          expected = expected.replace(`${key} `, `${GITHUB_CI_COUNT_LABEL[key]} `);
        }
        expect(view.getByText(expected)).toBeTruthy();
      }
    });

    it('CI: ciUnavailable は理由を出し、ci が無ければ観測していないと出す（success 0 を作らない）', async () => {
      stubProgress({
        body: baseBody({
          github: {
            state: 'observed',
            repos: [
              {
                repo: 'x/y',
                latestOk: { ...okRow.latestOk, ciUnavailable: 'HTTP 403' },
                latestFailed: null,
              },
            ],
            scan: { limit: 500, reachedLimit: false },
          },
        }),
      });
      renderPage();
      const view = within(await card('未完了の仕事'));
      expect(view.getByText(/取れなかった — HTTP 403/)).toBeTruthy();
      expect(view.queryByText(/success/)).toBeNull();
    });

    it('CI: ci も ciUnavailable も無い古い行は「観測していない」で、success 0 を作らない', async () => {
      stubProgress({
        body: baseBody({
          github: { state: 'observed', repos: [okRow], scan: { limit: 500, reachedLimit: false } },
        }),
      });
      renderPage();
      const view = within(await card('未完了の仕事'));
      expect(view.getByText(/観測していない（0 件ではない）/)).toBeTruthy();
      expect(view.queryByText(/success/)).toBeNull();
    });

    it('取れなかった回は数を作らず理由を出す。成功が無い repo の数は — で、0 と書かない', async () => {
      stubProgress({
        body: baseBody({
          github: {
            state: 'observed',
            repos: [
              {
                repo: 'takecchi/other',
                latestOk: null,
                latestFailed: {
                  observedAt: '2026-09-30T02:00:00.000Z',
                  observedBy: 'mgr-1',
                  query: 'gh pr list',
                  reason: 'gh: HTTP 502',
                },
              },
            ],
            scan: { limit: 500, reachedLimit: true },
          },
        }),
      });
      renderPage();

      const backlog = within(await card('未完了の仕事'));
      const stat = backlog.getByText('takecchi/other の開いている Issue / PR').parentElement;
      expect(stat?.textContent).toContain('—');
      expect(stat?.textContent).toContain('0 件という意味ではありません');
      // 上限に当たったので「記録が無い」とは言わず、読んだ範囲に無いと言う
      expect(stat?.textContent).toContain('読み取った範囲（新しい順 500 件）に成功した記録が無い');
      expect(backlog.getByText(/取得に失敗した回/).textContent).toContain('gh: HTTP 502');
      // 名乗られた識別子（mgr-1）は出さず、一般的な言い方にする
      expect(backlog.getByText(/取得に失敗した回/).textContent).toContain(
        '記録したのは: クローン以外からの申告',
      );
      expect(backlog.getByText(/取得に失敗した回/).textContent).not.toContain('mgr-1');
      expect(backlog.getByText(/上限（新しい順 500 件）に達しました/)).toBeTruthy();
    });

    it('知らない github.state が来ても落ちず、数を作らない', async () => {
      stubProgress({ body: baseBody({ github: { state: 'future', reason: 'x' } }) });
      renderPage();
      const backlog = within(await card('未完了の仕事'));
      expect(backlog.getByText(/この画面が知らない状態です/)).toBeTruthy();
    });
  });
});

describe('/progress 画面 — 期間の切替', () => {
  it('既定は7日で、要求に windowHours=168 を載せる', async () => {
    const stub = stubProgress();
    renderPage();

    await card('未完了の仕事');
    expect(stub.calls.some((url) => url.includes('windowHours=168'))).toBe(true);
    expect(screen.getByRole('radio', { name: '7日' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '24時間' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('URL の ?windowHours=720 を読み、要求もそれになる', async () => {
    const stub = stubProgress();
    renderPage('/progress?windowHours=720');

    await card('未完了の仕事');
    expect(stub.calls.some((url) => url.includes('windowHours=720'))).toBe(true);
    expect(screen.getByRole('radio', { name: '30日' }).getAttribute('aria-checked')).toBe('true');
  });

  it('知らない windowHours は既定（168）へ倒す', async () => {
    const stub = stubProgress();
    renderPage('/progress?windowHours=5');

    await card('未完了の仕事');
    expect(stub.calls.every((url) => !url.includes('windowHours=5&') && !url.endsWith('=5'))).toBe(
      true,
    );
    expect(stub.calls.some((url) => url.includes('windowHours=168'))).toBe(true);
  });

  it('チップで切り替えると、URL と要求の windowHours が変わる', async () => {
    const stub = stubProgress();
    const router = renderPage();
    await card('未完了の仕事');

    fireEvent.click(screen.getByRole('radio', { name: '24時間' }));

    await screen.findByRole('heading', { name: '未完了の仕事' });
    expect(router.state.location.search).toBe('?windowHours=24');
    expect(stub.calls.some((url) => url.includes('windowHours=24'))).toBe(true);
    expect(screen.getByRole('radio', { name: '24時間' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '7日' }).getAttribute('aria-checked')).toBe('false');

    // Issue #2275: 単一選択の部品（ChoiceChips）へ替えたので、「既定（7日）に戻す」の
    // 読み替えは無い（以前はここでそのボタンを押して URL が空に戻ることを固定していた）。
    expect(screen.queryByRole('button', { name: '既定（7日）に戻す' })).toBeNull();
  });

  it('選択中をもう一度押しても、URL も選択も変わらない', async () => {
    stubProgress();
    const router = renderPage('/progress?windowHours=24');
    await card('未完了の仕事');

    fireEvent.click(screen.getByRole('radio', { name: '24時間' }));

    expect(router.state.location.search).toBe('?windowHours=24');
    expect(screen.getByRole('radio', { name: '24時間' }).getAttribute('aria-checked')).toBe('true');
  });

  it('期間は radiogroup で、名前は「期間の長さ」。矢印キーで窓が変わる', async () => {
    const stub = stubProgress();
    const router = renderPage();
    await card('未完了の仕事');

    const group = screen.getByRole('radiogroup', { name: '期間の長さ' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-checked')),
    ).toEqual(['false', 'true', 'false']);

    // Radix の roving focus は次のチップへの focus を setTimeout(0) で行う。偽の時計で進める。
    vi.useFakeTimers();
    screen.getByRole('radio', { name: '7日' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    act(() => {
      vi.runAllTimers();
    });
    vi.useRealTimers();

    expect(router.state.location.search).toBe('?windowHours=720');
    expect(screen.getByRole('radio', { name: '30日' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '7日' }).getAttribute('aria-checked')).toBe('false');
    await screen.findByRole('heading', { name: '未完了の仕事' });
    expect(stub.calls.some((url) => url.includes('windowHours=720'))).toBe(true);
  });
});

describe('/progress 画面 — 取得の失敗', () => {
  it('404 は「デーモンがこの窓口を持っていない」と分けて出す', async () => {
    stubProgress({ status: 404, body: {} });
    renderPage();

    expect((await screen.findByRole('alert')).textContent).toMatch(/窓口を持っていません/);
    expect(screen.queryByRole('heading', { name: '未完了の仕事' })).toBeNull();
  });

  it('404 以外（500）は一般のエラーとして出る', async () => {
    stubProgress({ status: 500, body: { error: 'boom' } });
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toMatch(/窓口を持っていません/);
  });
});

describe('/progress 画面 — 割合（%）を出さない', () => {
  const bodies: [string, unknown][] = [
    ['estimated', baseBody()],
    [
      'not_converging',
      forecastBody({ state: 'not_converging', basis: basis({ openedInWindow: 9 }) }),
    ],
    [
      'unavailable',
      forecastBody({ state: 'unavailable', reason: 'closed_too_few', basis: basis() }),
    ],
    ['知らない state', forecastBody({ state: 'from_the_future', basis: basis() })],
  ];

  it.each(bodies)('%s のとき、描いた本文に % が含まれない', async (_name, body) => {
    stubProgress({ body });
    renderPage();

    await card('見込み');
    expect(document.body.textContent).not.toContain('%');
    expect(document.body.textContent).not.toContain('％');
    // Meter / shadcn Progress の role も使っていない。
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
  });
});

describe('/progress 画面 — GitHub の欄に英語の識別子を出さない（#2785 の続き）', () => {
  it('記録元と CI の軸の名前は日本語で出て、clone / success / failure / pending は出ない', async () => {
    stubProgress({
      body: baseBody({
        github: {
          state: 'observed',
          repos: [
            {
              repo: 'x/y',
              latestOk: {
                observedAt: '2026-09-30T01:00:00.000Z',
                observedBy: 'clone',
                query: 'q',
                openIssues: 1,
                openPulls: 2,
                truncated: false,
                ci: { pulls: 3, success: 1, failure: 1, pending: 1, checks: '必須チェックだけ' },
              },
              latestFailed: {
                observedAt: '2026-09-30T02:00:00.000Z',
                observedBy: 'mgr-1',
                query: 'q',
                reason: 'HTTP 502',
              },
            },
          ],
          scan: { limit: 500, reachedLimit: false },
        },
      }),
    });
    renderPage();
    const backlog = within(await card('未完了の仕事'));
    const text =
      backlog.getByText(/3 件の PR を確認/).closest('div')?.parentElement?.textContent ?? '';
    const whole = document.body.textContent ?? '';
    expect(whole).toContain('記録したのは: クローン');
    expect(text).toContain('成功 1 / 失敗 1 / 実行中・待ち 1');
    for (const word of ['clone', 'success', 'failure', 'pending', 'mgr-1', '記録元']) {
      expect(whole).not.toContain(word);
    }
  });
});

describe('/progress 画面 — 内部の語と式を見せない（#2785）', () => {
  it('閉じた折りたたみの外に、内部用語・フィールド名・式が出ない', async () => {
    stubProgress();
    renderPage();
    await card('見込み');

    // 折りたたみ（開発者向けの詳細）を取り除いた本文だけを見る。
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('details').forEach((el) => el.remove());
    const text = clone.textContent ?? '';
    for (const word of [
      '齢',
      '台帳',
      '走行',
      'updatedAt',
      'openedInWindow',
      'closedInWindow',
      '行方不明',
    ]) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toContain('open / (');
  });
});
