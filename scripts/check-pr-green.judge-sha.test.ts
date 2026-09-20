import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `judgeSha`（`check-pr-green.mjs`）の配線を確かめる歯（Issue #1207 の (3)）。
 *
 * `check-pr-green.test.ts`「自己参照バグの再現と修正」は `check-pr-green-core.mjs`
 * の純粋関数（`filterRunsByEvent` / `pickLatestRunPerWorkflow` / `evaluatePrGreen`）
 * だけを合成 fixture で測っている。**こちらは `judgeSha` 自身の配線**——
 * `gh api`（`execFileSync`）を差し替えて、(1) `events` を渡さない呼び方
 * （`scripts/check-pr-green.mjs` の CLI 自身の呼び方）が実行中の
 * `release-prod.yml` 自身を含めてしまう旧来の挙動のままであること、(2)
 * `events: ['push']` を渡す呼び方（`record-release-prod-ci.mjs` の呼び方）が
 * その自己参照を実際に外すこと、の両方を**本物の `judgeSha` 呼び出しを通して**
 * 確かめる（`apps/cli/src/profile.test.ts` / `login.test.ts` と同じ
 * `vi.mock('node:child_process')` の形）。
 *
 * 固定値は実測（2026-09-19T21:28:57Z 観測、release-prod.yml 記録 step のログ、
 * sha fa9ec3e380fbe9dad8a3d1ad3e6c43c0639d5cb6）を写したもの。
 */

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const mockedExec = vi.mocked(execFileSync);
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
const { judgeSha } = await import('./check-pr-green.mjs');

const SHA = 'fa9ec3e380fbe9dad8a3d1ad3e6c43c0639d5cb6';

const RUNS_JSON = JSON.stringify({
  workflow_runs: [
    {
      id: 35458661938,
      name: 'CI',
      event: 'push',
      created_at: '2026-09-19T17:37:24Z',
      status: 'completed',
      conclusion: 'success',
    },
    {
      // これが「実行するたびに自分自身を理由に pending を返す」原因——
      // この記録 step を動かしている release-prod.yml 自身の run。
      id: 35470533724,
      name: 'release/prod へ反映',
      event: 'schedule',
      created_at: '2026-09-19T21:28:49Z',
      status: 'in_progress',
      conclusion: null,
    },
  ],
});

const CI_JOBS_JSON = JSON.stringify({
  jobs: [
    { name: 'ci', status: 'completed', conclusion: 'success' },
    { name: 'image', status: 'completed', conclusion: 'success' },
    { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
  ],
});

function fakeGhApi(_cmd: unknown, args: unknown): string {
  const path = String((args as string[])[1]);
  if (path.startsWith(`repos/takecchi/alteroid/actions/runs?head_sha=${SHA}`)) return RUNS_JSON;
  if (path === 'repos/takecchi/alteroid/actions/runs/35458661938/jobs?per_page=100') {
    return CI_JOBS_JSON;
  }
  throw new Error(`unexpected gh api call in test: ${path}`);
}

describe('judgeSha の配線（events を渡す／渡さない）', () => {
  afterEach(() => {
    mockedExec.mockReset();
  });

  it('events を渡さない（CLI 自身の既定の呼び方）——実行中の release-prod.yml 自身が混ざり pending になる（修正前の挙動そのまま。回帰させていないことの確認）', () => {
    mockedExec.mockImplementation(fakeGhApi as never);
    const { result } = judgeSha({ sha: SHA, repo: 'takecchi/alteroid' });
    expect(result?.verdict).toBe('pending');
  });

  it('events: ["push"] を渡す（record-release-prod-ci.mjs の呼び方）——自己参照が外れて判定できる', () => {
    mockedExec.mockImplementation(fakeGhApi as never);
    const { result } = judgeSha({ sha: SHA, repo: 'takecchi/alteroid', events: ['push'] });
    expect(result?.verdict).toBe('out-of-scope');
  });
});

/**
 * 略記 sha の拒否（Issue #1192 の N5 の具体形）。
 *
 * `actions/runs?head_sha=` は略記を渡すと**エラーではなく空の一覧**を返す。
 * ⟹ 拒まないと `no-runs` に化け、**赤いコミットが「CI が走っていない」として
 * 読まれる。** 実測（2026-09-20、同じコミット）: 略記は `no-runs`、完全形は
 * `red`。理由は `check-pr-green-core.mjs` の `isFullCommitSha` の doc。
 */
describe('略記 sha の拒否（no-runs に化けさせない）', () => {
  afterEach(() => {
    mockedExec.mockReset();
  });

  it('略記 sha は判定に進まず、gh api を1度も呼ばない', () => {
    mockedExec.mockImplementation(fakeGhApi as never);
    const { result, error } = judgeSha({ sha: '3ca63973b7da', repo: 'takecchi/alteroid' });
    expect(result).toBeNull();
    expect(String(error)).toContain('完全な40文字');
    // ⭐ ネットワークへ出る前に弾いていること（出てしまうと空の一覧が返り、
    //    no-runs と区別が付かなくなる）。
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('⚠ 受け取った値をそのまま理由に載せる（どれを渡したのか読み手が分かる）', () => {
    const { error } = judgeSha({ sha: 'deadbeef', repo: 'takecchi/alteroid' });
    expect(String(error)).toContain('deadbeef');
  });

  it('sha でない値（undefined / 数値 / 41文字 / 非16進）も拒む', () => {
    for (const bad of [undefined, 12345, 'f'.repeat(41), 'g'.repeat(40)]) {
      const { result } = judgeSha({ sha: bad as never, repo: 'takecchi/alteroid' });
      expect(result).toBeNull();
    }
  });

  it('完全形の sha は今までどおり判定へ進む（回帰させていない）', () => {
    mockedExec.mockImplementation(fakeGhApi as never);
    const { result, error } = judgeSha({ sha: SHA, repo: 'takecchi/alteroid', events: ['push'] });
    expect(error).toBeNull();
    expect(result?.verdict).toBe('out-of-scope');
  });
});
