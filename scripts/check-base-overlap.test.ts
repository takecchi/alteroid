import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  attributeOverlapFiles,
  decideVerdict,
  deriveGlobalRules,
  extractPrNumber,
  extractVitestGlobalEntries,
  FILES_TRUNCATION_LIMIT,
  firstLine,
  formatResult,
  globalHits,
  IDENTITY_STATEMENT,
  intersectFiles,
  relativeImportsOf,
} from './check-base-overlap-core.mjs';

/**
 * `check-base-overlap` の歯（Issue #838・案B）。
 *
 * **何を塞ぐか**: PR の base が古いまま、merge base 以降に main へ入った変更が
 * この PR と同じファイルを触っていても、誰も気づかない。
 *
 * **合成データだけを撃つ。** 本物の `gh api` は叩かない（`check-base-overlap.mjs`
 * が薄いラッパーで、判定は全部 `check-base-overlap-core.mjs` の純関数に切り出して
 * ある——理由は `check-required-status-checks-core.mjs` と同じ、offline とトークン
 * 権限）。
 */

function first(behindBy: number, files: string[], mergeBase = 'mergebase0000000') {
  return { behindBy, files, mergeBase };
}

function second(files: string[], commits: { sha: string; message: string }[] = []) {
  return { files, commits };
}

const CONTEXT = { repo: 'takecchi/alteroid', base: 'main', head: 'headsha0000000', pr: 842 };

describe('decideVerdict: 局所の軸（重なり）だけを撃つ', () => {
  it('first が null（読めなかった）なら unmeasurable / unreadable-head', () => {
    const result = decideVerdict({ first: null, second: null });
    expect(result.verdict).toBe('unmeasurable');
    expect(result.reason).toBe('unreadable-head');
  });

  it('behindBy === 0 なら fresh（2回目の呼び出しを要求しない設計）', () => {
    const result = decideVerdict({ first: first(0, ['a.ts']), second: undefined });
    expect(result.verdict).toBe('fresh');
    expect(result.behindBy).toBe(0);
  });

  it('behindBy > 0 で second が null（読めなかった）なら unmeasurable / unreadable-main', () => {
    const result = decideVerdict({ first: first(3, ['a.ts']), second: null });
    expect(result.verdict).toBe('unmeasurable');
    expect(result.reason).toBe('unreadable-main');
    expect(result.behindBy).toBe(3);
  });

  /**
   * ⚠ 回帰: Issue #838 の受け入れ基準そのもの。**ここを赤くしたら、この歯は
   * 「古いだけの PR」を無関係に赤くし続けて誰も rebase の意味を信じなくなる
   * ＝ 使われなくなる。** behind_by が0でなくても、ファイルが重ならなければ
   * 緑でなければならない。
   */
  it('⚠ 回帰: behind_by > 0 でも重なるファイルが無ければ no-overlap（緑）', () => {
    const result = decideVerdict({
      first: first(5, ['apps/web/app/foo.tsx']),
      second: second(['packages/core/src/bar.ts']),
    });
    expect(result.verdict).toBe('no-overlap');
    expect(result.overlap).toEqual([]);
  });

  it('重なりが在れば overlap', () => {
    const result = decideVerdict({
      first: first(2, ['packages/core/src/store.ts', 'apps/cli/src/chat.ts']),
      second: second(['packages/core/src/store.ts', 'apps/daemon/src/app.ts']),
    });
    expect(result.verdict).toBe('overlap');
    expect(result.overlap).toEqual(['packages/core/src/store.ts']);
  });

  it('重なりはソートされ、順序と重複に依存しない', () => {
    const result = decideVerdict({
      first: first(1, ['z.ts', 'a.ts', 'a.ts']),
      second: second(['a.ts', 'z.ts']),
    });
    expect(result.verdict).toBe('overlap');
    expect(result.overlap).toEqual(['a.ts', 'z.ts']);
  });
});

describe('300件打ち切り（fail closed）', () => {
  function filesOfLength(n: number, prefix = 'file') {
    return Array.from({ length: n }, (_, i) => `${prefix}-${i}.ts`);
  }

  /**
   * ⚠ 回帰: **`300` という数字そのものを固定する。** 下の2本は
   * `FILES_TRUNCATION_LIMIT` を参照して配列を組むので、**定数を書き換えると
   * テストも一緒にずれて全部通ってしまう**（変異試験で実測した——定数を 301 に
   * する変異が生存した。2026-09-12、`.claude/skills/mutation-testing` の
   * ハーネスで全件走行）。
   *
   * 300 は GitHub の compare API の**外部事実**である（2026-09-12 実測。
   * `per_page`/`page` を付けても `files` はページングされず、`page>=2` は
   * 空配列を返す）。こちら側の都合で動かしてよい数ではない。**動かすなら、
   * 実測し直した根拠と一緒にこの行を書き換えること。**
   */
  it('⚠ 回帰: FILES_TRUNCATION_LIMIT は 300（GitHub の compare API の外部事実。定数を参照するテストだけでは固定されない）', () => {
    expect(FILES_TRUNCATION_LIMIT).toBe(300);
  });

  it(`files.length === ${FILES_TRUNCATION_LIMIT} で unmeasurable / truncated になる`, () => {
    const result = decideVerdict({
      first: first(1, filesOfLength(FILES_TRUNCATION_LIMIT, 'pr')),
      second: second(filesOfLength(1, 'main')),
    });
    expect(result.verdict).toBe('unmeasurable');
    expect(result.reason).toBe('truncated');
  });

  it(`files.length === ${FILES_TRUNCATION_LIMIT - 1} では truncated にならない`, () => {
    const result = decideVerdict({
      first: first(1, filesOfLength(FILES_TRUNCATION_LIMIT - 1, 'pr')),
      second: second(filesOfLength(1, 'main')),
    });
    expect(result.verdict).toBe('no-overlap');
    expect(result.truncated).toBe(false);
  });

  it('main 側（second.files）が打ち切られていても unmeasurable / truncated になる', () => {
    const result = decideVerdict({
      first: first(1, filesOfLength(1, 'pr')),
      second: second(filesOfLength(FILES_TRUNCATION_LIMIT, 'main')),
    });
    expect(result.verdict).toBe('unmeasurable');
    expect(result.reason).toBe('truncated');
  });

  /**
   * 判定の順番は「重なり → 打ち切り」。重なりが見つかっているなら、打ち切って
   * いても答えは overlap のまま（より具体的な赤にできるため）。
   */
  it('重なりが見つかっていれば、打ち切りが在っても verdict は overlap のまま（truncated フラグは立つ）', () => {
    const prFiles = [...filesOfLength(FILES_TRUNCATION_LIMIT - 1, 'pr'), 'shared.ts'];
    const result = decideVerdict({
      first: first(1, prFiles),
      second: second(['shared.ts']),
    });
    expect(result.verdict).toBe('overlap');
    expect(result.overlap).toEqual(['shared.ts']);
    expect(result.truncated).toBe(true);
  });
});

describe('extractPrNumber: squash-merge のコミットメッセージから PR 番号を拾う', () => {
  it('ふつうの squash-merge の1行目から拾える', () => {
    expect(extractPrNumber('feat: 何か (#123)')).toBe(123);
  });

  /**
   * ⚠ 回帰: 本物のコミットメッセージ（main の実コミット。917a060）から取った
   * 断片。**全角括弧の issue 参照（`（#832 #833）`）に釣られず、行末の半角括弧
   * だけを PR 番号として拾うこと。**
   */
  it('⚠ 回帰: 全角括弧の issue 参照に釣られず、行末の半角括弧だけを拾う', () => {
    const message = 'fix: 鍵が通るのに誰も動かない2つの穴を塞ぐ（#832 #833） (#834)';
    expect(extractPrNumber(message)).toBe(834);
  });

  it('複数行のメッセージでも1行目しか見ない', () => {
    const message = 'fix: title (#1)\n\n本文中の (#2) は無視する';
    expect(extractPrNumber(message)).toBe(1);
  });

  it('半角括弧の PR 番号が無ければ null（0 にしない）', () => {
    expect(extractPrNumber('chore: バージョン更新（#999）')).toBeNull();
    expect(extractPrNumber('chore: バージョン更新')).toBeNull();
  });

  it('firstLine は改行の手前までを返す', () => {
    expect(firstLine('a\nb\nc')).toBe('a');
    expect(firstLine('a')).toBe('a');
  });
});

describe('intersectFiles', () => {
  it('積をソートして返す（順序・重複に依存しない）', () => {
    expect(intersectFiles(['b', 'a', 'a'], ['a', 'c'])).toEqual(['a']);
  });

  it('重ならなければ空配列', () => {
    expect(intersectFiles(['a'], ['b'])).toEqual([]);
  });
});

describe('attributeOverlapFiles: 帰属', () => {
  it('ファイルを触ったコミットの sha・PR番号・1行目を結び付ける', () => {
    const result = attributeOverlapFiles(
      ['packages/core/src/store.ts'],
      [
        {
          sha: '917a060abcdef1234567890',
          message: 'fix: 鍵が通るのに誰も動かない2つの穴を塞ぐ（#832 #833） (#834)',
          files: ['packages/core/src/store.ts', 'other.ts'],
        },
      ],
    );
    expect(result).toEqual([
      {
        path: 'packages/core/src/store.ts',
        attributed: true,
        sha: '917a060',
        prNumber: 834,
        titleLine: 'fix: 鍵が通るのに誰も動かない2つの穴を塞ぐ（#832 #833） (#834)',
      },
    ]);
  });

  /**
   * `commits` が250件で切れて、overlap したファイルの持ち主が候補の中に
   * 見つからないことがある。**このとき黙って消さず、`attributed: false` を
   * 明示する。**
   */
  it('候補のどのコミットにも見つからなければ attributed: false', () => {
    const result = attributeOverlapFiles(
      ['unseen.ts'],
      [{ sha: 'abc0000', message: 'fix: 別件 (#1)', files: ['other.ts'] }],
    );
    expect(result).toEqual([
      { path: 'unseen.ts', attributed: false, sha: null, prNumber: null, titleLine: null },
    ]);
  });

  it('最初に一致したコミット（＝呼び出し側が渡した順で先頭）を採る', () => {
    const result = attributeOverlapFiles(
      ['shared.ts'],
      [
        { sha: 'newer00', message: 'feat: 新しい方 (#2)', files: ['shared.ts'] },
        { sha: 'older00', message: 'feat: 古い方 (#1)', files: ['shared.ts'] },
      ],
    );
    expect(result[0].sha).toBe('newer00');
    expect(result[0].prNumber).toBe(2);
  });
});

describe('formatResult: fresh / no-overlap は必ず1行出す', () => {
  it('fresh は behind_by=0 と PR番号を含む', () => {
    const result = decideVerdict({ first: first(0, []), second: undefined });
    const text = formatResult(result, CONTEXT, null);
    expect(text).toContain('behind_by=0');
    expect(text).toContain('#842');
    expect(text).toContain('OK');
  });

  /**
   * 出力が無いと「走らなかった」と「重ならなかった」が区別できない
   * （`AGENTS.md`「静かに失敗する道具」）。**no-overlap でも必ず1行出す。**
   */
  it('no-overlap は behind_by の値を含み、かつ何か出力する', () => {
    const result = decideVerdict({
      first: first(4, ['a.ts']),
      second: second(['b.ts']),
    });
    const text = formatResult(result, CONTEXT, null);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('behind_by=4');
    expect(text).toContain('OK');
  });
});

describe('formatResult: overlap のメッセージ要件', () => {
  const result = decideVerdict({
    first: first(3, [
      'packages/core/src/store.ts',
      'apps/cli/src/chat.ts',
      'apps/daemon/src/app.ts',
    ]),
    second: second([
      'packages/core/src/store.ts',
      'apps/cli/src/chat.ts',
      'apps/daemon/src/app.ts',
      'unrelated.ts',
    ]),
  });

  const attributions = attributeOverlapFiles(result.overlap, [
    {
      sha: 'aaa1111bbbb',
      message: 'feat: 新しいコミット (#900)',
      files: ['packages/core/src/store.ts'],
    },
    {
      sha: 'bbb2222cccc',
      message: 'fix: もう1つのコミット（#111 #222） (#901)',
      files: ['apps/cli/src/chat.ts'],
    },
    // apps/daemon/src/app.ts はどの候補コミットにも入れず、帰属不明にする
  ]);

  const text = formatResult(result, CONTEXT, attributions);

  it('verdict が overlap である（この describe の前提）', () => {
    expect(result.verdict).toBe('overlap');
  });

  it('重なったファイル名が1つも欠けずに全部出る', () => {
    for (const path of result.overlap) {
      expect(text).toContain(path);
    }
  });

  it('sha と PR 番号が出る', () => {
    expect(text).toContain('aaa1111');
    expect(text).toContain('#900');
    expect(text).toContain('bbb2222');
    expect(text).toContain('#901');
  });

  it('帰属が付かないファイルは (帰属不明) と明示される', () => {
    expect(text).toContain('apps/daemon/src/app.ts');
    expect(text).toContain('(帰属不明)');
  });

  it('behind_by の値が出る', () => {
    expect(text).toContain('behind_by=3');
  });

  it('何をすればいいか（rebase して取り直す）が書いてある', () => {
    expect(text).toContain('rebase');
    expect(text).toContain(CONTEXT.base);
  });

  /**
   * ⭐ この歯の名乗り: 「気付くための歯であって、不可能にするための歯ではない」。
   * `main` は strict=false なので、この判定の後にも main は進みうる。
   */
  it('名乗りの一文（不可能にするための歯ではない）が含まれる', () => {
    expect(text).toContain('気付くための歯');
    expect(text).toContain('不可能にするための歯ではない');
    expect(text).toContain(IDENTITY_STATEMENT);
  });
});

describe('formatResult: unmeasurable', () => {
  it('truncated の理由と、緑に丸めない旨と、逃げ道のコマンドが書いてある', () => {
    const files300 = Array.from({ length: FILES_TRUNCATION_LIMIT }, (_, i) => `f${i}.ts`);
    const result = decideVerdict({ first: first(1, files300), second: second(['m.ts']) });
    const text = formatResult(result, CONTEXT, null);
    expect(text).toContain('測れていない');
    expect(text).toContain(String(FILES_TRUNCATION_LIMIT));
    expect(text).toContain('vnd.github.v3.diff');
    // ちょうど300件と区別できないという言えないことも書いてある
    expect(text).toContain('区別できない');
  });

  it('unreadable-head / unreadable-main はそれぞれ「読めていない」旨を出す', () => {
    const headUnreadable = decideVerdict({ first: null, second: null });
    const textHead = formatResult(headUnreadable, CONTEXT, null);
    expect(textHead).toContain('読めていない');

    const mainUnreadable = decideVerdict({ first: first(2, ['a.ts']), second: null });
    const textMain = formatResult(mainUnreadable, CONTEXT, null);
    expect(textMain).toContain('読めていない');
  });
});

/**
 * ## 2本目の軸: 「大域に効くファイル」（#839 の実測から）
 *
 * **合成データだけを撃つ**のは上と同じ。`facts`（現物を読んだ結果）はラッパが
 * 作るので、ここでは**この repo の現物を写した `facts`** を手で置いて、core の
 * 純関数だけを撃つ。
 */

/**
 * この repo の実際の `vitest.config.ts` の抜粋（`setupFiles: ['./vitest.setup.ts'],`）。
 * **コメントの中にも `setupFiles` の語が在る**形をそのまま残してある——キーとしての
 * 出現（直後が `:`）だけを読むことを、現物の形で固定するため。
 */
const REAL_VITEST_CONFIG_EXCERPT = [
  "import { defineConfig } from 'vitest/config';",
  '',
  'export default defineConfig({',
  '  test: {',
  '    /**',
  '     * **テストが本物の stdout へ書いたら落とす歯**（#314）。中身と理由は',
  '     * `vitest.setup.ts` に在る。ここに `setupFiles` を置くのはこれが最初で、',
  '     * 置き場所は根の vitest 設定しか無い。',
  '     */',
  "    setupFiles: ['./vitest.setup.ts'],",
  '    include: [',
  "      'packages/*/src/**/*.test.ts',",
  "      'scripts/**/*.test.ts',",
  '    ],',
  '  },',
  '});',
].join('\n');

/** この repo の現物を写した `facts`（ラッパが `readdirSync` などで作るもの）。 */
const FACTS = {
  rootEntries: [
    '.prettierignore',
    '.prettierrc.json',
    'AGENTS.md',
    'README.md',
    'eslint.config.js',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'vitest.config.ts',
    'vitest.setup.ts',
  ],
  vitestConfigPath: 'vitest.config.ts',
  vitestConfigSource: REAL_VITEST_CONFIG_EXCERPT,
  rootPackageJson: { scripts: { test: 'node ./scripts/test.mjs' } },
  testEntryClosure: ['scripts/test-guard-core.mjs', 'scripts/test.mjs'],
  workflowFiles: ['.github/workflows/ci.yml', '.github/workflows/release-prod.yml'],
};

const GLOBAL = deriveGlobalRules(FACTS);

/** verdict と「赤か緑か」の対応を1か所に置く（`check-base-overlap.mjs` の終了コード表と同じ）。 */
const RED_VERDICTS = new Set(['overlap', 'global-change', 'unmeasurable']);

describe('extractVitestGlobalEntries: setupFiles / globalSetup の文字列リテラル', () => {
  it('この repo の実際の vitest.config.ts の抜粋から ./vitest.setup.ts を抜ける', () => {
    const result = extractVitestGlobalEntries(REAL_VITEST_CONFIG_EXCERPT);
    expect(result.mentioned).toBe(true);
    // 先頭の `./` は落として、compare API の返す repo 相対パスと突き合わせられる形にする
    expect(result.entries).toEqual(['vitest.setup.ts']);
  });

  it("単一文字列形（setupFiles: './a.ts'）も受ける", () => {
    const result = extractVitestGlobalEntries("export default { test: { setupFiles: './a.ts' } };");
    expect(result.entries).toEqual(['a.ts']);
  });

  it('globalSetup も同じく抜ける（配列形・複数）', () => {
    const result = extractVitestGlobalEntries(
      "export default { test: { globalSetup: ['./g1.ts', './g2.ts'] } };",
    );
    expect(result.entries).toEqual(['g1.ts', 'g2.ts']);
  });

  /**
   * ⭐ **「語は在るのに1つも抜けなかった」を「無い」と区別できること。**
   * ここが1値（`entries` だけ）だと、読めなかったソースが静かに
   * 「大域ファイルは無い」＝緑に化ける。
   */
  it('setupFiles が変数で書かれていたら mentioned: true / entries: []（「無い」と区別する）', () => {
    const result = extractVitestGlobalEntries('export default { test: { setupFiles: SETUP } };');
    expect(result.mentioned).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('語がそもそも無ければ mentioned: false', () => {
    const result = extractVitestGlobalEntries('export default { test: { include: [] } };');
    expect(result.mentioned).toBe(false);
    expect(result.entries).toEqual([]);
  });
});

describe('relativeImportsOf: 相対指定子だけを抜く', () => {
  it("from './test-guard-core.mjs' を抜ける", () => {
    const source = [
      "import { spawn } from 'node:child_process';",
      "import { ROOT, judgeExecution } from './test-guard-core.mjs';",
    ].join('\n');
    expect(relativeImportsOf(source)).toEqual(['./test-guard-core.mjs']);
  });

  it('../ と動的 import() も抜ける。パッケージ名は抜かない', () => {
    const source = [
      "import a from '../lib/a.mjs';",
      "const b = await import('./b.mjs');",
      "import 'node:fs';",
      "import c from 'vitest/config';",
    ].join('\n');
    expect(relativeImportsOf(source)).toEqual(['../lib/a.mjs', './b.mjs']);
  });
});

describe('deriveGlobalRules: 一覧をハードコードせず、facts から導く', () => {
  it('undecidable にならない（現物どおりの facts なら導出は成立する）', () => {
    expect(GLOBAL.undecidable).toBeNull();
    expect(GLOBAL.rules.length).toBeGreaterThan(0);
  });

  it('どの規則も why（なぜ大域か）を持つ', () => {
    for (const rule of GLOBAL.rules) {
      expect(typeof rule.why).toBe('string');
      expect(rule.why.length).toBeGreaterThan(0);
    }
  });

  /** 現物から導く形であること ＝ facts を足したら規則も増える（名前を決め打ちしていない）。 */
  it('rootEntries に無い名前は規則に入らない（決め打ちの一覧ではない）', () => {
    const withoutPrettier = deriveGlobalRules({
      ...FACTS,
      rootEntries: FACTS.rootEntries.filter((name) => !name.startsWith('.prettier')),
    });
    const paths = withoutPrettier.rules.flatMap((rule: { paths: string[] }) => rule.paths);
    expect(paths).not.toContain('.prettierrc.json');
    expect(paths).toContain('tsconfig.base.json');
  });

  it('新しいワークフローを足したら、それも自動で大域に入る', () => {
    const derived = deriveGlobalRules({
      ...FACTS,
      workflowFiles: [...FACTS.workflowFiles, '.github/workflows/brand-new.yml'],
    });
    expect(globalHits(['.github/workflows/brand-new.yml'], derived.rules)).toHaveLength(1);
  });

  it('根に vitest 設定が無ければ undecidable（黙って軸を1本失わない）', () => {
    const derived = deriveGlobalRules({
      ...FACTS,
      vitestConfigPath: null,
      vitestConfigSource: null,
    });
    expect(derived.undecidable).not.toBeNull();
    expect(derived.rules).toEqual([]);
  });

  it('setupFiles が読めなければ undecidable（「無い」に丸めない）', () => {
    const derived = deriveGlobalRules({
      ...FACTS,
      vitestConfigSource: 'export default { test: { setupFiles: SETUP } };',
    });
    expect(derived.undecidable).not.toBeNull();
  });
});

describe('globalHits: 当たったファイルと why', () => {
  it('setupFiles に載っているファイルが当たり、why に理由が入る', () => {
    const hits = globalHits(['vitest.setup.ts'], GLOBAL.rules);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('vitest.setup.ts');
    expect(hits[0].why).toContain('setupFiles');
  });

  it('大域でないファイルは当たらない', () => {
    expect(globalHits(['apps/web/app/routes/reports.tsx'], GLOBAL.rules)).toEqual([]);
  });

  /**
   * ⭐ **`scripts/*` を丸ごと大域にはしない。** 大域なのは `scripts.test` が指す
   * プログラムの閉包だけ——「`pnpm test` が緑か赤かを決めるもの」だからである。
   * `check-web-bundle-size.mjs` が壊れても壊れるのはその検査1本で、全テストの
   * 判定は動かない ⟹ 大域ではない。
   */
  it('規則7: scripts.test の閉包は大域、scripts/check-web-bundle-size.mjs は大域ではない', () => {
    const hits = globalHits(
      ['scripts/test-guard-core.mjs', 'scripts/check-web-bundle-size.mjs'],
      GLOBAL.rules,
    );
    expect(hits.map((hit: { path: string }) => hit.path)).toEqual(['scripts/test-guard-core.mjs']);
    expect(hits[0].why).toContain('pnpm test');
  });

  it('当たったファイルは1つも欠けず、パスでソートされる', () => {
    const hits = globalHits(
      ['vitest.setup.ts', '.github/workflows/ci.yml', 'package.json'],
      GLOBAL.rules,
    );
    expect(hits.map((hit: { path: string }) => hit.path)).toEqual([
      '.github/workflows/ci.yml',
      'package.json',
      'vitest.setup.ts',
    ]);
  });
});

/**
 * ⭐ **判定の表をそのまま歯で固定する**（表駆動）。4行のどれか1行でも向きが
 * 変わったら落ちる。とくに最後の行を赤にしたら、この歯は「古いだけの PR」を
 * 無関係に赤くし続けて使われなくなる。
 */
describe('判定の表（局所の重なり × 大域）', () => {
  const TABLE = [
    {
      name: 'behind>0 / 重なり0 / PR が大域ファイルを触る → global-change（赤）',
      behindBy: 4,
      prFiles: ['vitest.setup.ts', 'apps/web/app/routes/reports.tsx'],
      mainFiles: ['packages/core/src/store.ts'],
      expected: 'global-change',
    },
    {
      name: 'behind>0 / 重なり1以上 → overlap（赤）',
      behindBy: 4,
      prFiles: ['packages/core/src/store.ts'],
      mainFiles: ['packages/core/src/store.ts'],
      expected: 'overlap',
    },
    {
      name: 'behind=0 / 大域ファイルを触る → fresh（緑。追いついているなら問題ない）',
      behindBy: 0,
      prFiles: ['vitest.setup.ts'],
      mainFiles: [],
      expected: 'fresh',
    },
    {
      name: 'behind>0 / 重なり0 / 大域ファイルを触らない → no-overlap（緑）',
      behindBy: 3,
      prFiles: ['apps/web/app/routes/reports.tsx'],
      mainFiles: ['packages/core/src/store.ts'],
      expected: 'no-overlap',
    },
  ];

  it.each(TABLE)('$name', ({ behindBy, prFiles, mainFiles, expected }) => {
    const result = decideVerdict({
      first: first(behindBy, prFiles),
      second: behindBy === 0 ? undefined : second(mainFiles),
      global: GLOBAL,
    });
    expect(result.verdict).toBe(expected);
    expect(RED_VERDICTS.has(result.verdict)).toBe(
      expected === 'global-change' || expected === 'overlap',
    );
  });
});

describe('global-change: #839 の形', () => {
  /**
   * ⚠ 回帰: **#839 の実測をそのまま置く。** `behind_by=4` / main 側47ファイル /
   * PR 側2ファイル / **重なり0**。当時この歯は `no-overlap`（緑）を出し、門は
   * 全部緑だった。**PR が触った `vitest.setup.ts` は根の vitest 設定の
   * `setupFiles` に載っていて、そこへ足された `afterEach` と、main 側47ファイル
   * ぶんの新しいテストは一度も一緒に走っていなかった。**
   */
  const mainFiles47 = Array.from({ length: 47 }, (_, i) => `packages/core/src/unrelated-${i}.ts`);
  const result = decideVerdict({
    first: first(4, ['vitest.setup.ts', 'packages/core/src/journal-store.ts']),
    second: second(mainFiles47),
    global: GLOBAL,
  });

  it('⚠ 回帰: #839 — behind=4 / 重なり0 / vitest.setup.ts を触る → global-change（赤）', () => {
    expect(result.overlap).toEqual([]);
    expect(result.verdict).toBe('global-change');
    expect(RED_VERDICTS.has(result.verdict)).toBe(true);
  });

  it('⚠ 回帰: #839 — 当たった大域ファイルが globalHits に入る', () => {
    expect(result.globalHits.map((hit: { path: string }) => hit.path)).toEqual(['vitest.setup.ts']);
  });

  const text = formatResult(result, CONTEXT, null);

  it('当たった大域ファイルが1つも欠けずに出る', () => {
    for (const hit of result.globalHits) {
      expect(text).toContain(hit.path);
    }
  });

  it('各ファイルについて why（なぜ大域なのか）が名指しで出る', () => {
    expect(text).toContain('なぜ大域か');
    expect(text).toContain('setupFiles');
    expect(text).toContain(result.globalHits[0].why);
  });

  it('behind_by の値が出る', () => {
    expect(text).toContain('behind_by=4');
  });

  it('なぜ重なりが0でも赤いのかが書いてある（#839 の形）', () => {
    expect(text).toContain('重なっていない');
    expect(text).toContain('#839');
    expect(text).toContain('一緒に走った回が一度も無い');
  });

  it('何をすればいいか（rebase して取り直す）が書いてある', () => {
    expect(text).toContain('rebase');
    expect(text).toContain(CONTEXT.base);
  });

  it('名乗りの一文（不可能にするための歯ではない）が含まれる', () => {
    expect(text).toContain(IDENTITY_STATEMENT);
  });
});

describe('overlap のときに大域も当たっていたら、両方の節を出す', () => {
  const result = decideVerdict({
    first: first(2, ['packages/core/src/store.ts', 'vitest.setup.ts']),
    second: second(['packages/core/src/store.ts']),
    global: GLOBAL,
  });
  const text = formatResult(result, CONTEXT, null);

  it('verdict は overlap（局所が優先。ただし大域も持ち回る）', () => {
    expect(result.verdict).toBe('overlap');
    expect(result.globalHits.map((hit: { path: string }) => hit.path)).toEqual(['vitest.setup.ts']);
  });

  it('局所の節（重なったファイル）と大域の節の両方が出る（黙って落とさない）', () => {
    expect(text).toContain('packages/core/src/store.ts');
    expect(text).toContain('【重なったファイル】');
    expect(text).toContain('vitest.setup.ts');
    expect(text).toContain('なぜ大域か');
  });

  /**
   * ⚠ 回帰: **重なりが在る出力に「ファイルは1つも重なっていない」と書かない。**
   * global-change 側の説明文をそのまま使い回すと、この1行だけが嘘になり、
   * 読む人はそこで道具を信じなくなる（実地確認で踏んだ。2026-09-12、既に main へ
   * 入った #839 の head を今の main に当てると `overlap` になり、この文が出ていた）。
   */
  it('⚠ 回帰: 重なりが在るのに「1つも重なっていない」と書かない', () => {
    expect(text).not.toContain('ファイルは1つも重なっていない');
    expect(text).toContain('重なったファイルとは別に');
  });
});

describe('大域規則が導出できなければ unmeasurable（fail closed）', () => {
  /**
   * ⭐ `setupFiles: SETUP,` は「大域ファイルが無い」ではなく「**読めなかった**」。
   * 300件打ち切りと同じ理由で赤に倒す。
   */
  it('setupFiles が在るのに抜けない書き方 → unmeasurable / global-rules-underivable', () => {
    const derived = deriveGlobalRules({
      ...FACTS,
      vitestConfigSource: 'export default { test: { setupFiles: SETUP } };',
    });
    const result = decideVerdict({
      first: first(3, ['apps/web/app/routes/reports.tsx']),
      second: second(['packages/core/src/store.ts']),
      global: derived,
    });
    expect(result.verdict).toBe('unmeasurable');
    expect(result.reason).toBe('global-rules-underivable');

    const text = formatResult(result, CONTEXT, null);
    expect(text).toContain('導出できていない');
    expect(text).toContain('評価しているのではない');
  });

  it('局所の重なりが在れば、大域が導出できなくても overlap のまま（より具体的な赤）', () => {
    const derived = deriveGlobalRules({
      ...FACTS,
      vitestConfigPath: null,
      vitestConfigSource: null,
    });
    const result = decideVerdict({
      first: first(3, ['packages/core/src/store.ts']),
      second: second(['packages/core/src/store.ts']),
      global: derived,
    });
    expect(result.verdict).toBe('overlap');
  });

  /**
   * ⚠ 大域は**打ち切りより先**に見る（大域が当たっているなら、「測れなかった」より
   * 具体的な赤が出せる）。
   */
  it('打ち切りが在っても、大域が当たっていれば global-change（truncated フラグは立つ）', () => {
    const prFiles = [
      ...Array.from({ length: FILES_TRUNCATION_LIMIT - 1 }, (_, i) => `pr-${i}.ts`),
      'vitest.setup.ts',
    ];
    const result = decideVerdict({
      first: first(1, prFiles),
      second: second(['main-0.ts']),
      global: GLOBAL,
    });
    expect(result.verdict).toBe('global-change');
    expect(result.truncated).toBe(true);
  });
});

/**
 * **配線の歯。** `decideVerdict` は `global` を渡されなければ大域の軸を持たない
 * 判定になる（合成データで局所だけを撃つテストのための既定）。⟹ ラッパが
 * 渡し忘れると、**軸が1本、黙って消える。** そこだけは現物のソースで固定する
 * （`check-scripts-wired.test.ts` と同じ形の、配線だけを見る歯）。
 */
describe('配線: ラッパが大域規則を組み立てて decideVerdict へ渡している', () => {
  const WRAPPER_SOURCE = readFileSync(
    path.join(fileURLToPath(new URL('.', import.meta.url)), 'check-base-overlap.mjs'),
    'utf8',
  );

  it('buildGlobalRules の結果を decideVerdict へ渡している', () => {
    expect(WRAPPER_SOURCE).toContain('buildGlobalRules(repoRoot)');
    expect(WRAPPER_SOURCE).toContain('decideVerdict({ first, second, global: globalRules })');
  });

  it('--repo-root で読む先を切り替えられる', () => {
    expect(WRAPPER_SOURCE).toContain("args['repo-root']");
  });
});
