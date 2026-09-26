// @vitest-environment jsdom
/**
 * `/appraisal-stats` 画面（issue #1278 の HTTP 面、issue #1620 の Web 面）。
 *
 * ここで固定したいのは:
 *
 * - 台帳（`journal.commitments`）と委譲（`journal.jobs`）の内訳が別々に出る
 * - 仕事の種類ごとの内訳（`byWorkKind`）が、種類ごとに1件も切り捨てず出る
 *   （件数が多くても——`.claude/skills/listing-and-detail/SKILL.md` の
 *   「HTTP の口は上限を持たない」を Web 側の描画でも尊重する）
 * - 種類が1件も無い軸は「0件の行」を作らず、空の注記だけを出す
 *   （AGENTS.md「取れない軸に 0 の行を作る」の裏返し）
 * - 委譲の評定の有無（`jobCoverage`）が状態ごとに出て、`nonTerminalTotal` は
 *   0件でも常に出る
 * - 人間とクローンの食い違い（`reconciliation`）が対の無いときと在るときで
 *   別の文言を出し、`undetermined` は0件でも常に出る
 * - 型が知らない `status` / `cloneValue` が来ても画面が落ちない（版のずれ）
 * - 取得に失敗したとき（404 = 古いデーモン／それ以外の失敗）、区別できる
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import AppraisalStatsPage from './appraisal-stats';

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

function emptyTally() {
  return { good: 0, bad: 0, unclear: 0, other: 0, total: 0 };
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    journal: {
      commitments: emptyTally(),
      jobs: emptyTally(),
      byWorkKind: { commitments: [], jobs: [] },
    },
    jobCoverage: {
      byStatus: [
        { status: 'done', total: 0, appraised: 0, unappraised: 0 },
        { status: 'failed', total: 0, appraised: 0, unappraised: 0 },
        { status: 'lost', total: 0, appraised: 0, unappraised: 0 },
        { status: 'stopped', total: 0, appraised: 0, unappraised: 0 },
      ],
      terminalTotal: 0,
      terminalAppraised: 0,
      terminalUnappraised: 0,
      nonTerminalTotal: 0,
    },
    reconciliation: {
      commitments: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
      jobs: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
    },
    ...overrides,
  };
}

function stubAppraisalStats(options: { status?: number; body?: unknown }) {
  const { status = 200, body = baseBody() } = options;
  return stubFetch((url) => {
    if (url.includes('/appraisal-stats')) return json(body, status);
    return undefined;
  });
}

async function renderPage(): Promise<void> {
  render(
    <Providers>
      <AppraisalStatsPage />
    </Providers>,
  );
  await screen.findByText('件数（軸ごと）');
}

describe('/appraisal-stats 画面 — 台帳と委譲を別々に、混ぜずに出す', () => {
  it('台帳と委譲、それぞれの内訳を出す', async () => {
    stubAppraisalStats({
      body: baseBody({
        journal: {
          commitments: { good: 3, bad: 1, unclear: 0, other: 0, total: 4 },
          jobs: { good: 10, bad: 2, unclear: 1, other: 0, total: 13 },
          byWorkKind: { commitments: [], jobs: [] },
        },
      }),
    });

    await renderPage();

    expect(screen.getByText(/評定行 4 件/)).toBeTruthy();
    expect(screen.getByText(/評定行 13 件/)).toBeTruthy();
    // 混ぜて比べないことの注記が出る（内訳カードのもの——同じ注記が食い違いカード
    // にも別に出るので、こちらだけを指す文言で絞る）。
    expect(
      screen.getByText(/上の2つは別の軸である。混ぜて比べないこと（台帳の行の始末/),
    ).toBeTruthy();
  });
});

describe('/appraisal-stats 画面 — 仕事の種類ごとの内訳', () => {
  it('種類が1件も無い軸は、0件の行を作らず空の注記だけを出す', async () => {
    stubAppraisalStats({ body: baseBody() });

    await renderPage();

    const emptyNotes = await screen.findAllByText('（評定行が無い）');
    // 台帳・委譲の両方で空の注記が出る（0件の行が作られていないことの裏返し）。
    expect(emptyNotes.length).toBe(2);
  });

  it('種類が多くても、1件も切り捨てずに全件出す', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      workKind: `種類${index}`,
      good: 1,
      bad: 0,
      unclear: 0,
      other: 0,
      total: 1,
    }));
    stubAppraisalStats({
      body: baseBody({
        journal: {
          commitments: { good: 30, bad: 0, unclear: 0, other: 0, total: 30 },
          jobs: emptyTally(),
          byWorkKind: { commitments: many, jobs: [] },
        },
      }),
    });

    await renderPage();

    for (const entry of many) {
      expect(screen.getByText(entry.workKind)).toBeTruthy();
    }
  });

  it('未分類（workKind: null）は「未分類」という文言で出す', async () => {
    stubAppraisalStats({
      body: baseBody({
        journal: {
          commitments: { good: 1, bad: 0, unclear: 0, other: 0, total: 1 },
          jobs: emptyTally(),
          byWorkKind: {
            commitments: [{ workKind: null, good: 1, bad: 0, unclear: 0, other: 0, total: 1 }],
            jobs: [],
          },
        },
      }),
    });

    await renderPage();

    expect(screen.getByText('未分類')).toBeTruthy();
  });
});

describe('/appraisal-stats 画面 — 委譲の評定の有無', () => {
  it('状態ごとの内訳と、続いていない委譲の件数（0件でも）を出す', async () => {
    stubAppraisalStats({
      body: baseBody({
        jobCoverage: {
          byStatus: [
            { status: 'done', total: 5, appraised: 3, unappraised: 2 },
            { status: 'failed', total: 1, appraised: 1, unappraised: 0 },
            { status: 'lost', total: 0, appraised: 0, unappraised: 0 },
            { status: 'stopped', total: 0, appraised: 0, unappraised: 0 },
          ],
          terminalTotal: 6,
          terminalAppraised: 4,
          terminalUnappraised: 2,
          nonTerminalTotal: 0,
        },
      }),
    });

    await renderPage();

    expect(screen.getByText(/終端 5 件（評定あり 3 \/ 評定なし 2）/)).toBeTruthy();
    // running/waiting_human が0件でも、対象外の注記自体は出る。
    expect(screen.getByText(/終端していない委譲が 0 件/)).toBeTruthy();
  });

  it('型が知らない status が来ても画面は落ちない（版のずれ）', async () => {
    stubAppraisalStats({
      body: baseBody({
        jobCoverage: {
          byStatus: [{ status: 'archived', total: 1, appraised: 0, unappraised: 1 }],
          terminalTotal: 1,
          terminalAppraised: 0,
          terminalUnappraised: 1,
          nonTerminalTotal: 0,
        },
      }),
    });

    await renderPage();

    // 落ちずに、未知の値をそのまま文字列として出す。
    expect(screen.getByText('archived')).toBeTruthy();
  });
});

describe('/appraisal-stats 画面 — 人間とクローンの食い違い', () => {
  it('対が無いときは、その旨の文言を出す', async () => {
    stubAppraisalStats({ body: baseBody() });

    await renderPage();

    const notes = await screen.findAllByText('（クローンが付けた評定を人間が付け直した対は無い）');
    expect(notes.length).toBe(2);
  });

  it('対があるときは遷移と合計を出す。undetermined は0件でも常に出る', async () => {
    stubAppraisalStats({
      body: baseBody({
        reconciliation: {
          commitments: {
            transitions: [{ cloneValue: 'good', humanValue: 'bad', count: 2 }],
            totalPairs: 2,
            matched: 0,
            mismatched: 2,
            undetermined: 0,
          },
          jobs: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
        },
      }),
    });

    await renderPage();

    expect(
      screen.getByText(/クローン「良かった」→人間「悪かった」: 2 件（食い違い）/),
    ).toBeTruthy();
    expect(screen.getByText(/合計: 2 対（一致 0 \/ 食い違い 2）/)).toBeTruthy();
    // 0件でも「測っていない」とは違う、という注記自体は常に出る。
    const undeterminedNotes =
      screen.getAllByText(/0件は「無かった」であって「測っていない」ではない/);
    expect(undeterminedNotes.length).toBe(2);
  });

  it('型が知らない cloneValue/humanValue が来ても画面は落ちない（版のずれ）', async () => {
    stubAppraisalStats({
      body: baseBody({
        reconciliation: {
          commitments: {
            transitions: [{ cloneValue: 'excellent', humanValue: 'good', count: 1 }],
            totalPairs: 1,
            matched: 0,
            mismatched: 1,
            undetermined: 0,
          },
          jobs: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
        },
      }),
    });

    await renderPage();

    expect(screen.getByText(/クローン「excellent」→人間「良かった」/)).toBeTruthy();
  });
});

describe('/appraisal-stats 画面 — 取得の失敗', () => {
  it('404（この口を持たない古いデーモン）は、専用の文言を出す', async () => {
    stubAppraisalStats({ status: 404, body: {} });

    await renderPage();

    expect(screen.getByText(/版が古い可能性がある/)).toBeTruthy();
  });

  it('404 以外の失敗（500 等）でも失敗として見える', async () => {
    stubAppraisalStats({ status: 500, body: { error: 'boom' } });

    await renderPage();

    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
