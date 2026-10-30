import { describe, expect, it } from 'vitest';

import { describeGithubCi } from './github-ci-format.js';

const JA_LABEL = { success: '成功', failure: '失敗', pending: '実行中・待ち' } as const;

describe('describeGithubCi（軽い出口 github-ci-format。raw の字面と、呼ぶ側が渡す軸の名前）', () => {
  const ci = { pulls: 5, success: 3, failure: 1, pending: 0, checks: '必須チェックだけ' };

  it('ci あり・未集計あり: raw は軸を英語の名前で出し、未集計の件数を言う', () => {
    expect(describeGithubCi({ ci })).toBe(
      'CI: 5 件の PR を確認 — success 3 / failure 1 / pending 0（チェックが無い等で未集計 1 件）（数えたもの: 必須チェックだけ）',
    );
  });

  it('ci あり・未集計なし: 未集計の断りを出さない', () => {
    expect(describeGithubCi({ ci: { ...ci, pulls: 4 } })).toBe(
      'CI: 4 件の PR を確認 — success 3 / failure 1 / pending 0（数えたもの: 必須チェックだけ）',
    );
  });

  it('truncated: 数は下限と言う', () => {
    expect(
      describeGithubCi({
        ci: { pulls: 2, success: 2, failure: 0, pending: 0, checks: 'x', truncated: true },
      }),
    ).toBe(
      'CI: 2 件の PR を確認 — success 2 / failure 0 / pending 0（数えたもの: x）（打ち切り。数は下限）',
    );
  });

  it('ciUnavailable: 取れなかった理由を言い、0 件と読ませない', () => {
    expect(describeGithubCi({ ciUnavailable: 'HTTP 403' })).toBe(
      'CI: 取れなかった — HTTP 403（0 件ではない）',
    );
  });

  it('観測なし: 0 件と読ませない', () => {
    expect(describeGithubCi({})).toBe('CI: 観測していない（0 件ではない）');
  });

  it('軸の名前を渡すと、その名前で success / failure / pending の順に出す', () => {
    expect(describeGithubCi({ ci }, JA_LABEL)).toBe(
      'CI: 5 件の PR を確認 — 成功 3 / 失敗 1 / 実行中・待ち 0（チェックが無い等で未集計 1 件）（数えたもの: 必須チェックだけ）',
    );
  });

  it('軸の名前は ci の無い行には効かない（文言は raw と同じ）', () => {
    expect(describeGithubCi({ ciUnavailable: 'HTTP 403' }, JA_LABEL)).toBe(
      describeGithubCi({ ciUnavailable: 'HTTP 403' }),
    );
    expect(describeGithubCi({}, JA_LABEL)).toBe(describeGithubCi({}));
  });
});
