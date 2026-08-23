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
 * ## 終了コード（4つある）
 *
 * | コード | 意味                                                              |
 * | ------ | ----------------------------------------------------------------- |
 * | 0      | 全部通った（実走 or 指紋一致で畳んだ。**出力で読み分けられる**）   |
 * | 1      | どれかが落ちた                                                    |
 * | 3      | **テストが1本も走っていない**（落ちたのではない）                 |
 * | 4      | **テストが走ったかどうか判定できない**（signal で殺された等）      |
 *
 * **3 と 4 を混ぜないこと。** 3 は「並列度を下げて取り直せ」が効く。4 はそれが効かない
 * （原因が混雑ではない）ので、同じ助言を出すと読んだ人は無駄に繰り返すことになる。
 * **2値にしないのと同じ理由で、3値にもしない**（`AGENTS.md`「『判定できない』という
 * 3つ目の状態を持つ」）。
 *
 * ## 通し直しを無料にする（指紋）
 *
 * 直そうとしている失敗は「一式を通した**後**に手を入れて、通し直さない」である。1人の
 * マネージャーが1日に4回踏んだ。**4回とも渡し忘れではなく、共通しているのは「通した後に
 * 手を入れた」ことだけ**だった。
 *
 * だから**警告を足すのではなく、通し直しを無料にする**。成功した時点のツリーの指紋を
 * git ディレクトリへ記録し、**指紋が一致する状態で再び呼ばれたら何も走らせずに返す。**
 * 無料なら「さっき打ったか」を思い出す必要が消える ＝ **打ち直しが選択でなくなる。**
 *
 * **これはキャッシュであり、キャッシュは嘘をつきうる。** だから範囲を貼る。
 *
 * **指紋が見るもの**: `git ls-files -co --exclude-standard` が挙げる全ファイル（追跡 +
 * 未追跡、ignore を除く）の**パス・モード・中身**と、`HEAD` の sha。
 *
 * **なぜこの範囲なのか（一覧より、こちらを先に読むこと）**: 直そうとしている失敗は
 * **「人が一式を通した後にファイルを手で直した」**であり、それは必ず**git から見た
 * リポジトリの状態の変化**として現れる。だから範囲は「git が状態として見せてくるもの
 * 全部」に取ってある。**次に何かを指紋へ入れるべきか迷ったら、「それは人が手で直した
 * ときに変わるか」で判断すること。** 実行系の版（`mise.toml`）や依存の版
 * （`pnpm-lock.yaml`）は追跡ファイルなので既にこの中に入っている —
 * **別枠で数え上げないこと**（数え上げは腐る）。`HEAD` を足してあるのは、`openapi` の
 * 検査が `HEAD` との差分を見るためである。**モードと symlink の行き先まで見る理由は
 * `verify-core.mjs` の `fingerprint` に在る**（中身だけ見ていると実行ビットや
 * 差し替えた symlink が漏れ、**その状態で `git diff` は差分を見せる** ＝ 検査が落ちる
 * はずのツリーを「変わっていない」と言うことになる）。
 *
 * **指紋が見ていないもの**: `node_modules` の実体（ロックファイルに現れない形で変わった
 * 場合）、環境変数、器そのもの（OS・CPU・混雑）。**どれも「人が手で直した」では変わらない
 * 側**で、上の判断基準の裏返しである。
 *
 * **器の入れ替わりは、記録の置き場が塞いでいる。** 記録は git ディレクトリに在るので、
 * clone し直せば記録も無く、必ず走る。**ただし同じ作業ツリーが残ったままコンテナだけ
 * 替わった場合は残りうる（そこは塞げていない）。**
 *
 * **`--force` で必ず走る。** そして**`--force` を毎回打つ人が出たら、それは指紋が
 * 信用されていない合図である** — そのときは指紋の範囲を疑うこと。
 *
 * ## この口は CI と同じではない（`verify` == CI と読まないこと）
 *
 * **手順の中身と順序は CI（`.github/workflows/ci.yml`）に合わせてあるが、CI にあって
 * ここに無いものが2つある。**
 *
 * - **`pnpm install --frozen-lockfile`**: ここでは走らせない（手元の `node_modules` を
 *   勝手に作り替えないため）。だから**`package.json` に依存を足して `pnpm-lock.yaml` を
 *   作り直し忘れた場合、ここは緑で CI は install で落ちる。**
 * - **`image` ジョブ**（`runtime` ステージを焼き、uid 1001 で道具が揃っているかを見る）:
 *   ここでは焼かない。
 *
 * **この2つを黙って落とさずに書いてあるのは意図である** — 「一式」と名乗る口が、何を
 * 見ていないかを言わないと、読む側は `verify` == CI と読む。
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// グローバルの `process` に頼らない（`packages/core/scripts/write-canon.mjs` と同じ理由。
// この repo の script はどれもこの形で揃えてある）。
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { classifyTest, decideSkip, fingerprint, recordPathFor } from './verify-core.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 記録の置き場。**git 自身に聞く**（`<repo>/.git` を組み立てない）。
 *
 * `git worktree` の作業ツリーでは `.git` はファイルなので、直に組み立てると
 * **一式が全部通った後に `ENOTDIR` で落ちる。** 理由と実測は
 * `verify-core.mjs` の `recordPathFor` に在る。
 */
const RECORD = recordPathFor(REPO);

/**
 * 一式。**順序に意味がある**（`build` が先。上の doc）。
 *
 * `openapi` だけ `pnpm` ではなく `git` なのは、生成物が最新かを見る検査だからである
 * （`pnpm build` が書き換えた後に差分が残っていれば、commit し忘れている）。
 *
 * **`HEAD` を明示するのは意図である。** CI は `actions/checkout` の直後なので index と
 * `HEAD` が必ず一致していて、素の `git diff` でも「`HEAD` と作業ツリーの差」を意味する。
 * **手元では index が汚れているのが普通なので、同じコマンドが違う意味になる** —
 * `pnpm build` が生成物を書き換えた後に `git add` だけしてソースだけを commit すると、
 * `HEAD` は古い生成物を持ったまま素の `git diff` は 0 を返す（**手元は緑、CI は赤**）。
 * 実測（2026-08-22、`HEAD`=旧 / index=新 / 作業ツリー=新）:
 *
 *     git diff --exit-code -- f        → 0   （素の形。差分を見落とす）
 *     git diff --exit-code HEAD -- f   → 1   （実際の乖離）
 */
const STEPS = [
  { name: 'build', cmd: 'pnpm', args: ['build'] },
  {
    name: 'web-bundle-node-traces',
    cmd: 'pnpm',
    args: ['check:web-bundle-node-traces'],
    hint:
      'apps/web の生成物に Node 専用の痕跡（createRequire / node: 指定子 / process.cwd / Bun.）が' +
      '混入している。@alteroid/core（や他の依存）から値を import してサーバ専用コードを引き込んで' +
      'いないか確認すること（scripts/check-web-bundle-node-traces.mjs の doc）',
  },
  {
    name: 'openapi',
    cmd: 'git',
    args: ['diff', '--exit-code', 'HEAD', '--', 'apps/daemon/openapi.json'],
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
 * が EPIPE で死ぬ）。**実測（2026-08-22）**: この取りこぼしを、下の「走っていない」の
 * 判定が捕まえた。**「落ちた」と読んでいたら、存在しない失敗を直しに行っていた。**
 */
const passthrough = argv.filter((arg) => arg !== '--' && arg !== '--force');

/**
 * 1手順を走らせる（テスト以外）。**素通し（`inherit`）で溜めない。**
 *
 * 全部を溜める形にしていたら、この器で `pnpm build` が **SIGABRT（exit 134）** で落ちた
 * （直接打つと通るのに、この口から呼ぶと落ちる）。
 */
function run(step) {
  process.stdout.write('\n=== ' + step.name + ': ' + step.cmd + ' ' + step.args.join(' ') + '\n');
  const r = spawnSync(step.cmd, step.args, { cwd: REPO, stdio: 'inherit' });
  if (r.error !== undefined && r.error !== null) {
    return { code: 1, startError: r.error };
  }
  // signal で殺された場合 `status` は null になる。**0 へ倒さない。**
  return { code: r.status ?? 1 };
}

/**
 * テストの手順だけは出力が要る（「走った」かを行の不在で見るため）。
 *
 * **`spawnSync` の `maxBuffer` に頼らないこと。** 超えると Node は出力を**打ち切って**
 * プロセスを殺すので、**いちばん要る `Test Files` / `Tests` の行（末尾に出る）が
 * ちょうど消える。** すると「走っていない」と読めてしまう ＝ 走って落ちたものが
 * exit 3 として出る。だから `spawn` で受けながら、**流しつつ自分で全部溜める。**
 *
 * **流すのは副産物ではなく要件である。** 溜めるだけだと、数分かかるテストの途中経過が
 * 一切見えない（`spawnSync` の形はそうなっていた）。
 *
 * **stdout と stderr は別々に溜める（#327）。** 以前は1本の `output` へ両方を
 * 多重化していた。子の stdout と stderr は別のパイプで、届いた順に別々の `data`
 * イベントが飛んでくるだけなので、両方を同じ文字列へ足すと**改行を跨いで混ざる**
 * — 一方が改行で終わらない書き込みの直後に、たまたま他方の書き込みが続くと、
 * 2つの書き手の内容が同じ行に見える。#326（`alteroid conversations` の出力が
 * 改行で終わらない）と組み合わさると、実際に `pnpm test` の生出力で1行に融合した
 * （Issue #327 の実測）。
 *
 * **`testRan` に渡すのは `stdout` だけにする。** 根拠は実測: `pnpm --filter
 * @alteroid/cli test` を stdout/stderr 別ストリームで受けたところ、vitest の
 * `Test Files` / `Tests` の集計行は**常に stdout 側**に出た（stderr 側には
 * テスト内のエラースタックだけが出て、集計行は1件も無かった）。これは
 * `vitest.setup.ts` の既存コメント「stdout に絞れば当たらないことは、全スイートの
 * stdout と stderr を別ファイルへ分けて取った実測で確かめてある」とも一致する。
 * **この前提を確かめずに stdout だけ見る形にすると判定が常に偽になりうるので、
 * 変える前に実測してある。**
 *
 * **同じストリーム内で食われる形は残るか**: 理論上は「stdout へ改行なしで書いた
 * 直後に、同じ stdout へ vitest 自身が集計行を書く」形が残りうる。ただし vitest の
 * 既定レポーターは集計ブロックの直前に自分で空行を書く（実測: `…(0 test)\n\n
 * Test Files  …` のように、集計行の直前の `\n` は vitest 自身の書き込みに含まれて
 * いる）ため、直前の書き込みが改行で終わっていなくても `^` はその vitest 自身の
 * 改行の後ろで一致する。**stdout 単独では、この形の食われ方は今回の実測では
 * 再現しなかった**（`vitest.setup.ts` が「本物の stdout への直書き」をテストの
 * 赤として検出する歯を持ったこと（#314 以降）も、この形の混入源を塞ぐ側に効いて
 * いる）。それでも「vitest の将来のレポーター実装が集計行の前に改行を持たなくなる」
 * 形の変化までは検査していない — 変われば同じ症状が再発しうる。
 */
function runTest(step) {
  const args = [...step.args, ...passthrough];
  process.stdout.write('\n=== ' + step.name + ': ' + step.cmd + ' ' + args.join(' ') + '\n');
  return new Promise((resolve) => {
    const child = spawn(step.cmd, args, { cwd: REPO, stdio: ['inherit', 'pipe', 'pipe'] });
    // **stdout だけを判定用に溜める**（上の doc）。stderr は流すだけで溜めない —
    // 溜めても `testRan` には渡さないので、溜める理由が無い（不要な状態を持つと、
    // 次に読む者が「判定に使っているのか」と誤読する）。
    let stdoutText = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutText += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      process.stdout.write(chunk.toString('utf8'));
    });
    child.on('error', (error) =>
      resolve({ output: stdoutText, status: null, signal: null, startError: error }),
    );
    child.on('close', (status, signal) => resolve({ output: stdoutText, status, signal }));
  });
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
  if (!step.isTest) {
    const { code, startError } = run(step);
    if (startError !== undefined) {
      process.stdout.write(
        '\n!! ' + step.name + ' を起動できなかった: ' + startError.message + '\n',
      );
      process.exit(1);
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
    continue;
  }

  const { output, status, signal, startError } = await runTest(step);
  if (startError !== undefined) {
    process.stdout.write('\n!! ' + step.name + ' を起動できなかった: ' + startError.message + '\n');
    process.exit(1);
  }

  // **結末は4つある。** 詳細は `verify-core.mjs` の `classifyTest`。
  const verdict = classifyTest({ status, signal, output });

  if (verdict.state === 'not-run') {
    process.stdout.write(
      '\n!! ' +
        step.name +
        ': **走っていない**（落ちたのではない）。`Test Files` / `Tests` の行が出ていない。\n' +
        '   器が混んでいる可能性が高い。並列度を下げて取り直すこと: `pnpm verify -- --maxWorkers=4`\n' +
        '   **この結果を「落ちた」と読まないこと** — 存在しない失敗を直しに行くことになる。\n',
    );
    process.exit(3);
  }

  if (verdict.state === 'undecidable') {
    process.stdout.write(
      '\n!! ' +
        step.name +
        ': **走ったかどうか判定できない**（' +
        verdict.reason +
        (verdict.signal === undefined || verdict.signal === null ? '' : ' ' + verdict.signal) +
        '）。\n' +
        '   要約の行は' +
        (verdict.ran ? '出ている' : '出ていない') +
        'が、プロセスが正常に終わっていないので結末が読めない。\n' +
        '   **「落ちた」とも「走っていない」とも読まないこと。** 並列度を下げても直らない\n' +
        '   （原因が混雑ではない）ので、まず何が殺したのかを見ること。\n',
    );
    process.exit(4);
  }

  if (verdict.state === 'failed') {
    process.stdout.write('\n!! ' + step.name + ' が落ちた（exit ' + verdict.code + '）\n');
    process.exit(1);
  }

  results.push(step.name);
}

// **指紋は走る前のものと突き合わせる。**
//
// 走り終わった時点で取り直したものだけを書くと、**走行中に誰かが直した分を「検証済み」
// として記録してしまう** — その1行は build も typecheck も lint も test も通って
// いないのに、次の `pnpm verify` は「変わっていない」と言って畳む。
//
// **この repo はその形を実際に踏みうる。** `AGENTS.md`「自分が走っている器」は、同じ作業
// ツリーを複数のプロセスが同時に書き換えた実例（3体の作業者が同一の `.git` を共有した）を
// 記録している。マネージャーと作業者が同じツリーに居るのは通常の運転である。
//
// だから**動いていたら記録しない。** 記録しないほうへ倒すのは安全側（次は必ず走る）。
const after = fingerprint(REPO);
const moved = after === null || after !== decided.fingerprint;

if (!moved && RECORD !== null) {
  // **記録の失敗で一式を落とさない。** ここまでで検証は全部通っている。記録は
  // 次回を速くするためのものなので、書けなかったら「書けなかった」と言って 0 で返す。
  try {
    writeFileSync(
      RECORD,
      JSON.stringify({ fingerprint: after, at: new Date().toISOString() }, null, 2) + '\n',
    );
  } catch (error) {
    process.stdout.write('（指紋を記録できなかった: ' + error.message + '。次も必ず走る）\n');
  }
}

process.stdout.write(
  '\n=== 検証一式: 全部通った（' +
    results.join(' / ') +
    '）\n' +
    (moved
      ? '⚠️ 走行中にツリーが動いたので記録していない（次も必ず走る）。\n' +
        '   **通ったのは走り始めた時点のツリーである。** いまのツリーは検証されていない。\n'
      : RECORD === null
        ? '（記録の置き場を取れなかったので記録していない。次も必ず走る）\n'
        : 'verify: recorded (' + after.slice(0, 12) + ')\n'),
);
