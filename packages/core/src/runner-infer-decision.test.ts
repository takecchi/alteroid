import { describe, expect, it } from 'vitest';

import { decideAnswer, inferDecision } from './runner.js';

/**
 * `decision` を付け忘れた回答の読み取り（issue #1827）。
 *
 * `inferDecision` は「否定が読み取れたときだけ拒否」する設計で、語の一覧に
 * 無い否定は **allow に化ける**（許しすぎる側）。「拒否」「無理」のような
 * ごく普通の拒否の言い方が一覧から漏れていた。
 *
 * ⚠️ **2026-09-28（issue #1827/#1837）: `decideAnswer` の戻り値の形が変わった。**
 * 以前は `'allow' | 'deny'` の2値をそのまま返していたが、いまは
 * `{ decision: 'allow' | 'deny'; unreadable: boolean }` を返す（下の
 * 「3値化（issue #1827/#1837 の反転）」を見よ）。この describe 内のテストは
 * **挙動としては変わっていない**（否定の言い方が deny になる／明示の
 * decision が優先される、という主張そのものは1文字も反転していない）ので、
 * 反転ではなく型の追随として書き換えた。
 */
describe('inferDecision / 普通の拒否の言い方を拒否として読む（issue #1827）', () => {
  it.each([
    '拒否します',
    'それは拒否する。',
    'それは無理です',
    'お断りします',
    '断る',
    '許可できない',
    '認めない',
    '承認できません',
    'reject',
    'Rejected.',
    'I refuse.',
    'decline this one',
  ])('「%s」は deny', (message) => {
    expect(inferDecision(message)).toBe('deny');
  });

  it('decideAnswer（permission・decision なし）も、拒否の言い方を deny にする', () => {
    expect(decideAnswer('permission', undefined, 'それは拒否する。')).toEqual({
      decision: 'deny',
      unreadable: false,
    });
  });

  it.each(['はい、どうぞ', 'OK、進めてよい', '許可する', 'go ahead'])(
    '対照: 「%s」は今までどおり allow',
    (message) => {
      expect(inferDecision(message)).toBe('allow');
    },
  );

  it('対照: 明示の decision は語より優先する', () => {
    expect(decideAnswer('permission', 'allow', 'それは拒否する。')).toEqual({
      decision: 'allow',
      unreadable: false,
    });
  });
});

/**
 * `inferDecision` の3値化（issue #1827/#1837、オーナーの判断による反転）。
 *
 * #1827 は否定語の一覧を広げて直したが、#1837（17回目の横断レビュー）で
 * 同じ形の残りが見つかった——英語の -ing 形（`rejecting` 等。語境界で
 * `reject` に一致しない）や `won't` / `will not` / `cannot` が一覧に無く、
 * 「否定が読み取れなければ allow」という既定そのものが漏れの温床だった。
 *
 * オーナーはここで既定を反転した——`allow` / `deny` の2値ではなく
 * `allow` / `deny` / `unreadable` の3値にし、**否定を承認より先に見て**、
 * 承認として読むのは「承認の語があり、かつ否定の印が無い」ときだけにする。
 * どちらとも読めない回は新設の `unreadable` になる（SDK 側では `deny` として
 * 扱われる。`decideAnswer` の doc）。
 */
describe('inferDecision / 3値化（issue #1827/#1837 の反転）', () => {
  describe("#1837 が赤で見つけた漏れ（-ing 形・won't・will not・cannot）は、いまは deny", () => {
    it.each([
      'Rejecting your request.',
      "I'm refusing this one.",
      'Declining this request.',
      "I won't do this.",
      'I will not proceed with this.',
      'Absolutely not, cannot allow this.',
    ])('「%s」は deny', (message) => {
      expect(inferDecision(message)).toBe('deny');
    });

    it('decideAnswer（permission・decision なし）でも同じ穴を通らない', () => {
      expect(decideAnswer('permission', undefined, "I won't do this.")).toEqual({
        decision: 'deny',
        unreadable: false,
      });
    });
  });

  it.each(['はい、どうぞ', 'OK、進めてよい', '許可する', '承認する', 'go ahead', 'approved'])(
    'はっきりした承認「%s」は、反転後も allow のまま',
    (message) => {
      expect(inferDecision(message)).toBe('allow');
    },
  );

  /**
   * **PR #1866 のレビューで見つけた抜け。** `どうぞ` / `go ahead` /
   * `approved` と同じ強さの、ごく普通の承認の言い方（単独の `はい` /
   * `yes` / `sure` / 丁寧形の `承認します`）が初版の `APPROVAL_PHRASES` /
   * `APPROVAL_WORDS` に無く、`unreadable` へ落ちていた（`runner.ts` の
   * `APPROVAL_PHRASES` の doc を見よ）。**`進めて`（`よい` を伴わない単独形）
   * はここに含めない**——直下の「承認とも拒否とも読めない」の describe が
   * `よい、そのまま進めて` を `unreadable` の代表例として固定しており、
   * 単独の `進めて` を承認語にするとその歯を反転させる。
   */
  it.each(['はい', 'yes', 'sure', '承認します'])(
    'PR #1866 で足した、はっきりした承認「%s」も allow',
    (message) => {
      expect(inferDecision(message)).toBe('allow');
    },
  );

  it.each(["won't approve", 'cannot approve', '承認しません'])(
    '「%s」は allow にならない（否定を承認より先に見る）',
    (message) => {
      expect(inferDecision(message)).not.toBe('allow');
    },
  );

  it("「won't approve」は DENIAL_WORDS の won't が先に効いて deny になる", () => {
    // 承認の語（approve）を含んでいても、否定の印が先に確定させる。
    expect(inferDecision("won't approve")).toBe('deny');
  });

  it('「問題ない」は否定の印（ない）を含むので、承認の意図があっても unreadable', () => {
    // 過剰に拒否と読む側（答え直しを求めるだけ）であって、許しすぎる側では
    // ないので、これでよいという判断（依頼の設計要点そのもの）。
    expect(inferDecision('問題ない')).toBe('unreadable');
  });

  it.each(['たぶんそれで', 'うーん', 'よい、そのまま進めて', '任せる'])(
    '承認とも拒否とも読めない「%s」は unreadable（既定を閉じる側にした反転そのもの）',
    (message) => {
      expect(inferDecision(message)).toBe('unreadable');
    },
  );

  it('decideAnswer は unreadable を deny へ畳んで返しつつ、unreadable: true を運ぶ', () => {
    expect(decideAnswer('permission', undefined, 'よい、そのまま進めて')).toEqual({
      decision: 'deny',
      unreadable: true,
    });
  });

  it('AskUserQuestion（kind: question）は decision を一切見ず、常に allow（変えていない）', () => {
    expect(decideAnswer('question', undefined, 'よい、そのまま進めて')).toEqual({
      decision: 'allow',
      unreadable: false,
    });
    expect(decideAnswer('question', 'deny', 'どうでもいい')).toEqual({
      decision: 'allow',
      unreadable: false,
    });
  });

  it('明示の decision は、3値化の後も語より優先する', () => {
    expect(decideAnswer('permission', 'allow', '問題ない')).toEqual({
      decision: 'allow',
      unreadable: false,
    });
    expect(decideAnswer('permission', 'deny', 'はい、どうぞ')).toEqual({
      decision: 'deny',
      unreadable: false,
    });
  });
});
