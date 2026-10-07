import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('略記 sha の拒否（no-runs に化けさせない）', () => {
  afterEach(() => {
    mockedExec.mockReset();
  });

  it('略記 sha は判定に進まず、gh api を1度も呼ばない', () => {
    mockedExec.mockImplementation(fakeGhApi as never);
    const { result, error } = judgeSha({ sha: '3ca63973b7da', repo: 'takecchi/alteroid' });
    expect(result).toBeNull();
    expect(String(error)).toContain('完全な40文字');
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
