import { describe, expect, it } from 'vitest';

import { describeUnpushedWorkObservationIncompleteness } from './unpushed-work-observation-format.js';

/**
 * `describeUnpushedWorkObservationIncompleteness` の純粋な入出力を固定する
 * （Issue #1885）。組み合わせ先（`tools.ts` / `manager.ts` / Web UI）の歯は
 * それぞれの呼び出し元のテストが持つ——ここは生成元1箇所の判定だけを見る。
 */
describe('describeUnpushedWorkObservationIncompleteness（Issue #1885）', () => {
  it('4欄とも無ければ null（古い台帳の行・確かめきれた観測の両方がここに当たる）', () => {
    expect(describeUnpushedWorkObservationIncompleteness({})).toBeNull();
  });

  it('truncatedAtCount だけあれば、件数付きで1つだけ理由を言う', () => {
    const text = describeUnpushedWorkObservationIncompleteness({ truncatedAtCount: 42 });
    expect(text).toContain('この観測は探しきっていない');
    expect(text).toContain('件数の上限（42）で打ち切った');
    expect(text).toContain('ここに無い作業ツリーが在りうる');
  });

  it('stoppedEarly だけあれば、期限切れの理由を言う', () => {
    const text = describeUnpushedWorkObservationIncompleteness({ stoppedEarly: true });
    expect(text).toContain('期限切れで一部を調べる前に打ち切った');
  });

  it('scratchRootsUnknown だけあれば、その文字列を含めて言う', () => {
    const text = describeUnpushedWorkObservationIncompleteness({
      scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった: EACCES）',
    });
    expect(text).toContain('/tmp スクラッチの起点を確かめられなかった');
    expect(text).toContain('確かめられなかった（/tmp を読めなかった: EACCES）');
  });

  it('unreadableDirCount だけあれば、件数付きで言う', () => {
    const text = describeUnpushedWorkObservationIncompleteness({ unreadableDirCount: 3 });
    expect(text).toContain('子ディレクトリの読み失敗が3件あった');
  });

  it('複数の欄が同時に載っていれば、全部を1文に並べる', () => {
    const text = describeUnpushedWorkObservationIncompleteness({
      truncatedAtCount: 10,
      stoppedEarly: true,
      scratchRootsUnknown: '理由X',
      unreadableDirCount: 2,
    });
    expect(text).toContain('件数の上限（10）で打ち切った');
    expect(text).toContain('期限切れで一部を調べる前に打ち切った');
    expect(text).toContain('理由X');
    expect(text).toContain('子ディレクトリの読み失敗が2件あった');
  });

  it('stoppedEarly が false 相当（プロパティ自体が無い）では反応しない', () => {
    // `stoppedEarly` の型は `true | undefined` なので値として `false` は
    // 来ない（`unpushedWorkResultSchema` の `z.literal(true).optional()`）が、
    // プロパティを持たないオブジェクト（undefined 相当）で反応しないことを
    // 明示的に確かめる。
    expect(describeUnpushedWorkObservationIncompleteness({ stoppedEarly: undefined })).toBeNull();
  });
});

/**
 * `unreadableDirCount` には、`job.cwd` の下の子ディレクトリの読み失敗だけで
 * なく、2本目以降の `/tmp` スクラッチ起点そのものの読み失敗も入る（#1891、
 * `findGitDirsAcrossRoots`）。文言が「子ディレクトリ」だけを名乗ると、
 * スクラッチ起点が読めなかった回を読む人が、job.cwd の下を探し直しに行く。
 */
describe('describeUnpushedWorkObservationIncompleteness — 読み失敗の件数がスクラッチ起点も含むと名乗る（#1891 の続き）', () => {
  it('unreadableDirCount があれば、スクラッチ起点そのものの読み失敗も含むと言う', () => {
    const text = describeUnpushedWorkObservationIncompleteness({ unreadableDirCount: 1 });
    expect(text).toContain('子ディレクトリの読み失敗が1件あった');
    expect(text).toContain('/tmp スクラッチの起点そのものの読み失敗を含む');
  });
});
