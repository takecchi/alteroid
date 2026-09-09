import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  assertAggregateBlocksUnambiguous,
  countAggregateBlocks,
  decideJudgementCategory,
  HarnessError,
  parseAggregateLines,
  ROOT,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * `.claude/skills/mutation-testing/mutate-core.mjs` の `parseAggregateLines` が
 * 「複合スクリプト（`vitest run && pnpm -r --if-present run test && …`）で vitest の
 * 集計ブロックが複数出たとき、最初のブロック（＝変異と無関係なことがある）だけを
 * 見て判定してしまう」欠陥の歯。
 *
 * **欠陥の機構**: 元の実装は `/^\s*Test Files\s+.+$/m`（`/g` 無し）で `.match()` して
 * いたため、`.match()` は**必ず最初の1件**を返していた。単一ブロックしか出ない
 * alteroid 自身（`scripts/test.mjs` が `spawn('vitest', ['run', ...])` で vitest を
 * 1回しか起こさない。`grep -Fn -- "spawn('vitest'" scripts/test.mjs`）では踏まない
 * が、測定対象の repo の `test` スクリプトが複合コマンドだと、無関係な最初のブロック
 * だけを見て「生存」（歯が在るのに無いと言う）または「検出」（歯が無いのに在ると
 * 言う）を静かに出す。実測（別 repo・mnemora）: 8アサーションが赤なのに「生存」と
 * 判定された。
 *
 * **直し方は「最後のブロックを採る」だけではない。** 複数ブロックが在ったという
 * 事実そのものを、件数として持ち回ったうえで、複数在れば判定を拒む
 * （`assertAggregateBlocksUnambiguous`）。`/g` を足して最後を採るだけの直し方だと、
 * 「複数在った」という事実が出力から消え、最初のブロックが無関係な理由で赤くても
 * 最後のブロックだけを見て静かに「生存」と言ってしまう——直したかった欠陥の別形が
 * 残る。
 *
 * **判定の入口は3箇所ある**（`grep -Fn -- 'testsRanCleanly' .claude/skills/mutation-testing/*.mjs`
 * で確認できる）: `mutate-core.mjs` の `decideJudgementCategory` / `mutate.mjs` の
 * `cmdBaseline` / `mutate.mjs` の `cmdRun`（run の先頭の baseline 確認）。3箇所とも
 * 同じ共有ヘルパー `assertAggregateBlocksUnambiguous` を呼ぶ形にして塞いだ。
 * `decideJudgementCategory` はここで直接ユニットテストする。`cmdBaseline` /
 * `cmdRun` は CLI として子プロセスで実際に起動し、`pnpm` を偽物に差し替えて
 * 複数ブロックの出力を与え、拒否（exit 1 かつ拒否メッセージ）を確認する
 * （下の `describe('mutate.mjs CLI …')`）。
 */

const SINGLE_BLOCK_ALL_PASSED = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

const SINGLE_BLOCK_WITH_FAILURE = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 10 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

/** 紛らわしい行（`Files` / `Tests` を含むが集計行の形ではない）。
 * `scripts/mutate-core-strip-ansi.test.ts` の DECOY_OUTPUT と同じ狙い——
 * 探す語を緩めていないことと、件数の数え方がこれを1ブロックとして誤カウント
 * しないことを、両方確かめる。 */
const DECOY_LINES = ['Files changed: 3', 'Tests: none'];

/** 複合スクリプト（`vitest run && pnpm -r --if-present run test && …`）が
 * 出す2ブロックの生ログを模したもの。1本目は変異と無関係な理由で赤い
 * （もし旧実装のように最初のブロックだけを見れば「検出」になる）。2本目
 * （最後）は緑（もし新実装が「最後を無条件に採用」するだけなら「生存」に
 * なる——だからこのテストは「最後を採る」ではなく「複数在ったら拒む」を
 * 確かめる）。 */
const MULTI_BLOCK_FIRST_RED_LAST_GREEN = [
  ' RUN  v4.1.10 /tmp/probe (workspace package A)',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  8 failed | 2 passed (10)',
  '   Start at  06:44:56',
  '   Duration  120ms',
  '',
  ...DECOY_LINES,
  '',
  ' RUN  v4.1.10 /tmp/probe (workspace package B)',
  '',
  ' Test Files  5 passed (5)',
  '      Tests  42 passed (42)',
  '   Start at  06:44:58',
  '   Duration  300ms',
].join('\n');

describe('mutate-core: parseAggregateLines は複数ブロックで「最後」を返す', () => {
  it('単一ブロックはこれまでどおり読める（回帰）', () => {
    const { filesLine, testsLine } = parseAggregateLines(SINGLE_BLOCK_ALL_PASSED);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  11 passed (11)');
  });

  it('複数ブロックのとき、最初ではなく最後のブロックを返す', () => {
    const { filesLine, testsLine } = parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    // 最初のブロック（赤）の値ではないことを明示的に確かめる。
    expect(filesLine).not.toBe('Test Files  1 failed (1)');
    expect(testsLine).not.toBe('Tests  8 failed | 2 passed (10)');
    // 最後のブロック（緑）の値であること。
    expect(filesLine).toBe('Test Files  5 passed (5)');
    expect(testsLine).toBe('Tests  42 passed (42)');
  });
});

describe('mutate-core: countAggregateBlocks の件数の数え方', () => {
  it('単一ブロックは1個（紛らわしい行が在っても増えない）', () => {
    const raw = [SINGLE_BLOCK_ALL_PASSED, ...DECOY_LINES].join('\n');
    const { filesMatches, testsMatches } = countAggregateBlocks(raw);
    expect(filesMatches).toHaveLength(1);
    expect(testsMatches).toHaveLength(1);
  });

  it('2ブロックは2個と数える', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks(MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(filesMatches).toHaveLength(2);
    expect(testsMatches).toHaveLength(2);
    // 実値も持ち回っていること（拒否メッセージが最初/最後の実値を引用するため）。
    expect(filesMatches[0]).toBe('Test Files  1 failed (1)');
    expect(filesMatches.at(-1)).toBe('Test Files  5 passed (5)');
  });

  it('集計行が1つも無ければ0個', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks('Error: write EPIPE');
    expect(filesMatches).toHaveLength(0);
    expect(testsMatches).toHaveLength(0);
  });
});

describe('mutate-core: assertAggregateBlocksUnambiguous', () => {
  it('単一ブロックでは何も投げない', () => {
    expect(() => assertAggregateBlocksUnambiguous(SINGLE_BLOCK_ALL_PASSED, 'test')).not.toThrow();
  });

  it('複数ブロックでは HarnessError を投げ、拒否メッセージに「なぜ」と「次に何を」が入っている', () => {
    let caught: unknown;
    try {
      assertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_RED_LAST_GREEN, 'decideJudgementCategory');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const message = (caught as Error).message;
    // 「なぜ拒むか」——複合スクリプトで複数ブロックが出ること、片方を採ると
    // 偽の判定を静かに作ること。鍵となる部分文字列だけを名指しする
    // （変更検知器にしない — 文言をまるごと固定しない）。
    expect(message).toContain('複合コマンド');
    expect(message).toContain('偽の「生存」');
    expect(message).toContain('偽の「検出」');
    // 「次に何をやればいいか」——生ログのどこを見るか、この repo の test スクリプトが
    // vitest を1回だけ起こす形か確認する手順。
    expect(message).toContain('次にやること');
    expect(message).toContain('Test Files');
    expect(message).toContain("spawn('vitest'");
    // 件数と、呼び出し元のラベルが入っている。
    expect(message).toContain('decideJudgementCategory');
    expect(message).toContain('2個');
  });
});

describe('mutate-core: decideJudgementCategory（判定の入口1/3）', () => {
  const artifactResultNotChecked = { artifactState: 'not-checked' };

  it('⭐ 単一ブロックのときは、これまでどおり判定できる（生存）', () => {
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: SINGLE_BLOCK_ALL_PASSED,
      ...parseAggregateLines(SINGLE_BLOCK_ALL_PASSED),
    });
    expect(category).toBe('生存');
  });

  it('⭐ 単一ブロックのときは、これまでどおり判定できる（検出）', () => {
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: SINGLE_BLOCK_WITH_FAILURE,
      ...parseAggregateLines(SINGLE_BLOCK_WITH_FAILURE),
    });
    expect(category).toBe('検出');
  });

  it('複数ブロックのときは判定を拒む（HarnessError）', () => {
    expect(() =>
      decideJudgementCategory(artifactResultNotChecked, {
        raw: MULTI_BLOCK_FIRST_RED_LAST_GREEN,
        ...parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN),
      }),
    ).toThrow(HarnessError);
  });

  it('複数ブロックのとき、拒否は「集計行が見つからない」エラーとは別のメッセージである', () => {
    // #444 以前からある別の拒否理由（集計行そのものが無い）と混ざらないこと。
    // 混ざると「複数在るのに『無い』と言う」——AGENTS.md が最も嫌う「『無い』の
    // 種類を潰す」形になる。
    let message = '';
    try {
      decideJudgementCategory(artifactResultNotChecked, {
        raw: MULTI_BLOCK_FIRST_RED_LAST_GREEN,
        ...parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('集計行（Test Files / Tests）が見つからない');
    expect(message).toContain('複数');
  });
});

/**
 * `mutate.mjs` の CLI 層（`cmdBaseline` / `cmdRun`）を子プロセスとして実際に
 * 起動し、`pnpm` を偽物へ差し替えて複数ブロックの出力を返させる。
 *
 * **なぜここだけ子プロセスか。** `mutate.mjs` はモジュール末尾で無条件に
 * `main()` を呼ぶ（`readMaxWorkers` の doc に理由がある）ため、素の `import`
 * では `process.argv` 次第で `process.exit()` が起きてテストプロセスを巻き込む。
 * 子プロセスとして起動すれば、exit code とメッセージだけを安全に観測できる。
 *
 * **`pnpm` を差し替える理由。** `cmdBaseline` / `cmdRun` は実際に
 * `spawnSync('pnpm', [...])` を起こす（`mutate-core.mjs` の `runTests`）。本物の
 * `pnpm test` を複数ブロックの出力に誘導する手段が無いので、`PATH` の先頭に
 * 偽の `pnpm` 実行ファイルを置き、複数ブロックのテキストをそのまま stdout へ
 * 書かせて exit 0 で終わらせる。
 */
describe('mutate.mjs CLI: baseline / run の先頭 baseline 確認（判定の入口2,3/3）', () => {
  const MUTATE_JS = fileURLToPath(
    new URL('../.claude/skills/mutation-testing/mutate.mjs', import.meta.url),
  );
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFakePnpmDir(outputText: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pnpm-'));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, 'pnpm');
    const content = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(outputText)});\nprocess.exit(0);\n`;
    fs.writeFileSync(scriptPath, content, { mode: 0o755 });
    return dir;
  }

  function runCli(
    args: string[],
    fakePnpmOutput: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const fakeDir = makeFakePnpmDir(fakePnpmOutput);
    const env = { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ''}` };
    try {
      const stdout = execFileSync('node', [MUTATE_JS, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stdout?: string; stderr?: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('baseline: 複数ブロックのとき exit 1 で拒否し、生ログが判定より前に出る', () => {
    const result = runCli(['baseline'], MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(result.status).toBe(1);
    // 生ログ（1本目・2本目の実値）が拒否メッセージより前に出ていること
    // （歯7「加工前の証跡」——判定を拒む経路でも生ログを先に出す）。
    const rawIdx = result.stdout.indexOf('Test Files  1 failed (1)');
    const refusalIdx = result.stdout.indexOf('判定を拒む');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(refusalIdx).toBeGreaterThan(rawIdx);
    expect(result.stdout).toContain('baseline');
    expect(result.stdout).toContain('次にやること');
  });

  it('run: baseline 確認で複数ブロックのとき exit 1 で拒否する（run: baseline というラベル）', () => {
    const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-plan-')), 'plan.json');
    tempDirs.push(path.dirname(planPath));
    fs.writeFileSync(planPath, '[]');
    const result = runCli(['run', '--plan', planPath], MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run: baseline');
    expect(result.stdout).toContain('次にやること');
  });
});
