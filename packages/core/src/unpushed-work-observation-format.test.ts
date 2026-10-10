import { describe, expect, it } from 'vitest';

import {
  describeObservedWorktreeBranch,
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
} from './unpushed-work-observation-format.js';

describe('describeObservedWorktreeBranch（Issue #1266）', () => {
  it('引き継いだ枝名には、どの時刻の観測から引き継いだかを添える', () => {
    expect(
      describeObservedWorktreeBranch({
        branch: 'fix/1266',
        branchCarriedFromAt: '2026-10-10T00:05:00.000Z',
      }),
    ).toBe('fix/1266（この観測では取れず、2026-10-10T00:05:00.000Z 時点の観測から引き継いだ）');
  });

  it('この観測で取れた枝名はそのまま、取れなかったら null と名乗る', () => {
    expect(describeObservedWorktreeBranch({ branch: 'fix/1266' })).toBe('fix/1266');
    expect(describeObservedWorktreeBranch({ branch: null })).toBe('null（取れなかった）');
  });
});

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
    expect(describeUnpushedWorkObservationIncompleteness({ stoppedEarly: undefined })).toBeNull();
  });
});

describe('describeUnpushedWorkObservationIncompleteness — 読み失敗の件数がスクラッチ起点も含むと名乗る（#1891 の続き）', () => {
  it('unreadableDirCount があれば、スクラッチ起点そのものの読み失敗も含むと言う', () => {
    const text = describeUnpushedWorkObservationIncompleteness({ unreadableDirCount: 1 });
    expect(text).toContain('子ディレクトリの読み失敗が1件あった');
    expect(text).toContain('/tmp スクラッチの起点そのものの読み失敗を含む');
  });
});

describe('describeUnpushedWorkObservationProvenance（Issue #1266）', () => {
  it('closed の経路の句を出し、「器の入れ替えでは更新されない」とは言わない', () => {
    const text = describeUnpushedWorkObservationProvenance('closed', 'manager_list');
    expect(text).toContain('runner が closed を出す直前に先取り');
    expect(text).toContain('manager_list 自身では更新されない');
    expect(text).toContain('いまの状態ではない');
    expect(text).not.toContain('器の入れ替え');
    expect(text).not.toContain('枠落ち');
  });

  it('source が無い古い行は経路不明を出す', () => {
    expect(describeUnpushedWorkObservationProvenance(undefined, 'manager_list')).toContain(
      '経路不明',
    );
  });

  it('refresher を渡さなければ「自身では更新されない」とは言わず、いまの状態ではないことだけを言う', () => {
    const text = describeUnpushedWorkObservationProvenance('shutdown');
    expect(text).toContain('日常の redeploy で runner が stop する直前に先取り');
    expect(text).toContain('いまの状態そのものではない');
    expect(text).not.toContain('自身では更新されない');
  });
});
