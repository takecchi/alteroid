import { describe, expect, it } from 'vitest';

import {
  evaluatePrLineNumberCitations,
  findPathLineNumberCitations,
  formatVerdict,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-line-number-citations-core.mjs';

/**
 * `check-pr-line-number-citations` の歯（Issue #1192 の N3 に対応する）。
 *
 * 本物の `gh pr view` は叩かない —— 合成した PR 本文と、注入した `isRepoFile`
 * （実ファイルシステムを読まない同期関数）だけで判定を確かめる
 * （`check-pr-closing-keywords.test.ts` / `check-pr-vanished-footprint.test.ts`
 * と同じ理由）。
 *
 * **この歯は fixture として `path:行番号` の形の逐語を持つ。** それ自体が対象に
 * なってはいけない——この門は repo のファイルを走査せず、この PR の本文だけを
 * 読む（`check-pr-line-number-citations-core.mjs` の doc、#785 の族）ので、この
 * 歯の中身が門自身に引っかかることは無い。
 *
 * ⚠️ **ただし別の既存の門（`scripts/agents-md-references.test.ts`）は `scripts/**`
 * の中身を実際に走査し、実在するリポジトリのファイルを `path:行番号` で指す
 * 逐語をそこでも咎める。** だから下の fixture は、実在ファイルを使う必然性が
 * 無いものは架空のパス（`scripts/example.mjs` / `NOTES.md` など、このリポジトリに
 * 実在しない）に倒し、実在ファイル（`scripts/test.mjs` / `AGENTS.md` 由来の
 * 実例）を使う理由がある2本（PR #1205 / PR #1001 の逐語の再現）はテンプレート
 * リテラルで組み立てて `path:行番号` が地の文に連続して現れないようにしてある
 * （実行時の文字列の値は変えていない）。
 */

/** テスト用の `isRepoFile`。実 FS を読まない——固定集合への完全一致だけ。 */
function fakeIsRepoFile(existing: readonly string[]) {
  const set = new Set(existing);
  return (candidate: string) => set.has(candidate);
}

describe('findPathLineNumberCitations — 弾く形（フェンス）', () => {
  // fixture のパスは架空（`scripts/example.mjs`。このリポジトリに実在しない）——
  // フェンス除外の判定自体は実在ファイルかどうかに依存しないので、実在ファイルを
  // 使う必然性が無い（上の doc comment を見よ）。
  it('フェンス（```）の中の path:行番号 は見ない', () => {
    const body = [
      '説明の地の文。',
      '```',
      'scripts/example.mjs:42 が原因だった',
      '```',
      '続きの地の文。',
    ].join('\n');
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['scripts/example.mjs']));
    expect(result).toEqual([]);
  });

  it('閉じていないフェンス（unterminated）は末尾まで生の出力として扱う（fail-closed）', () => {
    const body = ['```', 'scripts/example.mjs:42 が原因だった'].join('\n');
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['scripts/example.mjs']));
    expect(result).toEqual([]);
  });

  it('フェンスの外にある同じ形は検出する（フェンス除外が効きすぎていないことの対の歯）', () => {
    const body = ['```', '無関係な出力', '```', 'scripts/example.mjs:42 が原因だった'].join('\n');
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['scripts/example.mjs']));
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('scripts/example.mjs');
  });
});

describe('findPathLineNumberCitations — 弾かない形（インラインのコードスパン。実測に基づく決定）', () => {
  it('バッククォート1つで囲んだ path:行番号 も検出する（除外しない）', () => {
    // 実測（2026-09-19、直近マージ済み PR 200本）の再現: PR #1205 の逐語
    // 「scripts/test.mjs の118行目（本番経路）とこのテストだけである」と同じ形。
    // ⚠️ `file` と `line` を分けてテンプレートリテラルで組み立てる——地の文に
    // `path:行番号` を連続して書くと、この歯自身が `scripts/agents-md-references.test.ts`
    // の出典検査に引っかかる（上の doc comment）。実行時の `body` の値は
    // 分けずに書いた場合と同じである。
    const file = 'scripts/test.mjs';
    const line = '118';
    const body = `\`runObservationGuard\` を \`today\` 無しで呼ぶのは \`${file}:${line}\`（本番経路）とこのテストだけである。`;
    const result = findPathLineNumberCitations(body, fakeIsRepoFile([file]));
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe(file);
    expect(result[0].token).toBe(`${file}:${line}`);
  });

  it('カンマ区切りの複数行番号（PR #1001 の逐語の形）も検出する', () => {
    // 上と同じ理由でテンプレートリテラルで組み立てる。
    const file = 'packages/core/src/runner-token-rotation.test.ts';
    const body = `### 2〜5. \`${file}:28,61,63,185\`（同一原因、4箇所）`;
    const result = findPathLineNumberCitations(body, fakeIsRepoFile([file]));
    expect(result).toHaveLength(1);
    expect(result[0].token).toBe(`${file}:28`);
  });
});

describe('findPathLineNumberCitations — 弾く形（実在しないファイル。時刻・ポート番号などの偽陽性対策）', () => {
  it('isRepoFile が false を返すトークンは検出しない（時刻の形の再現）', () => {
    const body = '観測は 2026-09-17T11:54:42Z、CI は 15:04:46Z に完了した。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile([]));
    expect(result).toEqual([]);
  });

  it('host:port の形も isRepoFile が false なら検出しない', () => {
    const body = '接続先は http://host:8080 である。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile([]));
    expect(result).toEqual([]);
  });

  it('GitHub の blob URL（#L12 形式）はそもそも正規表現に一致しない（コロンではなくハッシュ）', () => {
    const body =
      '出典は https://github.com/takecchi/alteroid/blob/main/scripts/foo.mjs#L12 である。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['scripts/foo.mjs']));
    expect(result).toEqual([]);
  });

  it('node_modules 相当の外部依存（repo に実在しないパス）は検出しない（AGENTS.md の版固定の例外と整合）', () => {
    const body = '`dist/esm/server/zod-compat.js:141` を確認した。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile([]));
    expect(result).toEqual([]);
  });
});

describe('findPathLineNumberCitations — 弾く形（grep -n / grep -Fn の生出力）', () => {
  it('マッチ直後がコロン（path:行番号:内容 の3項形式）なら証拠として弾く', () => {
    const body = 'scripts/foo.mjs:42:  const x = 1;';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['scripts/foo.mjs']));
    expect(result).toEqual([]);
  });

  it('直後がコロンでなければ同じ path:行番号 は検出する（対の歯）', () => {
    const body = 'scripts/foo.mjs:42 を直した。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['scripts/foo.mjs']));
    expect(result).toHaveLength(1);
  });
});

describe('findPathLineNumberCitations — 検出する形', () => {
  // fixture のパスは架空（`NOTES.md` / `scripts/foo.mjs`。このリポジトリに実在
  // しない）——検出そのものは実在ファイルかどうかに依存しないので、実在ファイル
  // を使う必然性が無い（上の doc comment を見よ）。
  it('範囲形式（path:12-34）を検出し、token には範囲全体が入る', () => {
    const body = '該当は `NOTES.md:499-508` である。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile(['NOTES.md']));
    expect(result).toHaveLength(1);
    expect(result[0].token).toBe('NOTES.md:499-508');
    expect(result[0].target).toBe('NOTES.md');
  });

  it('1本の本文に複数の出典があれば複数返す', () => {
    const body = ['NOTES.md:10 と', 'scripts/foo.mjs:20 の両方が原因である。'].join('\n');
    const result = findPathLineNumberCitations(
      body,
      fakeIsRepoFile(['NOTES.md', 'scripts/foo.mjs']),
    );
    expect(result).toHaveLength(2);
    expect(result[0].line).toBe(1);
    expect(result[1].line).toBe(2);
  });

  it('..を含む候補はリポジトリ外として扱われる（isRepoFile 側の責務。ここでは注入した関数が false を返す想定）', () => {
    const body = '`../secret/file.ts:1` を見よ。';
    const result = findPathLineNumberCitations(body, fakeIsRepoFile([]));
    expect(result).toEqual([]);
  });
});

describe('evaluatePrLineNumberCitations', () => {
  it('body が null なら unreadable（fail-closed）', () => {
    const result = evaluatePrLineNumberCitations({ body: null }, { isRepoFile: () => false });
    expect(result.verdict).toBe('unreadable');
    expect(result.findings).toEqual([]);
  });

  it('body が空文字は「読めた」結果であり ok（unreadable にしない）', () => {
    const result = evaluatePrLineNumberCitations({ body: '' }, { isRepoFile: () => true });
    expect(result.verdict).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('出典が無ければ ok', () => {
    const result = evaluatePrLineNumberCitations(
      { body: "出典は `grep -Fn -- 'foo' AGENTS.md` の形で書いた。" },
      { isRepoFile: () => true },
    );
    expect(result.verdict).toBe('ok');
  });

  it('出典が在れば found', () => {
    // fixture のパスは架空（`NOTES.md`。実在するかどうかは注入した isRepoFile
    // 側の責務で、この歯では確かめない）。
    const result = evaluatePrLineNumberCitations(
      { body: '`NOTES.md:499` を見よ。' },
      { isRepoFile: (c: string) => c === 'NOTES.md' },
    );
    expect(result.verdict).toBe('found');
    expect(result.findings).toHaveLength(1);
  });
});

describe('formatVerdict', () => {
  it('ok は次の一手を出さない', () => {
    const text = formatVerdict('1', { verdict: 'ok', findings: [] });
    expect(text).toContain('OK');
    expect(text).not.toContain('次の一手');
  });

  it('found は見つかった箇所と次の一手を出す', () => {
    // fixture のパスは架空（`NOTES.md`。formatVerdict は文字列の整形しか
    // 見ないので、実在ファイルを使う必然性が無い）。
    const text = formatVerdict('1', {
      verdict: 'found',
      findings: [
        {
          line: 3,
          token: 'NOTES.md:499',
          target: 'NOTES.md',
          context: '`NOTES.md:499` を見よ。',
        },
      ],
    });
    expect(text).toContain('NG');
    expect(text).toContain('required ではない');
    expect(text).toContain('行3');
    expect(text).toContain('NOTES.md:499');
    expect(text).toContain('次の一手');
  });

  it('unreadable は fail-closed であることを名乗る', () => {
    const text = formatVerdict('1', { verdict: 'unreadable', findings: [] });
    expect(text).toContain('判定できなかった');
    expect(text).toContain('fail-closed');
  });

  it('未知の verdict は素通りさせない', () => {
    const text = formatVerdict('1', { verdict: 'weird', findings: [] } as never);
    expect(text).toContain('未知の verdict');
  });
});
