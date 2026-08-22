#!/usr/bin/env node
/**
 * 検証一式を1つの口にまとめる。
 *
 * ## なぜ1本にするのか
 *
 * **渡し忘れが実際に起きている。** `typecheck` を渡し忘れて型エラー2件が CI まで
 * 残った（`AGENTS.md`「作業者へ切り出す」）。列挙を人が毎回書き写す形だと、
 * 抜けは列挙の側にしか現れず、**抜けたことは出力に出ない。**
 *
 * **そして順序が要る。** `build` が先でないと、ワークスペース間の型解決が各
 * パッケージの `dist/` に依存しているせいで `typecheck` / `test` が落ちる
 * （`AGENTS.md`「開発手順」）。順序を人が覚える形にすると、覚え違いが
 * 「本当は通るものが落ちた」として出る。
 *
 * **OpenAPI の一致も一式に含める。** いまこれは CI にしか無く、手元の一式には
 * 入っていない（`.github/workflows/ci.yml`）。手元で通したつもりのものが
 * CI で初めて落ちる差がここに在った。
 *
 * ## この口が言えること / 言えないこと
 *
 * - **言えること**: 並んでいる6つを、正しい順で、1つも飛ばさずに通したか
 * - **言えないこと**: **通した後にツリーが動いていないか。** この口は自分が
 *   走った瞬間のことしか知らない。**緑を見てから1行直して報告すれば、その1行は
 *   誰にも検証されていない**（この repo で実際に4回起きている形）。ここは
 *   別の仕組みが要る
 */

import { spawnSync } from 'node:child_process';
// グローバルの `process` に頼らない（`packages/core/scripts/write-canon.mjs` と
// 同じ理由。この repo の script はどれもこの形で揃えてある）。
import process from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 一式。**順序に意味がある**（`build` が先。上の doc）。
 *
 * `openapi` だけ `pnpm` ではなく `git` なのは、生成物が最新かを見る検査だから
 * である（`pnpm build` が書き換えた後に差分が残っていれば、commit し忘れている）。
 */
const STEPS = [
  { name: 'build', cmd: 'pnpm', args: ['build'] },
  {
    name: 'openapi',
    cmd: 'git',
    args: ['diff', '--exit-code', '--', 'apps/daemon/openapi.json'],
    hint: 'apps/daemon/openapi.json が古い。`pnpm build` の結果を commit すること',
  },
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'format:check', cmd: 'pnpm', args: ['format:check'], hint: '`pnpm format` で直る' },
  { name: 'test', cmd: 'pnpm', args: ['test'], isTest: true },
];

/**
 * `pnpm test` に足す引数（`pnpm verify -- --maxWorkers=4` の形で渡す）。
 *
 * **既定を数で固定しない。** この器は混むと既定の並列度で「テスト0本のまま
 * `exit 1`」になるが、**適切な数は器ごとに違う**（`AGENTS.md` は器の CPU 数を
 * 書かない理由として「固定した数は固定した瞬間から腐り、腐ったことは読む側からは
 * 分からない」を挙げている）。だから**ここでも数を持たず、渡せる口だけを開ける。**
 */
// **素の `--` は落とす。** `pnpm verify -- --maxWorkers=4` と打つと、pnpm は
// `--` ごとこちらへ渡してくる。それをそのまま `pnpm test` へ足すと
// `pnpm test -- --maxWorkers=4` になり、**`--maxWorkers=4` が vitest へ届かない**
// （既定の並列度で走って、この器では fork pool が EPIPE で死ぬ）。
//
// **実測（2026-08-22）**: この取りこぼしを、下の `testRan`（行の不在で見る判定）が
// 「走っていない」として捕まえた。**「落ちた」と読んでいたら、存在しない失敗を
// 直しに行っていた。**
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--');

/**
 * テストが「走った」かを、件数ではなく**行の不在**で見る。
 *
 * **「落ちた」と「1本も走らなかった」はどちらも `exit 1` である**
 * （`AGENTS.md`「自分が走っている器」）。`Test Files` / `Tests` の行が出て
 * いなければ、通ったのでも落ちたのでもなく**走っていない**。
 *
 * **ここを2値にしないこと。** 2値にすると、走らなかった回が「落ちた」へ黙って
 * 倒れ、**存在しない失敗を直しに行くことになる。**
 */
function testRan(output) {
  return /^\s*Test Files\s+/m.test(output) && /^\s*Tests\s+/m.test(output);
}

function run(step) {
  const args = step.isTest ? [...step.args, ...passthrough] : step.args;
  process.stdout.write(`\n=== ${step.name}: ${step.cmd} ${args.join(' ')}\n`);
  const r = spawnSync(step.cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(output);
  return { code: r.status ?? 1, output };
}

const results = [];
for (const step of STEPS) {
  const { code, output } = run(step);

  // **テストだけ3つ目の状態を持つ。** 詳細は `testRan` の doc。
  if (step.isTest && !testRan(output)) {
    results.push({ name: step.name, state: 'not-run' });
    process.stdout.write(
      `\n!! ${step.name}: **走っていない**（落ちたのではない）。` +
        '`Test Files` / `Tests` の行が出ていない。\n' +
        '   器が混んでいる可能性が高い。並列度を下げて取り直すこと: `pnpm verify -- --maxWorkers=4`\n' +
        '   **この結果を「落ちた」と読まないこと** — 存在しない失敗を直しに行くことになる。\n',
    );
    process.exit(3);
  }

  if (code !== 0) {
    results.push({ name: step.name, state: 'failed' });
    process.stdout.write(
      `\n!! ${step.name} が落ちた（exit ${code}）${step.hint === undefined ? '' : ` — ${step.hint}`}\n` +
        `   ここで止める。以降は走らせていない: ${STEPS.slice(STEPS.indexOf(step) + 1)
          .map((s) => s.name)
          .join(' / ')}\n`,
    );
    process.exit(1);
  }

  results.push({ name: step.name, state: 'passed' });
}

process.stdout.write(
  `\n=== 検証一式: 全部通った（${results.map((r) => r.name).join(' / ')}）\n` +
    '**この結果が言えるのは、いま走った瞬間のことだけである。** ' +
    'このあとツリーを1文字でも動かしたら、動かした分は誰にも検証されていない。\n',
);
