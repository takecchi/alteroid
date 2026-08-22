#!/usr/bin/env node
/**
 * 検証一式を1つの口にまとめ、通し直しを無料にする。
 *
 * ## なぜ1本にするのか
 *
 * **渡し忘れが実際に起きている。** `typecheck` を渡し忘れて型エラー2件が CI まで残った
 * （`AGENTS.md`「作業者へ切り出す」）。列挙を人が毎回書き写す形だと、抜けは列挙の側に
 * しか現れず、**抜けたことは出力に出ない。**
 *
 * **そして順序が要る。** `build` が先でないと、ワークスペース間の型解決が各パッケージの
 * `dist/` に依存しているせいで `typecheck` / `test` が落ちる（`AGENTS.md`「開発手順」）。
 *
 * **OpenAPI の一致も一式に含める。** いまこれは CI にしか無く、手元の一式に入って
 * いなかった（`.github/workflows/ci.yml`）。手元で通したつもりが CI で初めて落ちる差が
 * ここに在った。
 *
 * ## 通し直しを無料にする（指紋）
 *
 * 直そうとしている失敗は「一式を通した**後**に手を入れて、通し直さない」である。1人の
 * マネージャーが1日に4回踏んだ。**4回とも渡し忘れではなく、共通しているのは「通した後に
 * 手を入れた」ことだけ**だった。
 *
 * だから**警告を足すのではなく、通し直しを無料にする**。成功した時点のツリーの指紋を
 * `.git/` へ記録し、**指紋が一致する状態で再び呼ばれたら何も走らせずに返す。** 無料なら
 * 「さっき打ったか」を思い出す必要が消える ＝ **打ち直しが選択でなくなる。**
 *
 * **これはキャッシュであり、キャッシュは嘘をつきうる。** だから範囲を貼る。
 *
 * **指紋が見るもの**: `git ls-files -co --exclude-standard` が挙げる全ファイル（追跡 +
 * 未追跡、ignore を除く）の内容と、`HEAD` の sha。
 *
 * **なぜこの範囲なのか（一覧より、こちらを先に読むこと）**: 直そうとしている失敗は
 * **「人が一式を通した後にファイルを手で直した」**であり、それは必ず**git から見た
 * リポジトリの状態の変化**として現れる。だから範囲は「git が状態として見せてくるもの
 * 全部」に取ってある。**次に何かを指紋へ入れるべきか迷ったら、「それは人が手で直した
 * ときに変わるか」で判断すること。** 実行系の版（`mise.toml`）や依存の版
 * （`pnpm-lock.yaml`）は追跡ファイルなので既にこの中に入っている —
 * **別枠で数え上げないこと**（数え上げは腐る）。`HEAD` を足してあるのは、`openapi` の
 * 検査が `HEAD` との差分を見るためである。
 *
 * **指紋が見ていないもの**: `node_modules` の実体（ロックファイルに現れない形で変わった
 * 場合）、環境変数、器そのもの（OS・CPU・混雑）。**どれも「人が手で直した」では変わらない
 * 側**で、上の判断基準の裏返しである。
 *
 * **器の入れ替わりは、記録の置き場が塞いでいる。** 記録は `.git/` に在るので、clone し
 * 直せば記録も無く、必ず走る。**ただし同じ作業ツリーが残ったままコンテナだけ替わった
 * 場合は残りうる（そこは塞げていない）。**
 *
 * **`--force` で必ず走る。** そして**`--force` を毎回打つ人が出たら、それは指紋が
 * 信用されていない合図である** — そのときは指紋の範囲を疑うこと。
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// グローバルの `process` に頼らない（`packages/core/scripts/write-canon.mjs` と同じ理由。
// この repo の script はどれもこの形で揃えてある）。
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { decideSkip, fingerprint } from './verify-core.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** 記録の置き場。**`.git/` に置くのは意図である**（上の doc「器の入れ替わり」）。 */
const RECORD = join(REPO, '.git', 'alteroid-verify.json');

/**
 * 一式。**順序に意味がある**（`build` が先。上の doc）。
 *
 * `openapi` だけ `pnpm` ではなく `git` なのは、生成物が最新かを見る検査だからである
 * （`pnpm build` が書き換えた後に差分が残っていれば、commit し忘れている）。
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

const argv = process.argv.slice(2);
const force = argv.includes('--force');

/**
 * `pnpm test` に足す引数（`pnpm verify -- --maxWorkers=4` の形で渡す）。
 *
 * **既定を数で固定しない。** この器は混むと既定の並列度で「テスト0本のまま exit 1」に
 * なるが、**適切な数は器ごとに違う**（`AGENTS.md` は器の CPU 数を書かない理由として
 * 「固定した数は固定した瞬間から腐り、腐ったことは読む側からは分からない」を挙げて
 * いる）。だから**ここでも数を持たず、渡せる口だけを開ける。**
 *
 * **素の `--` は落とす。** `pnpm verify -- --maxWorkers=4` と打つと pnpm は `--` ごと
 * こちらへ渡してくる。そのまま足すと `pnpm test -- --maxWorkers=4` になり、
 * **`--maxWorkers=4` が vitest へ届かない**（既定の並列度で走って、この器では fork pool
 * が EPIPE で死ぬ）。**実測（2026-08-22）**: この取りこぼしを、下の `testRan`（行の不在で
 * 見る判定）が「走っていない」として捕まえた。**「落ちた」と読んでいたら、存在しない
 * 失敗を直しに行っていた。**
 */
const passthrough = argv.filter((arg) => arg !== '--' && arg !== '--force');

/**
 * テストが「走った」かを、件数ではなく**行の不在**で見る。
 *
 * **「落ちた」と「1本も走らなかった」はどちらも exit 1 である**（`AGENTS.md`「自分が
 * 走っている器」）。`Test Files` / `Tests` の行が出ていなければ、通ったのでも落ちたのでも
 * なく**走っていない**。**ここを2値にしないこと** — 2値にすると走らなかった回が「落ちた」
 * へ黙って倒れ、**存在しない失敗を直しに行くことになる。**
 */
function testRan(output) {
  return /^\s*Test Files\s+/m.test(output) && /^\s*Tests\s+/m.test(output);
}

/**
 * 1手順を走らせる。
 *
 * **出力を溜めるのはテストのときだけである。** 全部を溜める形にしていたら、この器で
 * `pnpm build` が **SIGABRT（exit 134）** で落ちた（直接打つと通るのに、この口から
 * 呼ぶと落ちる）。溜めるのに要るのは `testRan` の判定だけなので、**それ以外は
 * 素通し（`inherit`）にして、そもそも溜めない。** 素通しのほうが出力が生で流れるので、
 * 長い手順の途中経過も見える。
 */
function run(step) {
  const args = step.isTest ? [...step.args, ...passthrough] : step.args;
  process.stdout.write('\n=== ' + step.name + ': ' + step.cmd + ' ' + args.join(' ') + '\n');
  if (!step.isTest) {
    const r = spawnSync(step.cmd, args, { cwd: REPO, stdio: 'inherit' });
    return { code: r.status ?? 1, output: '' };
  }
  const r = spawnSync(step.cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  process.stdout.write(output);
  return { code: r.status ?? 1, output };
}

const decided = decideSkip({ repo: REPO, recordPath: RECORD, force });

if (decided.skip) {
  // **無料で返したときも、必ず1行残す。警告ではなく領収書である。**
  // 畳んだこと自体が記録に残らないと、後から「本当に走ったのか」を誰も言えない
  // （この repo の「畳んだなら、畳んだと記録に残す」）。報告に「pnpm verify を通した」と
  // 書いてあるとき、**実走かキャッシュ命中かを読み分けられるようにするため**でもある。
  process.stdout.write(
    'verify: skipped (tree unchanged since ' +
      decided.fingerprint.slice(0, 12) +
      ', verified at ' +
      decided.at +
      ')\n  走らせ直すなら `pnpm verify --force`\n',
  );
  process.exit(0);
}

const results = [];
for (const step of STEPS) {
  const { code, output } = run(step);

  // **テストだけ3つ目の状態を持つ。** 詳細は `testRan` の doc。
  if (step.isTest && !testRan(output)) {
    process.stdout.write(
      '\n!! ' +
        step.name +
        ': **走っていない**（落ちたのではない）。`Test Files` / `Tests` の行が出ていない。\n' +
        '   器が混んでいる可能性が高い。並列度を下げて取り直すこと: `pnpm verify -- --maxWorkers=4`\n' +
        '   **この結果を「落ちた」と読まないこと** — 存在しない失敗を直しに行くことになる。\n',
    );
    process.exit(3);
  }

  if (code !== 0) {
    const rest = STEPS.slice(STEPS.indexOf(step) + 1).map((x) => x.name);
    process.stdout.write(
      '\n!! ' +
        step.name +
        ' が落ちた（exit ' +
        code +
        '）' +
        (step.hint === undefined ? '' : ' — ' + step.hint) +
        '\n' +
        (rest.length === 0
          ? ''
          : '   ここで止める。以降は走らせていない: ' + rest.join(' / ') + '\n'),
    );
    process.exit(1);
  }

  results.push(step.name);
}

// **指紋は走り「終わった」時点で取り直す。** 走る前のものを書くと、走行中に誰かが直した
// 分を「検証済み」として記録してしまう。
const after = fingerprint(REPO);
if (after !== null) {
  writeFileSync(
    RECORD,
    JSON.stringify({ fingerprint: after, at: new Date().toISOString() }, null, 2) + '\n',
  );
}

process.stdout.write(
  '\n=== 検証一式: 全部通った（' +
    results.join(' / ') +
    '）\n' +
    (after === null
      ? '（指紋を取れなかったので記録していない。次も必ず走る）\n'
      : 'verify: recorded (' + after.slice(0, 12) + ')\n'),
);
