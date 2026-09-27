import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

/**
 * **具体のモデル id（`claude-opus-5` のような版まで含んだ名前）を、コードへ
 * 直書きさせない歯（Issue #1192）。**
 *
 * ## なぜ要るか
 *
 * `.claude/skills/dev-setup/SKILL.md`（この項は #1753 で `AGENTS.md`「開発手順」
 * から移った）が言うとおり、alteroid のコードは具体のモデル id を
 * 1つも持たない設計になっている（`CLONE_MODEL` / `MANAGER_MODEL` /
 * `WORKER_MODEL` はエイリアス `fable` / `opus` / `sonnet` で、具体の id への
 * 対応は同梱 SDK のバンドル `sdk.mjs` の `aliases` が持つ）。**この設計判断は
 * コメントでしか語られておらず、機械では確かめられていなかった。** 誰かが
 * うっかり具体の id を書いても、型もビルドも黙って通る——だから歯にする。
 *
 * ## 測るもの
 *
 * 追跡ファイルのうち**コードだけ**（`.ts` / `.tsx` / `.mts` / `.cts` / `.js` /
 * `.mjs` / `.cjs`）に、具体のモデル id（`claude-(opus|sonnet|haiku|fable)-<数字>…`）
 * が書かれていないこと。
 *
 * ## 走査から外すもの（理由付き）
 *
 * - **テストファイル**（`*.test.ts` / `*.test.tsx` / `*.test.mts` / `*.test.mjs`
 *   など）。SDK が返す使用量（`turn_usage.models` 等）の key は具体の id その
 *   ものであり、fixture にはその現物が要る。**この歯が守るのは「コードが SDK
 *   へ渡すもの」であって、テストが読む入力ではない**——テストの中の具体の id
 *   は、SDK から来るデータの形を模しているだけで、alteroid が SDK へ渡す
 *   引数ではない
 * - **この検査自身**（`scripts/check-no-hardcoded-model-ids.test.ts`）。下の
 *   fixture 配列がまさに具体の id を含む文字列を持つため
 * - **Markdown / docs / `.claude/**`**。散文は id に言及してよい——この規約
 *   （エイリアスで書く）が縛るのは**コードが SDK へ渡すもの**であって、文書が
 *   例として挙げる名前ではない。⚠️ 実測（2026-09-17）では `.md` 側のヒットは
 *   0件であり、外しているのは「将来の言及を赤くしないため」である。加えて
 *   `.claude/` は別の担当（設定の新設）が同時に触っている領域であり、この歯の
 *   対象ではない
 * - **行頭が `//` / `*` / `/*` のコメント行**。理由: コメントの中の id は
 *   実行時に SDK へは届かない。**⚠️ これは同時にこの歯の穴でもある** — コメント
 *   の中に書かれた具体の id は、この歯には一切見えない（下の「この歯の
 *   弱さ」）。⚠️ **`#` は除外に含めない。** 走査するのは JS/TS だけで、そこでの
 *   行頭の `#` はコメントではなく **private フィールドの記法**である
 *   （`#model = 'claude-opus-5';`）——コメントとして飛ばすと、その1行がそのまま
 *   この歯の抜け道になる。`.mjs` の shebang（`#!/usr/bin/env node`）が誤検出に
 *   なることは無い（モデル id を含みようがない）
 *
 * ## 実測（2026-09-17、自分で数え直した）
 *
 * `git grep -nE 'claude-(opus|sonnet|haiku|fable)-[0-9]' -- .` は追跡ファイル
 * 全体で **108行**にヒットし、そのうち**非テストファイルは1件だけ**
 * （`packages/core/src/dropped-record.ts` の `//` コメント行 —
 * 「`claude-opus-5` 等」という例示）。**コメント行を外すと非テストのヒットは
 * 0件になる**——だからこの歯をそのまま「0件であること」として立てられる。
 *
 * ⚠️ **走査結果が0件でなければ、この歯の実装を止めて件数と中身を報告する
 * こと。** 勝手に除外を足して0件に合わせない——除外は上のリストで尽くして
 * ある。
 *
 * ## この歯の弱さ
 *
 * - **新しいエイリアス族は正規表現に載っていないので素通りする。** 正規表現は
 *   `opus` / `sonnet` / `haiku` / `fable` の4語で固定してあり、将来これ以外の
 *   名前（`claude-<新しい名前>-N`）が追加されても、この歯は反応しない
 * - **コメント行は見ない。** 上に書いたとおり、これは意図した除外であると
 *   同時に穴でもある——コメントに埋め込まれた具体の id は検出できない
 * - **`.md` は見ない。** ドキュメントに書かれた具体の id はこの歯の対象外
 * - **文字列の形だけを見る。** テンプレートリテラルで組み立てた id
 *   （`` `claude-${name}-5` `` のような動的生成）は、素の文字列として
 *   `claude-opus-5` 等が現れない限り検出できない
 *
 * ## 逃げ道
 *
 * 正当に直書きが要る場面が現れたら、理由付きの免除表をこの歯に足すこと。
 * いまは該当が0件なので作っていない。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** コードとして走査する拡張子。 */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** テストファイルの拡張子（`.test.` を挟む形）。走査から外す。理由は上の doc。 */
const TEST_EXTENSION_PATTERN = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** この検査自身。fixture が具体の id を含むため走査から外す。 */
const SELF_PATH = 'scripts/check-no-hardcoded-model-ids.test.ts';

/** 具体のモデル id を探す正規表現。エイリアス4語 + 数字で始まる版番号。 */
export const MODEL_ID_PATTERN = /claude-(opus|sonnet|haiku|fable)-\d/;

/**
 * コメント行かどうか（行頭が `//` / `*` / `/*`）。
 *
 * ⛔ **`#` を足さないこと。** 走査対象は JS/TS だけで、そこでの行頭の `#` は
 * コメントではなく private フィールド（`#model = 'claude-opus-5';`）である。
 * コメント扱いにすると、その記法がそのままこの歯の抜け道になる。
 */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** 1行に具体のモデル id が（コメント行を除いて）書かれているか。 */
export function hasHardcodedModelId(line: string): boolean {
  if (isCommentLine(line)) return false;
  return MODEL_ID_PATTERN.test(line);
}

/**
 * 走査対象のファイル一覧。追跡済み + 未追跡だが ignore されていないファイル
 * （`scripts/git-scannable-files-core.mjs`、Issue #1817）のうち、コード拡張子を
 * 持ち、テストファイルとこの検査自身を除いたもの。`.claude/**` と `docs/**` は
 * 拡張子フィルタでほぼ落ちるが、`.claude/skills/` 配下には `.mjs` が実在する
 * （`.claude/skills/mutation-testing/*.mjs`）ので明示的にも除く。
 *
 * **以前は `git ls-files -z`（追跡済みだけ）だった。** まだ `git add` していない
 * 新規ファイルに具体のモデル id を直書きしても、手元の `pnpm verify` は緑の
 * まま、push 後の CI で初めて赤くなる穴があった。`root` を引数で受けるのは
 * テスト用（下の `describe('scannableFiles は未追跡ファイルも対象に入れる
 * （#1817）')` が一時 git リポジトリに対して呼ぶ）。
 */
export function scannableFiles(root: string = ROOT): string[] {
  return (listGitScannableFiles({ cwd: root }) as string[])
    .filter((p) => CODE_EXTENSIONS.some((ext) => p.endsWith(ext)))
    .filter((p) => !TEST_EXTENSION_PATTERN.test(p))
    .filter((p) => p !== SELF_PATH)
    .filter((p) => !p.startsWith('.claude/'));
}

describe('scannableFiles は未追跡ファイルも対象に入れる（#1817）', () => {
  async function makeRepoWithUntrackedFile(): Promise<string> {
    const dir = await makeTempDir('check-no-hardcoded-model-ids-1817-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(path.join(dir, 'tracked.ts'), 'export const ok = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    // まだ `git add` していない新規ファイル。
    await writeFile(path.join(dir, 'new-untracked.ts'), "const m = 'claude-opus-5';\n");
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const oldForm = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.ts');
  });

  it('🟢（直した後）: scannableFiles は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const files = scannableFiles(dir);
    expect(files).toContain('new-untracked.ts');
    expect(files).toContain('tracked.ts');
  });
});

describe('具体のモデル id の直書き', () => {
  it('引っかかる書き方を全部見つける', () => {
    const broken = [
      "const MODEL = 'claude-opus-5';",
      'model: "claude-sonnet-5-20260101",',
      "if (id === 'claude-haiku-4') return true;",
      'const FABLE = `claude-fable-3`;',
      '  claude-opus-41 // 版が2桁でも当たる',
      // `#` はコメントではなく private フィールドの記法である（JS/TS）
      "  #model = 'claude-opus-5';",
    ];
    for (const line of broken) expect(hasHardcodedModelId(line), line).toBe(true);
  });

  it('引っかからない書き方は見逃す', () => {
    const fine = [
      "const MODEL_ALIAS = 'opus';",
      "const label = 'claude-opus'; // 数字が無い版はエイリアスの一部として許す",
      '// claude-opus-5 のような具体の id が SDK 側の対応表に焼かれている',
      '* claude-sonnet-5 は例として挙げているだけ',
    ];
    for (const line of fine) expect(hasHardcodedModelId(line), line).toBe(false);
  });

  it('走査対象のファイル一覧が十分な数ある（走査が壊れて0件を緑と読まない足場）', () => {
    const files = scannableFiles();
    expect(files.length).toBeGreaterThan(50);
  });

  it('既知のファイル（claude-provider.ts）が走査対象に入っている', () => {
    const files = scannableFiles();
    expect(files).toContain('packages/core/src/claude-provider.ts');
  });

  it('走査対象からテストファイルとこの検査自身が除かれている', () => {
    const files = scannableFiles();
    expect(files.some((f) => TEST_EXTENSION_PATTERN.test(f))).toBe(false);
    expect(files).not.toContain('scripts/check-no-hardcoded-model-ids.test.ts');
  });

  it('コードのどこにも具体のモデル id が直書きされていない', () => {
    const files = scannableFiles();
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
        continue; // 追跡されているが読めないもの（symlink の切れ端など）は飛ばす
      }
      if (text.includes('\0')) continue; // バイナリ
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && hasHardcodedModelId(line)) {
          hits.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      hits,
      '具体のモデル id を直書きしないこと。エイリアス（fable / opus / sonnet）で書くこと。' +
        '具体の id への対応は SDK のバンドル（sdk.mjs の aliases）が持つ。' +
        '正当に直書きが要る場面が現れたら、この歯（scripts/check-no-hardcoded-model-ids.test.ts）に' +
        '理由付きの免除表を足すこと（いまは該当が0件なので作っていない）。',
    ).toEqual([]);
  });
});
