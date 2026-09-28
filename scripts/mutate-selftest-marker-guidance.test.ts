import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  SELFTEST_RECOVERY_COMMANDS,
  selftestMarkerPresentMessage,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

/**
 * 「印が既にある」で止まったときの案内が、**復元経路を名指しする**ことの歯（#1262）。
 *
 * **塞いでいる穴**: selftest を変異の区間で signal で殺すと `try/finally` が
 * 走らず、実ソースが変異したまま残る。ところが人が見る `git status` には
 * `modified: …` としか出ない（印 `MUTATION-IN-PROGRESS.json` と控えは
 * どちらも `.gitignore` 済みなので現れない）。**元のソースの全文は印の中
 * （`originalContent`）にしかない。**
 *
 * ⟹ 次の1回は「印が既にある」で止まるが、**その文面が片付け方を言わないと、
 * 人は印を消して片付けたつもりになる** —— そのとき変異はソースに残り、
 * 復元の手がかりだけが消える。⛔ **この歯が守っているのは「案内が
 * `restore` を名指しし続けること」であって、文言そのものの美しさではない。**
 *
 * ⚠️ **Issue #1262 の本文が挙げた片付け方（`rm -f MUTATION-IN-PROGRESS.json` /
 * `rm -rf .mutation-testing`）は、変異の区間で殺された回には当てはまらない。**
 * ハーネスは正規の復元経路を既に持っている（`status` / `restore`）。
 *
 * **2層で撃つ**: 純粋な層（文面を組む関数を直接呼ぶ）と、配線の層
 * （使い捨ての ROOT に印を置いて CLI を実際に走らせる）。**前者だけだと
 * 「関数は在るが誰も呼んでいない」を見逃す。**
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * #1705 のやり直し（PR #1712 の続き）。理由の全文は
 * `scripts/mutate-root-override.test.ts` の同名関数の doc を参照
 * （この歯も同じ形の TOCTOU を持っていたため、同じ直し方を当てる）。
 *
 * 要約: 本物の REPO_ROOT は共有資源なので、そこへの「開始時と終わりの
 * `existsSync` の差分」でも外部干渉の窓が残る。ハーネスの `.mjs` 3ファイル
 * （同ディレクトリの `import` はこの3つだけ）をこのテスト専用の使い捨て
 * ツリーへ丸ごと写し、そのコピー側の CLI を `--root <path>` 付きで起こせば、
 * コピー自身の既定 ROOT（DEFAULT_ROOT）はこのテストの呼び出し以外の
 * 何者にも触られない。
 */
function makeIsolatedHarnessCopy(prefix: string) {
  const harnessRoot = makeTempDirSync(prefix);
  const srcDir = path.join(REPO_ROOT, '.claude/skills/mutation-testing');
  const destDir = path.join(harnessRoot, '.claude/skills/mutation-testing');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['mutate.mjs', 'mutate-core.mjs', 'mutate-selftest.mjs']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  return {
    harnessRoot,
    cli: path.join(destDir, 'mutate.mjs'),
    /** このコピー自身の既定 ROOT（DEFAULT_ROOT）の下に来る印のパス。 */
    markerPath: path.join(harnessRoot, 'MUTATION-IN-PROGRESS.json'),
  };
}

// ── 純粋な層: 文面を組む関数（副作用なし） ─────────────────────────

describe('mutate-selftest: selftestMarkerPresentMessage は復元経路を名指しする', () => {
  it('status と restore の両方のコマンドを、共有の定数そのままの形で含む', () => {
    const message = selftestMarkerPresentMessage('backup-corruption');

    // **定数を1つの出所にしてある**（#1119 の型）。文面と歯が同じ値から出るので、
    // 片方だけがずれることが構造的に起きない。
    expect(message).toContain(SELFTEST_RECOVERY_COMMANDS.status);
    expect(message).toContain(SELFTEST_RECOVERY_COMMANDS.restore);
  });

  it('案内するコマンドは mutate.mjs の status / restore である', () => {
    // **定数そのものを固定する。** 上の2本は `toContain(定数)` なので、定数が
    // 空文字へ倒れると素通りする（実際に変異を当てて確かめた）。⟹ 出所の側を
    // ここで釘付けにして、その抜け道を塞ぐ。
    expect(SELFTEST_RECOVERY_COMMANDS.status).toBe(
      'node .claude/skills/mutation-testing/mutate.mjs status',
    );
    expect(SELFTEST_RECOVERY_COMMANDS.restore).toBe(
      'node .claude/skills/mutation-testing/mutate.mjs restore',
    );
  });

  it('原文が印の中にしかないことを名指しし、印を消すだけで済ませないよう止める', () => {
    const message = selftestMarkerPresentMessage('backup-corruption');

    expect(message).toContain('originalContent');
    expect(message).toContain('MUTATION-IN-PROGRESS.json');
    expect(message).toContain('消すだけで片付けないこと');
  });

  it('どのシナリオで止まったかを頭に出す（複数シナリオを回しているときに効く）', () => {
    expect(selftestMarkerPresentMessage('backup-corruption')).toMatch(/^backup-corruption: /);
    expect(selftestMarkerPresentMessage('weak-tooth')).toMatch(/^weak-tooth: /);
  });
});

// ── 配線の層: CLI が実際にこの文面を出すか ───────────────────────────
//
// **使い捨ての ROOT を `--root` で渡す。** 実リポジトリの直下に印を置くと、
// 同時に走っている他の歯や人の作業を巻き込む（`mutate-root-override.test.ts`
// が同じ理由で同じ形を採っている）。

describe('mutate-selftest: 印が残った状態で selftest を起こすと、その案内が実際に出る', () => {
  it('印を置いた ROOT では backup-corruption が復元経路を出して止まる', () => {
    // 元の注記（#1705 最初の直し・PR #1712）: 「実 ROOT に印が絶対に無い」
    // ではなく「このテストの --root tmp 呼び出しが実 ROOT の印の状態を
    // 変えていない」を見る形にした（`scripts/mutate-root-override.test.ts`
    // 歯1の同じ注記を参照。この歯も同じ形の `expect(...).toBe(false)` を
    // 実 ROOT に対して持っていたため、#1705 で同じ壊れ方をした）。
    //
    // **#1705 のやり直し（この続き）**: その「開始時と終わりの差分」でも
    // TOCTOU の窓は残っていた。実 ROOT を見るのをやめ、このテスト専用の
    // 使い捨てツリー（`makeIsolatedHarnessCopy`）へハーネスを丸ごと写し、
    // その CLI を起こす。
    const harness = makeIsolatedHarnessCopy('mutate-selftest-marker-guidance-harness-');
    const tmp = makeTempDirSync('mutate-selftest-marker-guidance-');
    // 中身は読まれない —— `requireNoMarker` は存在だけを見て、シナリオの
    // いちばん最初（`ensureFixtureClean` より前）で止まる。
    fs.writeFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), '{}\n');

    const result = spawnSync(
      'node',
      [harness.cli, 'selftest', '--scenario', 'backup-corruption', '--root', tmp],
      { cwd: harness.harnessRoot, encoding: 'utf8', env: mutateCliChildEnv() },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('印が既にある');
    expect(output).toContain(SELFTEST_RECOVERY_COMMANDS.status);
    expect(output).toContain(SELFTEST_RECOVERY_COMMANDS.restore);

    // このハーネスのコピー自身の既定 ROOT には何も漏れていないこと
    // （対象の取り違えが起きていないこと）。harness.harnessRoot はこの
    // テストの呼び出し以外に触られない専用ツリーである。
    expect(fs.existsSync(harness.markerPath)).toBe(false);
  });

  it('歯（#1705 追加、消される向き）: このコピーの既定 ROOT にあらかじめ印の形のファイルが在っても、selftest の --root 実行はそれへ1バイトも触れない', () => {
    // **前の形（開始時に印が無い状態から始める）は「消される向き」を
    // 測れていなかった。** ここでは既定 ROOT に印の形のファイルをあらかじめ
    // 置き、selftest の実行前後でそれが1バイトも変わらないことを見る。
    //
    // **拒否されないことの確認（コードを読んで判断）**: この選定シナリオ
    // （backup-corruption）が見る印は `--root` の対象（tmp）側であって
    // （現に直前のテストで tmp 自身へ印を置いて「印が既にある」を発生させて
    // いる）、ハーネスの既定 ROOT（`DEFAULT_ROOT`）を直接読み書きする経路は
    // `mutate-core.mjs`/`mutate-selftest.mjs`/`mutate.mjs` のどこにも無い
    // （`--root` の解釈は `main()` の最初で終わり、以降は可変 export
    // `ROOT`/`MARKER_PATH`/`BACKUP_DIR` だけを経由する）。⟹ ここに印を
    // 置いても selftest は起動を拒否しない。
    const harness = makeIsolatedHarnessCopy('mutate-selftest-marker-guidance-harness-erase-');
    const preplacedMarkerContent =
      '{"probe":"mutate-selftest-marker-guidance-preexisting-marker"}\n';
    fs.writeFileSync(harness.markerPath, preplacedMarkerContent);

    const tmp = makeTempDirSync('mutate-selftest-marker-guidance-erase-');
    fs.writeFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), '{}\n');

    const result = spawnSync(
      'node',
      [harness.cli, 'selftest', '--scenario', 'backup-corruption', '--root', tmp],
      { cwd: harness.harnessRoot, encoding: 'utf8', env: mutateCliChildEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(harness.markerPath, 'utf8')).toBe(preplacedMarkerContent);
  });
});
