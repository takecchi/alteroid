import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findMissingRequiredGates,
  formatMissingRequiredGates,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

/**
 * `findMissingRequiredGates`（Issue #1290）の歯。
 *
 * ## 何を塞ぐために在るか
 *
 * 2026-09-22、必須チェックを出す workflow が GitHub 上で `disabled_manually`
 * にされ、その門の check-run が永久に生成されなくなった。`evaluatePrGreen`
 * は観測できた job だけを見るため、生成されなかった門は「存在しない行」と
 * して判定から抜け落ち、残った job が全部 success なら `green`（exit=0）を
 * 返し続けた。**この道具が無かった世界では「緑になったのにマージできない」
 * という、いちばん判断を誤らせる形に落ちる。**
 *
 * ここでは `evaluatePrGreen` の8値の switch には一切触れない——別の軸として
 * `findMissingRequiredGates` を独立に測る（INV1〜INV4 それぞれに負の対照を
 * 1本ずつ）。
 */

describe('findMissingRequiredGates', () => {
  const REQUIRED = ['ci', 'image', 'no-attribution-trailers'];

  const oneRun = [{ id: 1, name: 'CI' }];

  it('INV1（本体）: verdict=green でも、required なのに job が1本も無い門は missing に載る', () => {
    // 2026-09-22 の事故そのものの形——pr-title.yml が disabled_manually に
    // なり、pr-title-type の check-run が永久に生成されなくなった。observed
    // job は ci/image だけで success。従来の evaluatePrGreen はこれを
    // green と言い切っていた（これ自体は変えていない——別軸として検出する）。
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'green',
      scoped: false,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result).toEqual({ status: 'checked', missing: ['no-attribution-trailers'] });
  });

  it('INV1 の負の対照: 全部の required な job が観測されていれば missing は空', () => {
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'no-attribution-trailers', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'green',
      scoped: false,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result).toEqual({ status: 'checked', missing: [] });
  });

  it('INV2: events で絞った呼び出し（scoped=true）は、真に欠けている門があっても不活性', () => {
    // record-release-prod-ci.mjs の events:['push'] の呼び方を模す。push の
    // run には no-attribution-trailers（pull_request 専用）の job が構造的に
    // 存在しない——これは真の欠落ではないので、検査そのものを不活性にする。
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'out-of-scope',
      scoped: true,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result.status).toBe('inactive');
    expect(result.missing).toBeUndefined();
  });

  it('INV2 の負の対照: scoped=false かつ verdict=green で同じ job 構成なら検出が働く（scoped だけが不活性化の理由であること）', () => {
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'green',
      scoped: false,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result.status).toBe('checked');
  });

  it.each(['pending', 'out-of-scope', 'no-runs', 'unmeasurable'])(
    'INV3: verdict=%s のときは不活性（jobsByRunId が required な job の全体像を保証しないため）',
    (verdict) => {
      const jobsByRunId = {
        1: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      };
      const result = findMissingRequiredGates({
        requiredContexts: REQUIRED,
        verdict,
        scoped: false,
        latestRuns: oneRun,
        jobsByRunId,
      });
      expect(result.status).toBe('inactive');
    },
  );

  it('INV3 の負の対照: verdict=red / cancelled / skipped では不活性にならない（対象は4値だけ）', () => {
    for (const verdict of ['red', 'cancelled', 'skipped']) {
      const jobsByRunId = {
        1: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
      };
      const result = findMissingRequiredGates({
        requiredContexts: REQUIRED,
        verdict,
        scoped: false,
        latestRuns: oneRun,
        jobsByRunId,
      });
      expect(result.status).toBe('checked');
    }
  });

  it('INV4: skipped の job は「在る」側——欠落と機械的に区別できる', () => {
    // no-attribution-trailers は skipped（在る。GitHub は required の判定で
    // 満たしたとして扱う）。pr-title-type 相当の門は job 自体が無い（真の欠落）。
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'no-attribution-trailers', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: [...REQUIRED, 'pr-title-type'],
      verdict: 'green',
      scoped: false,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result).toEqual({ status: 'checked', missing: ['pr-title-type'] });
  });

  it('INV4 の負の対照: skipped を「run が無い」と同じに数えると、この標本は missing に2件（no-attribution-trailers も）を含んでしまう——実際は1件だけであること', () => {
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'no-attribution-trailers', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: [...REQUIRED, 'pr-title-type'],
      verdict: 'green',
      scoped: false,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result.missing).not.toContain('no-attribution-trailers');
    expect(result.missing).toHaveLength(1);
  });

  it('INV7: --repo が既定（takecchi/alteroid）以外（crossRepo=true）は、真に欠けている門があっても不活性', () => {
    // この repo の宣言ファイル（.github/required-status-checks.json）は
    // takecchi/alteroid の required contexts であって、他の repo の
    // required contexts ではない。他の repo の sha にそのまま当てると、
    // 「その repo に在る門」を「無い」と誤判定する——不活性にする。
    const jobsByRunId = {
      1: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'green',
      scoped: false,
      crossRepo: true,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result.status).toBe('inactive');
    expect(result.missing).toBeUndefined();
  });

  it('INV7 の負の対照: crossRepo=false（既定 repo）なら同じ job 構成でも検出が働く（crossRepo だけが不活性化の理由であること）', () => {
    const jobsByRunId = {
      1: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'green',
      scoped: false,
      crossRepo: false,
      latestRuns: oneRun,
      jobsByRunId,
    });
    expect(result.status).toBe('checked');
    expect(result.missing.length).toBeGreaterThan(0);
  });

  /**
   * 実測の回帰（Issue #1290 のコメント。マネージャーが本物の GitHub データで
   * 検証した標本）: sha `b217ba51f781a4224a095257b5f1546261b24911`
   * （PR #859 の head、2026-09-11）。`no-attribution-trailers` という門が
   * まだ存在しなかった時代の sha なので、required 3本のうち1本の
   * check-run が本当に0本——2026-09-22 の事故と同型の「静かな見逃し」を
   * 実物のデータで再現する。
   *
   * 実測（`gh api repos/takecchi/alteroid/actions/runs?head_sha=b217ba51…`
   * および `.../actions/runs/34655158167/jobs`）: 最新世代は `CI` の run
   * `34655158167`（`event=pull_request`）1本だけで、jobs は
   * `base-overlap` / `ci` / `image` / `pr-origin` の4本ともすべて
   * `success`。
   */
  it('実測の回帰（PR #859、sha b217ba51…）: no-attribution-trailers が存在しない時代の sha でも missing に載る', () => {
    const latestRuns = [
      {
        id: 34655158167,
        name: 'CI',
        event: 'pull_request',
        created_at: '2026-09-11T22:42:25Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const jobsByRunId = {
      34655158167: [
        { name: 'base-overlap', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'pr-origin', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = findMissingRequiredGates({
      requiredContexts: REQUIRED,
      verdict: 'green', // evaluatePrGreen はこの標本を green と言う（マネージャーの実測どおり）
      scoped: false,
      crossRepo: false,
      latestRuns,
      jobsByRunId,
    });
    expect(result).toEqual({ status: 'checked', missing: ['no-attribution-trailers'] });
  });
});

describe('formatMissingRequiredGates', () => {
  it('1行目で欠けている門を名指しし、宣言であって branch protection ではないことを言う（ずれの突き合わせは check:required-status-checks を名指しする）', () => {
    const text = formatMissingRequiredGates('abc123', ['no-attribution-trailers']);
    const lines = text.split('\n');
    expect(lines[0]).toContain('no-attribution-trailers');
    expect(lines[0]).toContain('branch protection');
    expect(text).toContain('pnpm check:required-status-checks');
  });

  /**
   * INV6（マネージャーの実測で見つかった穴）: PR #1313 を本物の sha
   * （b217ba51…）で確かめたところ、`missingRequiredGates` が発火した直後に
   * `check-pr-green(sha): OK —— 最新世代の job がすべて success` という、
   * 道具名から始まり単独の判定として読める行が出ていた。`OK` で grep する
   * 読み手はその行だけを見て緑だと誤読する（exit code は 1 でもテキストの
   * 経路には乗らない）。⟹ `result` を渡したときは、その行が二度と現れない
   * ことを固定する。
   */
  it('INV6: result（verdict=green）を渡しても、単独の判定として読める "OK" 行が現れない', () => {
    const result = {
      verdict: 'green',
      detail: ['ci（workflow=CI, run=1）= success', 'image（workflow=CI, run=1）= success'],
    };
    const text = formatMissingRequiredGates('abc123', ['no-attribution-trailers'], result);
    const lines = text.split('\n');
    // `check-pr-green(...):` を先頭に持つ行は、欠落を名指しした1行目だけ
    // であること（2行目以降に道具名で始まる新しい判定行が生まれない）。
    const verdictLikeLines = lines.filter((line: string) =>
      /^check-pr-green\(.*\):/.test(line.trim()),
    );
    expect(verdictLikeLines).toHaveLength(1);
    // "OK" という文字列そのものが、単独の判定として読める形
    // （行頭が "OK" または "): OK" のように verdict の位置に来る形）では
    // 出ないこと。
    expect(lines.some((line: string) => /:\s*OK\b/.test(line))).toBe(false);
    // ただし detail（実際に走った job の内訳）は失われず残っている。
    expect(text).toContain('ci（workflow=CI, run=1）= success');
  });

  it('INV6 の負の対照: result を渡さなければ従来どおり欠落の警告だけを返す（発火していないときの呼び出し元との互換）', () => {
    const text = formatMissingRequiredGates('abc123', ['no-attribution-trailers']);
    const lines = text.split('\n');
    const verdictLikeLines = lines.filter((line: string) =>
      /^check-pr-green\(.*\):/.test(line.trim()),
    );
    expect(verdictLikeLines).toHaveLength(1);
  });

  it('INV6: verdict=red と missing 非空が同時に起きても、上から読んで意味が通る（NG が2つ並ぶが、2つ目は従属節でありOKではない）', () => {
    const result = {
      verdict: 'red',
      detail: ['ci（workflow=CI, run=1）= failure'],
    };
    const text = formatMissingRequiredGates('abc123', ['no-attribution-trailers'], result);
    const lines = text.split('\n');
    const verdictLikeLines = lines.filter((line: string) =>
      /^check-pr-green\(.*\):/.test(line.trim()),
    );
    // 道具名で始まる行はやはり1行だけ——2つ目の NG は「加えて」から始まる
    // 従属節であり、独立した2本目の check-pr-green(...) 行にはならない。
    expect(verdictLikeLines).toHaveLength(1);
    expect(lines.some((line: string) => /:\s*OK\b/.test(line))).toBe(false);
    expect(text).toContain('加えて');
    expect(text).toContain('ci（workflow=CI, run=1）= failure');
  });
});

/**
 * `.github/required-status-checks.json` を実ファイルとして読む——
 * `check-required-status-checks.test.ts` と同じ理由（宣言の形そのものを
 * 実物で確かめる。`findMissingRequiredGates` 自体はここでは合成 fixture を
 * 使うので、この宣言ファイルの中身とは独立にテストできている）。
 */
describe('宣言ファイルの形（このテストが依拠する前提の確認）', () => {
  it('.github/required-status-checks.json の contexts は文字列の配列である', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../.github/required-status-checks.json', import.meta.url), 'utf8'),
    );
    expect(Array.isArray(raw.contexts)).toBe(true);
    expect(raw.contexts.every((n: unknown) => typeof n === 'string')).toBe(true);
  });
});

/**
 * `judgeSha` の配線（Issue #1290）——`check-pr-green.judge-sha.test.ts` と
 * 同じ形で `gh api` を差し替え、`findMissingRequiredGates` が実際に
 * `judgeSha` の結果へ正しく混ざることを確かめる。宣言ファイルは実物を読む
 * （モックしない。中身は上のテストで確認済み）。
 */
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const mockedExec = vi.mocked(execFileSync);
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
const { judgeSha } = await import('./check-pr-green.mjs');

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function runsJson(workflowRuns: unknown[]): string {
  return JSON.stringify({ workflow_runs: workflowRuns });
}

describe('judgeSha の配線: missingRequiredGates', () => {
  afterEach(() => {
    mockedExec.mockReset();
  });

  it('INV1 実物同型: 2026-09-22 の事故そのもの——CI は green だが no-attribution-trailers の run が1本も無い', () => {
    mockedExec.mockImplementation(((_cmd: unknown, args: unknown) => {
      const path = String((args as string[])[1]);
      if (path.startsWith(`repos/takecchi/alteroid/actions/runs?head_sha=${SHA}`)) {
        return runsJson([
          {
            id: 1,
            name: 'CI',
            event: 'pull_request',
            created_at: '2026-09-22T12:00:00Z',
            status: 'completed',
            conclusion: 'success',
          },
        ]);
      }
      if (path === 'repos/takecchi/alteroid/actions/runs/1/jobs?per_page=100') {
        return JSON.stringify({
          jobs: [
            { name: 'ci', status: 'completed', conclusion: 'success' },
            { name: 'image', status: 'completed', conclusion: 'success' },
          ],
        });
      }
      throw new Error(`unexpected gh api call in test: ${path}`);
    }) as never);

    const { result, missingRequiredGates } = judgeSha({ sha: SHA, repo: 'takecchi/alteroid' });
    expect(result?.verdict).toBe('green');
    expect(missingRequiredGates).toEqual({
      status: 'checked',
      missing: ['no-attribution-trailers'],
    });
  });

  it('INV2 実物同型: events:["push"] で絞った呼び出しは missingRequiredGates が不活性のまま', () => {
    mockedExec.mockImplementation(((_cmd: unknown, args: unknown) => {
      const path = String((args as string[])[1]);
      if (path.startsWith(`repos/takecchi/alteroid/actions/runs?head_sha=${SHA}`)) {
        return runsJson([
          {
            id: 2,
            name: 'CI',
            event: 'push',
            created_at: '2026-09-22T12:00:00Z',
            status: 'completed',
            conclusion: 'success',
          },
        ]);
      }
      if (path === 'repos/takecchi/alteroid/actions/runs/2/jobs?per_page=100') {
        return JSON.stringify({
          jobs: [
            { name: 'ci', status: 'completed', conclusion: 'success' },
            { name: 'image', status: 'completed', conclusion: 'success' },
          ],
        });
      }
      throw new Error(`unexpected gh api call in test: ${path}`);
    }) as never);

    const { missingRequiredGates } = judgeSha({
      sha: SHA,
      repo: 'takecchi/alteroid',
      events: ['push'],
    });
    expect(missingRequiredGates?.status).toBe('inactive');
  });

  it('INV3 実物同型: まだ走行中の run が在れば（pending）missingRequiredGates は不活性', () => {
    mockedExec.mockImplementation(((_cmd: unknown, args: unknown) => {
      const path = String((args as string[])[1]);
      if (path.startsWith(`repos/takecchi/alteroid/actions/runs?head_sha=${SHA}`)) {
        return runsJson([
          {
            id: 3,
            name: 'CI',
            event: 'pull_request',
            created_at: '2026-09-22T12:00:00Z',
            status: 'in_progress',
            conclusion: null,
          },
        ]);
      }
      throw new Error(`unexpected gh api call in test: ${path}`);
    }) as never);

    const { result, missingRequiredGates } = judgeSha({ sha: SHA, repo: 'takecchi/alteroid' });
    expect(result?.verdict).toBe('pending');
    expect(missingRequiredGates?.status).toBe('inactive');
  });

  it('INV7 実物同型: --repo が既定以外（fork/他repo）だと、真に欠けている門があっても missingRequiredGates は不活性', () => {
    // この repo の宣言ファイルは takecchi/alteroid のものなので、他の repo
    // （例: 誰かの fork）の sha にそのまま当てると「その repo に在る門」を
    // 「無い」と誤判定する。判定そのものを構造的に不活性にする。
    mockedExec.mockImplementation(((_cmd: unknown, args: unknown) => {
      const path = String((args as string[])[1]);
      if (path.startsWith(`repos/someone/fork/actions/runs?head_sha=${SHA}`)) {
        return runsJson([
          {
            id: 4,
            name: 'CI',
            event: 'pull_request',
            created_at: '2026-09-22T12:00:00Z',
            status: 'completed',
            conclusion: 'success',
          },
        ]);
      }
      if (path === 'repos/someone/fork/actions/runs/4/jobs?per_page=100') {
        return JSON.stringify({
          jobs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
        });
      }
      throw new Error(`unexpected gh api call in test: ${path}`);
    }) as never);

    const { result, missingRequiredGates } = judgeSha({ sha: SHA, repo: 'someone/fork' });
    expect(result?.verdict).toBe('green');
    expect(missingRequiredGates?.status).toBe('inactive');
  });

  it('INV7 の負の対照: repo を省略しない既定呼び出し（takecchi/alteroid）は crossRepo にならず、同じ job 構成なら検出が働く', () => {
    mockedExec.mockImplementation(((_cmd: unknown, args: unknown) => {
      const path = String((args as string[])[1]);
      if (path.startsWith(`repos/takecchi/alteroid/actions/runs?head_sha=${SHA}`)) {
        return runsJson([
          {
            id: 5,
            name: 'CI',
            event: 'pull_request',
            created_at: '2026-09-22T12:00:00Z',
            status: 'completed',
            conclusion: 'success',
          },
        ]);
      }
      if (path === 'repos/takecchi/alteroid/actions/runs/5/jobs?per_page=100') {
        return JSON.stringify({
          jobs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
        });
      }
      throw new Error(`unexpected gh api call in test: ${path}`);
    }) as never);

    const { missingRequiredGates } = judgeSha({ sha: SHA, repo: 'takecchi/alteroid' });
    expect(missingRequiredGates?.status).toBe('checked');
  });
});
