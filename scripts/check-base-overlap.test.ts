import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  attributeOverlapFiles,
  decideVerdict,
  extractPrNumber,
  FILES_TRUNCATION_LIMIT,
  firstLine,
  formatResult,
  IDENTITY_STATEMENT,
  intersectFiles,
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

describe('decideVerdict: 4値すべて', () => {
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
