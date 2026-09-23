import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOT,
  HarnessError,
  setRootOverride,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';
import {
  DELIVERY_BARREL_REL,
  DELIVERY_BARREL_SCAFFOLD_BEGIN,
  DELIVERY_BARREL_SCAFFOLD_BLOCK,
  DELIVERY_BARREL_SCAFFOLD_END,
  DELIVERY_FIXTURE_MODULE_BODY,
  DELIVERY_FIXTURE_MODULE_REL,
  findLeftoverDeliveryScaffold,
  formatLeftoverDeliveryScaffoldNotice,
  requireNoLeftoverDeliveryFixtureFiles,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

/**
 * #1262 追加測定（Issue #1262 コメント 2026-09-23、#1166 コメント 2026-09-23）が
 * 挙げた案A（`restore` が成功した後、delivery の barrel 足場・フィクスチャ本体が
 * 残っていれば名指しして外し方を出す）の歯。
 *
 * **⛔ 塞いでいる形は (i) だけである** — selftest を signal で中断すると、印が
 * 在る回では `restore` は exit 0 で書き戻し・印の解除をしたあと、barrel 足場
 * （`packages/core/src/index.ts` の `DELIVERY_BARREL_SCAFFOLD_BEGIN`〜`END`）と
 * フィクスチャ本体（`packages/core/src/mutation-selftest-delivery-fixture.ts`）を
 * 残す。これは設計どおり（`removeDeliveryBarrelScaffoldIfSafe` のコメント）だが、
 * 中断された回には「印を片付けたら足場を手で外す」の一文（selftest 本体の
 * finally 経由）が出ない。**この歯が確かめるのは、`restore` の出力へその案内を
 * 足したことだけである。** `restoreMutation`（書き戻し・印の解除）自体は
 * 一切変えていない——⚠️ 印が作られる前の区間（barrel に足場が入った直後・
 * フィクスチャ変異前）で中断した回はこの歯の対象外である（`restore` はその回
 * 「印が無い」で先に落ちるので、この出力まで到達しない。次の selftest の入口
 * （`requireNoLeftoverDeliveryFixtureFiles`）が名指しする——直下の歯がそれも
 * 固定する）。
 *
 * **3層で撃つ**（`mutate-selftest-marker-guidance.test.ts` と同じ型）:
 *  1. 純粋な層 — `findLeftoverDeliveryScaffold`（検出。副作用なし）
 *  2. 文面固定の層 — `requireNoLeftoverDeliveryFixtureFiles`（切り出しの前後で
 *     1文字も変えていないことを、ハードコードした期待文字列で固定する）
 *  3. 配線の層 — 使い捨ての git ツリーに `--root` で `mutate.mjs restore` を
 *     実際に起こし、成功後の stdout に名指しが出ること／出ないこと（陽性対照）
 *     を確かめる
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

/** git 管理下の使い捨てツリーを作る（apply/restore が gitHead() 等を呼ぶため）。 */
function makeTmpGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-delivery-scaffold-leftover-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
  fs.mkdirSync(path.join(dir, 'packages/core/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, DELIVERY_BARREL_REL), 'export const already = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const PLACEHOLDER_SPEC = {
  id: 'delivery-scaffold-leftover-probe',
  file: 'target.txt',
  from: 'hello',
  to: 'HELLO',
  expect: 1,
  target: null,
  // apply/restore の往復だけを測る歯なので judge は呼ばない（実テストが無い
  // tmp リポジトリ）。`mutate-root-override.test.ts` の同じ理由と同じ扱い。
  mustFail: [
    'delivery-scaffold-leftover-probe はこの歯で judge を呼ばない（apply/restore のみを測る）',
  ],
};

function writeSpec(dir: string): string {
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(PLACEHOLDER_SPEC));
  return specPath;
}

function writeBothScaffold(dir: string) {
  fs.appendFileSync(path.join(dir, DELIVERY_BARREL_REL), DELIVERY_BARREL_SCAFFOLD_BLOCK);
  fs.writeFileSync(path.join(dir, DELIVERY_FIXTURE_MODULE_REL), DELIVERY_FIXTURE_MODULE_BODY);
}

function writeFixtureOnly(dir: string) {
  fs.writeFileSync(path.join(dir, DELIVERY_FIXTURE_MODULE_REL), DELIVERY_FIXTURE_MODULE_BODY);
}

function writeBarrelOnly(dir: string) {
  fs.appendFileSync(path.join(dir, DELIVERY_BARREL_REL), DELIVERY_BARREL_SCAFFOLD_BLOCK);
}

// ── 純粋な層: findLeftoverDeliveryScaffold（副作用なし） ──────────────
//
// **ROOT を書き換える。** `absPath` / `readRepoFile`（`mutate-core.mjs`）が
// module scope の `ROOT` を見るため。`mutate-root-override.test.ts` の
// 「純粋な層」と同じ理由で、各 it は必ず `finally` で `DEFAULT_ROOT` へ戻す
// ——同一ファイル内の他の it・他の describe（文面固定・配線の層）を汚染しない。

describe('mutate-selftest: findLeftoverDeliveryScaffold（純粋な検出）', () => {
  it('足場もフィクスチャも無ければ空配列', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-pure-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('barrel（packages/core/src/index.ts）そのものが無くても空配列（ENOENT を「足場無し」として飲み込む）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-pure-noindex-'));
    try {
      // packages/core を丸ごと作らない — --root が alteroid 以外のツリーを
      // 指す使い捨てテスト（このファイルの配線の層）で常に起きる形。
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('フィクスチャ本体だけ在れば1件（kind: fixture）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-pure-fixture-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeFixtureOnly(tmp);
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([
        { kind: 'fixture', path: DELIVERY_FIXTURE_MODULE_REL },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('barrel の re-export 行だけ在れば1件（kind: barrel）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-pure-barrel-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBarrelOnly(tmp);
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([
        { kind: 'barrel', path: DELIVERY_BARREL_REL },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('両方在れば2件、順序はフィクスチャ→barrel（元の requireNoLeftover…の判定順と同じ）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-pure-both-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBothScaffold(tmp);
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([
        { kind: 'fixture', path: DELIVERY_FIXTURE_MODULE_REL },
        { kind: 'barrel', path: DELIVERY_BARREL_REL },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 文面固定の層: requireNoLeftoverDeliveryFixtureFiles を1文字も変えない ──
//
// **切り出し（findLeftoverDeliveryScaffold への委譲）の前後で、この関数が
// 投げるメッセージが1バイトも変わっていないことを、ハードコードした期待
// 文字列で固定する。** 期待文字列は実装から読み出したものではなく、この
// PR の着手前に実測した逐語である（報告に生ログを添えてある）。

describe('mutate-selftest: requireNoLeftoverDeliveryFixtureFiles の文面は不変', () => {
  it('足場が無ければ何もしない（投げない）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-msg-none-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      setRootOverride(tmp);
      expect(() => requireNoLeftoverDeliveryFixtureFiles('delivery')).not.toThrow();
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('両方在るときの文面（逐語固定）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-msg-both-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBothScaffold(tmp);
      setRootOverride(tmp);
      expect(() => requireNoLeftoverDeliveryFixtureFiles('delivery')).toThrow(
        new RegExp(
          '^delivery: 前回の selftest が置き去りにした足場が在る。上書きしない。\\n' +
            '  - packages/core/src/mutation-selftest-delivery-fixture\\.ts（フィクスチャ本体）\\n' +
            '  - packages/core/src/index\\.ts（一時的な re-export 行が残っている）\\n' +
            '中身を確認してから手で消して、再実行すること。印（MUTATION-IN-PROGRESS\\.json）が' +
            '残っているなら、先にそちらを `mutate\\.mjs status` / `restore` で片付けること——' +
            'フィクスチャ本体を先に消すと復元先が無くなる。packages/core/src/index\\.ts は' +
            '「// ── mutation-testing selftest 用の一時的な足場（#1166 面1）ここから ──」から' +
            '「// ── mutation-testing selftest 用の一時的な足場（#1166 面1）ここまで ──」までの' +
            '行を削除すれば元に戻る（フィクスチャ本体 ' +
            'packages/core/src/mutation-selftest-delivery-fixture\\.ts も合わせて削除）。$',
        ),
      );
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('フィクスチャ本体だけのときは、その1行だけを名指しする（barrel の行は出ない）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-msg-fixture-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeFixtureOnly(tmp);
      setRootOverride(tmp);
      let thrown: unknown;
      try {
        requireNoLeftoverDeliveryFixtureFiles('delivery');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HarnessError);
      const message = (thrown as Error).message;
      expect(message).toContain(
        '  - packages/core/src/mutation-selftest-delivery-fixture.ts（フィクスチャ本体）\n',
      );
      expect(message).not.toContain('一時的な re-export 行が残っている');
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('barrel の re-export 行だけのときは、その1行だけを名指しする（フィクスチャの行は出ない）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scaffold-msg-barrel-'));
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBarrelOnly(tmp);
      setRootOverride(tmp);
      let thrown: unknown;
      try {
        requireNoLeftoverDeliveryFixtureFiles('delivery');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HarnessError);
      const message = (thrown as Error).message;
      expect(message).toContain(
        '  - packages/core/src/index.ts（一時的な re-export 行が残っている）\n',
      );
      expect(message).not.toContain('フィクスチャ本体）');
    } finally {
      setRootOverride(DEFAULT_ROOT);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 純粋な層: formatLeftoverDeliveryScaffoldNotice ─────────────────────

describe('mutate-selftest: formatLeftoverDeliveryScaffoldNotice', () => {
  it('見つからなければ null（cmdRestore はこれで「何も足さない」を判定する）', () => {
    expect(formatLeftoverDeliveryScaffoldNotice([])).toBeNull();
  });

  it('見つかった場合は、BEGIN/END の逐語と両方のパスを含む1つの文字列を返す', () => {
    const notice = formatLeftoverDeliveryScaffoldNotice([
      { kind: 'fixture', path: DELIVERY_FIXTURE_MODULE_REL },
      { kind: 'barrel', path: DELIVERY_BARREL_REL },
    ]);
    expect(notice).not.toBeNull();
    expect(notice as string).toContain(DELIVERY_FIXTURE_MODULE_REL);
    expect(notice as string).toContain(DELIVERY_BARREL_REL);
    expect(notice as string).toContain(DELIVERY_BARREL_SCAFFOLD_BEGIN);
    expect(notice as string).toContain(DELIVERY_BARREL_SCAFFOLD_END);
    // **`restore` は既に成功している文脈である** ——
    // `requireNoLeftoverDeliveryFixtureFiles` が言う「先に印を片付けること」は
    // ここでは言わない（言うと、印は既に解除済みなのに矛盾した案内になる）。
    expect(notice as string).not.toContain('先にそちらを');
  });
});

// ── 配線の層: mutate.mjs restore を実プロセスとして起こす ─────────────

describe('mutate.mjs CLI: restore は成功した後、delivery の足場が残っていれば名指しする', () => {
  it('陽性対照（足場なし）: 復元元/後始末の行の後は1文字も増えない（末尾の改行1個のみ）', () => {
    const tmp = makeTmpGitRepo();
    try {
      // この歯専用: packages/core/src/index.ts に足場を一切足さない
      // （makeTmpGitRepo が書くのは素の barrel 本体だけ）。
      const specPath = writeSpec(tmp);
      const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
      expect(applyResult.status).toBe(0);

      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(0);

      const stdout = restoreResult.stdout ?? '';
      const marker = '復元元: backup / 後始末: target が無いので後始末は不要（build exit=N/A）';
      const idx = stdout.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      // **ここが歯の核心** —— 現行の出力（この PR 着手前に実測した逐語）は
      // この行のあと改行1個で終わる。1文字でも増えたら、足場が無い回にも
      // 何かを足したことになる。
      expect(stdout.slice(idx)).toBe(`${marker}\n`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('足場が両方在るとき: 2ファイルを名指しし、外し方を出す', () => {
    const tmp = makeTmpGitRepo();
    try {
      writeBothScaffold(tmp);
      const specPath = writeSpec(tmp);
      const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
      expect(applyResult.status).toBe(0);

      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(0);
      const stdout = restoreResult.stdout ?? '';

      expect(stdout).toContain(
        '復元元: backup / 後始末: target が無いので後始末は不要（build exit=N/A）',
      );
      expect(stdout).toContain('delivery: 前回の selftest が置き去りにした足場が残っている');
      expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
      expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
      expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_BEGIN);
      expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_END);

      // 足場は「残す」設計そのままである——restore はこれを消さない。
      expect(fs.existsSync(path.join(tmp, DELIVERY_FIXTURE_MODULE_REL))).toBe(true);
      expect(fs.readFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'utf8')).toContain(
        DELIVERY_BARREL_SCAFFOLD_BEGIN,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('フィクスチャ本体だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepo();
    try {
      writeFixtureOnly(tmp);
      const specPath = writeSpec(tmp);
      runCli(['apply', '--spec', specPath, '--root', tmp]);
      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(0);
      const stdout = restoreResult.stdout ?? '';

      expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
      expect(stdout).not.toContain('一時的な re-export 行が残っている');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('barrel の re-export 行だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepo();
    try {
      writeBarrelOnly(tmp);
      const specPath = writeSpec(tmp);
      runCli(['apply', '--spec', specPath, '--root', tmp]);
      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(0);
      const stdout = restoreResult.stdout ?? '';

      expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
      expect(stdout).not.toContain('フィクスチャ本体）');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 配線の層: 印が無い区間で restore が失敗する回（#1358 の限界を塞ぐ） ──
//
// #1358 が足した名指しは `restoreMutation` が成功した後にしか出ない。印が
// 作られる前の区間（barrel に足場が入った直後・フィクスチャの変異前）で
// selftest が中断すると、印は無いのに足場だけが残る——この区間で `restore`
// を打つと `restoreMutation` は `readMarkerVerified` の入口で
// HarnessError('印が無い。') を投げ、#1358 の名指しへ一度も到達しない。
// この歯が確かめるのは、`cmdRestore` がその例外を捕まえ、印が無い場合に
// 限って足場の名指しを例外メッセージへ足して投げ直すことだけである。
// `restoreMutation` 自体・「印が無い。」の文面・exit code（1）は一切
// 変えていない。

/** 印を作らず、apply も呼ばずに足場だけを置いた使い捨てツリーを返す。 */
function makeTmpGitRepoWithScaffoldNoMarker(write: (dir: string) => void): string {
  const tmp = makeTmpGitRepo();
  write(tmp);
  return tmp;
}

/**
 * apply で印を作った後、控え（`marker.backupPath`）を壊す——
 * `restoreMutation` は控えの md5 が `md5Pre` と一致しないと判断し、
 * 「印は残す」側の HarnessError を投げる（`mutate-core.mjs` 2257行付近）。
 * これは「印が在るのに `restoreMutation` が失敗する」を安定して再現できる
 * 数少ない形——ここでは印は最後まで残る。
 */
function applyThenCorruptBackup(tmp: string): void {
  const specPath = writeSpec(tmp);
  const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
  expect(applyResult.status).toBe(0);
  const marker = JSON.parse(fs.readFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), 'utf8'));
  fs.writeFileSync(path.join(tmp, marker.backupPath), 'CORRUPTED\n');
}

describe('mutate.mjs CLI: restore が「印が無い」で失敗する場合も、足場が残っていれば名指しする（#1358 の限界を塞ぐ）', () => {
  it('陽性対照（印も足場も無い）: 出力は現行の main と逐語で同じ（足した文が1文字も出ない）', () => {
    const tmp = makeTmpGitRepo();
    try {
      // apply を呼ばない — 印そのものが無い状態を作る。足場も置かない。
      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(1);
      const stdout = restoreResult.stdout ?? '';
      // 実装前に実測した逐語（このテストを実装前に赤/緑いずれでも走らせて
      // 固定した値）。`ROOT: …` の行だけ tmp のパスに依存するので、
      // 固定の末尾（restore セクション以降）だけを厳密に照合する。
      const idx = stdout.indexOf('── restore ──');
      expect(idx).toBeGreaterThan(-1);
      expect(stdout.slice(idx)).toBe('── restore ──\nエラー: 印が無い。\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('印が無く、足場が両方在るとき: 「印が無い。」は残ったまま、名指しと外し方も出る', () => {
    const tmp = makeTmpGitRepoWithScaffoldNoMarker(writeBothScaffold);
    try {
      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(1);
      const stdout = restoreResult.stdout ?? '';

      expect(stdout).toContain('エラー: 印が無い。');
      expect(stdout).toContain('delivery: 前回の selftest が置き去りにした足場が残っている');
      expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
      expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
      expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_BEGIN);
      expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_END);
      // **この回は何も復元していない。** 成功後の文脈の「印の解除はここまでで
      // 完了している」を言うと嘘になる（#1262 継続）。
      expect(stdout).toContain('印は最初から無く、この restore は何も書き戻していない');
      expect(stdout).not.toContain('印の解除はここまでで完了している');

      // 足場は消えていない——`restoreMutation` に一切触っていないので、
      // 「印が無い」で失敗した回が足場を消す/作るということも無い。
      expect(fs.existsSync(path.join(tmp, DELIVERY_FIXTURE_MODULE_REL))).toBe(true);
      expect(fs.readFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'utf8')).toContain(
        DELIVERY_BARREL_SCAFFOLD_BEGIN,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('印が無く、フィクスチャ本体だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepoWithScaffoldNoMarker(writeFixtureOnly);
    try {
      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(1);
      const stdout = restoreResult.stdout ?? '';

      expect(stdout).toContain('エラー: 印が無い。');
      expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
      expect(stdout).not.toContain('一時的な re-export 行が残っている');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('印が無く、barrel の re-export 行だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepoWithScaffoldNoMarker(writeBarrelOnly);
    try {
      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(1);
      const stdout = restoreResult.stdout ?? '';

      expect(stdout).toContain('エラー: 印が無い。');
      expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
      expect(stdout).not.toContain('フィクスチャ本体）');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('印は在るが restoreMutation が失敗する回（控えが汚染されている）は、足場が在っても名指しを出さない', () => {
    const tmp = makeTmpGitRepo();
    try {
      writeBothScaffold(tmp);
      applyThenCorruptBackup(tmp);

      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(1);
      const stdout = restoreResult.stdout ?? '';

      // 印を残す側の既存の文面はそのまま出る。
      expect(stdout).toContain('控えの md5 が md5Pre と一致しない');
      expect(stdout).toContain('印は残す。');
      // 足場は在るのに、名指しは出ない——印が在る回にはこの PR の変更は
      // 一切触らない(今までどおり)。
      expect(stdout).not.toContain('delivery: 前回の selftest が置き去りにした足場が残っている');

      // 印は本当に残っている（"印は残す。" が字義どおりであることの裏取り）。
      expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
