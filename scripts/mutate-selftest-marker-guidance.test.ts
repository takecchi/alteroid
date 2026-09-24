import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

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
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

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
    const tmp = makeTempDirSync('mutate-selftest-marker-guidance-');
    // 中身は読まれない —— `requireNoMarker` は存在だけを見て、シナリオの
    // いちばん最初（`ensureFixtureClean` より前）で止まる。
    fs.writeFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), '{}\n');

    const result = spawnSync(
      'node',
      [MUTATE_CLI, 'selftest', '--scenario', 'backup-corruption', '--root', tmp],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('印が既にある');
    expect(output).toContain(SELFTEST_RECOVERY_COMMANDS.status);
    expect(output).toContain(SELFTEST_RECOVERY_COMMANDS.restore);

    // 実リポジトリ側へ漏れていないこと（対象の取り違えが起きていないこと）。
    expect(fs.existsSync(path.join(REPO_ROOT, 'MUTATION-IN-PROGRESS.json'))).toBe(false);
  });
});
