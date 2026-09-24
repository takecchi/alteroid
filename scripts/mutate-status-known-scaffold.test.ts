import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import {
  DEFAULT_ROOT,
  setRootOverride,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';
import {
  collectKnownSelftestScaffoldNotices,
  DELIVERY_BARREL_REL,
  DELIVERY_BARREL_SCAFFOLD_BLOCK,
  DELIVERY_FIXTURE_MODULE_BODY,
  DELIVERY_FIXTURE_MODULE_REL,
  findLeftoverJudgementFixtureScaffold,
  findLeftoverWeakToothScaffold,
  formatLeftoverJudgementFixtureScaffoldNotice,
  formatLeftoverWeakToothScaffoldNotice,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

/**
 * Issue #1262 案B（marker が無くても `status` が既知の selftest 足場を見る）の歯。
 *
 * **背景**: #1358 / #1372 は `restore`（marker がある側・無い側の両方）に、
 * delivery の barrel 足場・フィクスチャ本体を名指しする経路を足した。しかし
 * `status` は marker が無ければ何も見ずに「印は無い。」で exit 0 のままだった
 * ——実測（Issue #1262 の2026-09-23コメント）は、signal で中断した回に
 * delivery 系（barrel 足場・フィクスチャ）と weak-tooth 系（使い捨てファイル
 * 3本）の両方が、marker を経由せずに残ることを確認している。2026-09-23 の
 * 決定コメントが「現状維持。次に手を入れるなら案B」としたのを受けて、この
 * PR で案Bを実装した。
 *
 * **代償（コードの側にも同じものを書いてある。`mutate.mjs` の `cmdStatus`）**:
 * (a) 汎用の `status` が selftest 固有のパスを知る結合が生まれる
 * (b) 「印は無い」の意味が変わる —— 従来は `exit 0 ⟺ 印が無い`。これからは
 *     `exit 0 ⟺ 印が無い かつ 既知の足場も無い`。
 *
 * **3層で撃つ**（`mutate-delivery-scaffold-leftover.test.ts` と同じ型）:
 *  1. 純粋な層 — `findLeftoverWeakToothScaffold` / `findLeftoverJudgementFixtureScaffold`
 *     / `collectKnownSelftestScaffoldNotices`（検出・集約。副作用なし）
 *  2. 文面の層 — `formatLeftover*ScaffoldNotice`（見つからなければ null。
 *     見つかれば名指し＋外し方）
 *  3. 配線の層 — 使い捨ての git ツリーに `--root` で `mutate.mjs status` を
 *     実際に起こし、marker が無い側で足場を名指しすること（陽性）・無関係な
 *     ファイルは名指ししないこと（過剰検出の対照）・marker がある側は従来
 *     どおりで足場を見ないこと、を確かめる
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

function runCli(args: string[]) {
  return spawnSync('node', [MUTATE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

/** git 管理下の使い捨てツリーを作る（`gitHead()` 等が呼ばれるため）。 */
function makeTmpGitRepo(): string {
  const dir = makeTempDirSync('mutate-status-known-scaffold-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'packages/core/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps/cli/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, DELIVERY_BARREL_REL), 'export const already = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const WEAK_TOOTH_FILE = 'apps/cli/src/mutation-selftest-render.ts';
const JUDGEMENT_FILES = [
  'apps/cli/src/mutation-selftest-judgement-render.ts',
  'apps/cli/src/mutation-selftest-judgement-render.test.ts',
];

// ── 純粋な層: findLeftoverWeakToothScaffold / findLeftoverJudgementFixtureScaffold ──
//
// **ROOT を書き換える。** `absPath`（`mutate-core.mjs`）が module scope の
// `ROOT` を見るため。`mutate-delivery-scaffold-leftover.test.ts` と同じ理由で
// 各 it は必ず `finally` で `DEFAULT_ROOT` へ戻す。

describe('mutate-selftest: findLeftoverWeakToothScaffold（純粋な検出）', () => {
  it('無ければ空配列', () => {
    const tmp = makeTempDirSync('weak-tooth-scaffold-pure-none-');
    try {
      setRootOverride(tmp);
      expect(findLeftoverWeakToothScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('1本だけ在れば1件（kind: weak-tooth）', () => {
    const tmp = makeTempDirSync('weak-tooth-scaffold-pure-one-');
    try {
      fs.mkdirSync(path.join(tmp, 'apps/cli/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, WEAK_TOOTH_FILE), 'x\n');
      setRootOverride(tmp);
      expect(findLeftoverWeakToothScaffold()).toEqual([
        { kind: 'weak-tooth', path: WEAK_TOOTH_FILE },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('似た名前だが別のファイル（過剰検出の対照）は含まない', () => {
    const tmp = makeTempDirSync('weak-tooth-scaffold-pure-unrelated-');
    try {
      fs.mkdirSync(path.join(tmp, 'apps/cli/src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'apps/cli/src/mutation-selftest-render-NOT-A-SCAFFOLD.ts'),
        'x\n',
      );
      setRootOverride(tmp);
      expect(findLeftoverWeakToothScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });
});

describe('mutate-selftest: findLeftoverJudgementFixtureScaffold（純粋な検出）', () => {
  it('無ければ空配列', () => {
    const tmp = makeTempDirSync('judgement-scaffold-pure-none-');
    try {
      setRootOverride(tmp);
      expect(findLeftoverJudgementFixtureScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('2本とも在れば2件、順序は定義順', () => {
    const tmp = makeTempDirSync('judgement-scaffold-pure-both-');
    try {
      fs.mkdirSync(path.join(tmp, 'apps/cli/src'), { recursive: true });
      for (const rel of JUDGEMENT_FILES) fs.writeFileSync(path.join(tmp, rel), 'x\n');
      setRootOverride(tmp);
      expect(findLeftoverJudgementFixtureScaffold()).toEqual(
        JUDGEMENT_FILES.map((rel) => ({ kind: 'judgement-fixture', path: rel })),
      );
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });
});

// ── 文面の層: formatLeftover*ScaffoldNotice ──────────────────────────

describe('mutate-selftest: formatLeftoverWeakToothScaffoldNotice / formatLeftoverJudgementFixtureScaffoldNotice', () => {
  it('見つからなければ null（collectKnownSelftestScaffoldNotices はこれで「無い」を判定する）', () => {
    expect(formatLeftoverWeakToothScaffoldNotice([])).toBeNull();
    expect(formatLeftoverJudgementFixtureScaffoldNotice([])).toBeNull();
  });

  it('見つかった場合はパスを含む名指し文を返す（weak-tooth）', () => {
    const notice = formatLeftoverWeakToothScaffoldNotice([
      { kind: 'weak-tooth', path: WEAK_TOOTH_FILE },
    ]);
    expect(notice).not.toBeNull();
    expect(notice as string).toContain(WEAK_TOOTH_FILE);
    expect(notice as string).toContain('weak-tooth');
  });

  it('見つかった場合はパスを含む名指し文を返す（judgement-fixture）', () => {
    const notice = formatLeftoverJudgementFixtureScaffoldNotice(
      JUDGEMENT_FILES.map((rel) => ({ kind: 'judgement-fixture', path: rel })),
    );
    expect(notice).not.toBeNull();
    for (const rel of JUDGEMENT_FILES) expect(notice as string).toContain(rel);
    expect(notice as string).toContain('judgement-fixture');
  });
});

// ── 純粋な層: collectKnownSelftestScaffoldNotices（3種の集約） ─────────

describe('mutate-selftest: collectKnownSelftestScaffoldNotices', () => {
  it('何も無ければ空配列', () => {
    const tmp = makeTempDirSync('collect-scaffold-none-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      setRootOverride(tmp);
      expect(collectKnownSelftestScaffoldNotices()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('3種すべて在れば3件返す', () => {
    const tmp = makeTempDirSync('collect-scaffold-all-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'apps/cli/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      fs.appendFileSync(path.join(tmp, DELIVERY_BARREL_REL), DELIVERY_BARREL_SCAFFOLD_BLOCK);
      fs.writeFileSync(path.join(tmp, DELIVERY_FIXTURE_MODULE_REL), DELIVERY_FIXTURE_MODULE_BODY);
      fs.writeFileSync(path.join(tmp, WEAK_TOOTH_FILE), 'x\n');
      for (const rel of JUDGEMENT_FILES) fs.writeFileSync(path.join(tmp, rel), 'x\n');
      setRootOverride(tmp);
      const notices = collectKnownSelftestScaffoldNotices();
      expect(notices).toHaveLength(3);
      expect(notices.some((n: string) => n.includes('delivery'))).toBe(true);
      expect(notices.some((n: string) => n.includes('weak-tooth'))).toBe(true);
      expect(notices.some((n: string) => n.includes('judgement-fixture'))).toBe(true);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });
});

// ── 配線の層: mutate.mjs status を実プロセスとして起こす ──────────────

describe('mutate.mjs CLI: status は marker が無くても既知の足場を名指しする（#1262 案B）', () => {
  it('陽性対照（印も足場も無い）: 従来どおり exit 0、足場の節は出ない', () => {
    const tmp = makeTmpGitRepo();
    const result = runCli(['status', '--root', tmp]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('印は無い。このツリーに変異が当たったままの状態は無い。');
    expect(result.stdout).not.toContain('既知の足場');
  });

  it('weak-tooth の使い捨てファイルだけが残っているとき: 名指しして exit 2', () => {
    const tmp = makeTmpGitRepo();
    fs.writeFileSync(path.join(tmp, WEAK_TOOTH_FILE), 'x\n');
    const result = runCli(['status', '--root', tmp]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('印は無い。このツリーに変異が当たったままの状態は無い。');
    expect(result.stdout).toContain('既知の足場が残っている');
    expect(result.stdout).toContain(`  - ${WEAK_TOOTH_FILE}`);
  });

  it('delivery の barrel 足場・フィクスチャが残っているとき: 名指しして exit 2', () => {
    const tmp = makeTmpGitRepo();
    fs.appendFileSync(path.join(tmp, DELIVERY_BARREL_REL), DELIVERY_BARREL_SCAFFOLD_BLOCK);
    fs.writeFileSync(path.join(tmp, DELIVERY_FIXTURE_MODULE_REL), DELIVERY_FIXTURE_MODULE_BODY);
    const result = runCli(['status', '--root', tmp]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('delivery:');
    expect(result.stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
    expect(result.stdout).toContain(
      `  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`,
    );
  });

  it('judgement-fixture の使い捨てファイルだけが残っているとき: 名指しして exit 2', () => {
    const tmp = makeTmpGitRepo();
    for (const rel of JUDGEMENT_FILES) fs.writeFileSync(path.join(tmp, rel), 'x\n');
    const result = runCli(['status', '--root', tmp]);
    expect(result.status).toBe(2);
    for (const rel of JUDGEMENT_FILES) expect(result.stdout).toContain(`  - ${rel}`);
  });

  it('やりすぎの対照: 似た名前だが違うファイルは名指ししない（exit 0 のまま）', () => {
    const tmp = makeTmpGitRepo();
    // weak-tooth のフィクスチャに名前が似ているだけの無関係なファイル。
    fs.writeFileSync(
      path.join(tmp, 'apps/cli/src/mutation-selftest-render-NOT-A-SCAFFOLD.ts'),
      'x\n',
    );
    // delivery のフィクスチャにも名前が似ているだけの無関係なファイル。
    fs.writeFileSync(
      path.join(tmp, 'packages/core/src/mutation-selftest-delivery-fixture-OTHER.ts'),
      'x\n',
    );
    const result = runCli(['status', '--root', tmp]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('印は無い。このツリーに変異が当たったままの状態は無い。');
    expect(result.stdout).not.toContain('既知の足場');
  });

  it('marker が在るとき: 足場が同時に残っていても、従来どおり marker 側の説明だけを出す（案Bは無関係のまま）', () => {
    const tmp = makeTmpGitRepo();
    fs.writeFileSync(path.join(tmp, WEAK_TOOTH_FILE), 'x\n');
    const originalContent = 'original\n';
    fs.writeFileSync(
      path.join(tmp, 'MUTATION-IN-PROGRESS.json'),
      JSON.stringify({
        file: 'target.txt',
        mutationId: 'probe',
        from: 'a',
        to: 'b',
        startedAt: new Date().toISOString(),
        backupPath: '.mutation-testing/backups/does-not-matter.bak',
        headBefore: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        originalContent,
        md5Pre: execFileSync('node', [
          '-e',
          "process.stdout.write(require('crypto').createHash('md5').update(process.argv[1],'utf8').digest('hex'))",
          originalContent,
        ]).toString(),
        manualRestore: { command: 'noop', verifyMd5Command: 'noop', expectedMd5: 'deadbeef' },
        alternativeWithCaveat: 'noop',
      }),
    );
    const result = runCli(['status', '--root', tmp]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('このツリーには変異が当たったままである。');
    // marker が在る側の分岐には触れていない —— 足場の名指しは出ない。
    expect(result.stdout).not.toContain('既知の足場が残っている');
  });
});
