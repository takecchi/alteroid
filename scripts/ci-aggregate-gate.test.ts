import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { extractJobNames, extractJobsSection } from './workflow-scan-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI_YML = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/**
 * **`ci` 門 job の歯（#2707）。**
 *
 * `ci` は、検査の job（static / build-checks / typecheck / lint / mutation-selftest / test）を
 * `needs` で束ね、全部が `success` のときだけ success になる門である。required のチェック名は
 * `ci` のまま（`.github/required-status-checks.json`）なので、**この門が緩むと、分けた検査の
 * どれかが落ちても `ci` が緑になる。** 以前は `ci` 1本が全 step を回していたので、step の
 * 失敗＝`ci` の失敗だった。その性質を、分けたあとも保つ。
 *
 * ## 測っているもの
 *
 * 1. `ci` の `needs` が、`ci.yml` の `ci` と `image` 以外の全 job を含む（job を足して
 *    needs に載せ忘れると、その job は落ちても `ci` に響かない）。一覧は導出する。
 * 2. `ci` の `if:` が `always()` を含む（無いと、needs が落ちたとき `ci` は failure ではなく
 *    skipped になる。skipped は green と数えない運用だが、failure の方が確実に止まる）。
 * 3. `ci` の step の実物（`run:` の bash）を、合成した `needs` の JSON で実行する:
 *    全部 success のときだけ exit 0。failure / cancelled / skipped が1つでも混じれば非0、
 *    needs が空でも非0。
 * 4. 元の `ci` が回していた検査（下の `ORIGINAL_GATES`）が、`ci` の needs に載っている
 *    どれかの job の `run:` に在る。**検査を減らして速くする、を許さない歯である。**
 *    build 済みの成果物を読むものは、同じ job で `pnpm build` の後に走ること。
 * 5. `test` は `--shard=<i>/<n>` で分かれ、分母は `strategy.job-total`（matrix の本数）から
 *    取り、matrix は 1..n を欠けなく並べる（全シャードを合わせると全テストになる）。
 *
 * ## この歯が測っていないこと
 *
 * - **GitHub 上で実際に `needs` の result がこの JSON の形で渡ること。** 形は公式 doc に
 *   従って合成した。実際の run は PR 本文の陰性対照（落とした run で `ci` が failure）で見る。
 * - **vitest の `--shard` が漏れなく割り当てること**（vitest 自身の保証に頼っている）。
 */

const jobsSection: string = `\n${extractJobsSection(CI_YML) as string}`;
const JOB_NAMES: string[] = extractJobNames(jobsSection.slice(1));

function jobBlock(name: string): string {
  const re = new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z0-9_-]+:|$)`);
  const block = re.exec(jobsSection)?.[1];
  if (block === undefined) throw new Error(`job "${name}" の本文を抽出できなかった`);
  return block;
}

function needsOf(name: string): string[] {
  const m = /^ {4}needs:\s*\[([^\]\n]*)\]/m.exec(jobBlock(name));
  if (!m) throw new Error(`job "${name}" の needs: [...] が読めない`);
  return (m[1] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

/** `run:` の行（1行形式と `|` のブロック形式の両方）を、順に並べる。コメント行は除く。 */
function runLines(name: string): string[] {
  const out: string[] = [];
  const lines = jobBlock(name).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = (m[1] ?? '').trim();
    if (rest === '|') {
      const indent = /^\s*/.exec(lines[i + 1] ?? '')?.[0].length ?? 0;
      const body: string[] = [];
      for (let k = i + 1; k < lines.length; k++) {
        const l = lines[k] ?? '';
        if (l.trim() !== '' && (/^\s*/.exec(l)?.[0].length ?? 0) < indent) break;
        body.push(l.slice(indent));
      }
      out.push(body.join('\n'));
    } else {
      out.push(rest);
    }
  }
  return out;
}

/** 元の `ci` job が回していた検査（`run:` の先頭にこの文字列が在ること）。 */
const ORIGINAL_GATES: { gate: string; needsBuild: boolean }[] = [
  { gate: 'pnpm check:agents-md-size', needsBuild: false },
  { gate: 'pnpm check:dockerfile-railway', needsBuild: false },
  { gate: 'pnpm check:web-bundle-node-traces', needsBuild: true },
  { gate: 'pnpm check:web-bundle-size', needsBuild: true },
  { gate: 'pnpm check:web-css-comment-classnames', needsBuild: true },
  { gate: 'pnpm check:web-css-no-inline-fonts', needsBuild: true },
  { gate: 'git diff --exit-code -- apps/daemon/openapi.json', needsBuild: true },
  { gate: 'pnpm check:sdk-quotes', needsBuild: false },
  { gate: 'pnpm check:stale-token-restart-advice', needsBuild: false },
  { gate: 'pnpm check:restart-before-check-advice', needsBuild: false },
  { gate: 'pnpm check:no-env-passthrough', needsBuild: false },
  { gate: 'pnpm typecheck', needsBuild: true },
  { gate: 'pnpm lint', needsBuild: true },
  { gate: 'pnpm format:check', needsBuild: false },
  { gate: 'pnpm test', needsBuild: true },
  {
    gate: 'node .claude/skills/mutation-testing/mutate.mjs selftest --scenario all',
    needsBuild: true,
  },
];

const CI_NEEDS = needsOf('ci');

describe('ci 門: needs と if', () => {
  it('ci と image 以外の全 job が、ci の needs に載っている', () => {
    const expected = JOB_NAMES.filter((n) => n !== 'ci' && n !== 'image').sort();
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect([...CI_NEEDS].sort()).toEqual(expected);
  });

  it('needs に載せた名前は全部実在する', () => {
    for (const n of CI_NEEDS) expect(JOB_NAMES, n).toContain(n);
  });

  it('image は ci の needs に載せない（image は独立した required チェックである）', () => {
    expect(CI_NEEDS).not.toContain('image');
  });

  it('ci の if: は always() を含む（needs の失敗で skipped にならず、failure として落ちる）', () => {
    const ifLine = /^\s*if:\s*(.+)$/m.exec(jobBlock('ci'))?.[1] ?? '';
    expect(ifLine).toContain('always()');
  });
});

describe('ci 門: step の実物を合成した needs で実行する', () => {
  const scripts = runLines('ci');
  const gateScript = scripts.find((s) => s.includes('NEEDS') || s.includes('jq')) ?? '';

  function run(needs: unknown) {
    return spawnSync('bash', ['-c', gateScript], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        NEEDS: typeof needs === 'string' ? needs : JSON.stringify(needs),
      },
    });
  }
  const res = (result: string) => ({ result, outputs: {} });
  const all = (result: string) => Object.fromEntries(CI_NEEDS.map((n) => [n, res(result)]));

  it('前提: ci の step に NEEDS を読む bash が在る', () => {
    expect(gateScript).toContain('NEEDS');
  });

  it('全部 success なら exit 0', () => {
    const r = run(all('success'));
    expect(r.status, r.stderr).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped'])('1つが %s なら非0（他が success でも）', (bad) => {
    for (const victim of CI_NEEDS) {
      const needs = { ...all('success'), [victim]: res(bad) };
      const r = run(needs);
      expect(r.status, `${victim}=${bad}`).not.toBe(0);
      expect(r.stderr, `${victim}=${bad}`).toContain(`${victim}=${bad}`);
    }
  });

  it('全部 skipped でも非0（skipped を success と数えない）', () => {
    expect(run(all('skipped')).status).not.toBe(0);
  });

  it('needs が空でも非0（0件で緑にしない）', () => {
    expect(run({}).status).not.toBe(0);
  });

  it('needs が JSON として読めなくても非0', () => {
    expect(run('not json').status).not.toBe(0);
  });
});

describe('元の ci が回していた検査は、needs の job のどれかで走り続ける', () => {
  it.each(ORIGINAL_GATES)('$gate', ({ gate, needsBuild }) => {
    const hosts = CI_NEEDS.filter((job) => runLines(job).some((l) => l.startsWith(gate)));
    expect(hosts.length, `${gate} が ci の needs の job に無い`).toBeGreaterThanOrEqual(1);
    if (needsBuild) {
      for (const job of hosts) {
        const lines = runLines(job);
        const buildAt = lines.findIndex((l) => l === 'pnpm build');
        const gateAt = lines.findIndex((l) => l.startsWith(gate));
        expect(buildAt, `${job}: ${gate} の前に pnpm build が要る`).toBeGreaterThanOrEqual(0);
        expect(buildAt, `${job}: pnpm build は ${gate} より前`).toBeLessThan(gateAt);
      }
    }
  });
});

describe('test のシャード分割', () => {
  const block = jobBlock('test');

  it('pnpm test の --shard の分母は strategy.job-total（matrix の本数）から取る', () => {
    const lines = runLines('test').filter((l) => l.startsWith('pnpm test'));
    expect(lines).toEqual(['pnpm test --shard=${{ matrix.shard }}/${{ strategy.job-total }}']);
  });

  it('matrix.shard は 1..n を欠けなく並べる（n は2以上）', () => {
    const m = /^ {8}shard:\s*\[([^\]\n]*)\]/m.exec(block);
    expect(m, 'matrix.shard が読めない').not.toBeNull();
    const shards = (m?.[1] ?? '').split(',').map((s) => Number(s.trim()));
    expect(shards.length).toBeGreaterThanOrEqual(2);
    expect(shards).toEqual(shards.map((_, i) => i + 1));
  });

  it('fail-fast: false（落ちたシャードだけでなく、全シャードの結果を出す）', () => {
    expect(block).toMatch(/^ {6}fail-fast:\s*false\s*$/m);
  });
});
