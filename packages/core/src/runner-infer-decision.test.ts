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

/**
 * issue #1877: 否定の語を含む承認の言い方（英語）が `deny` と読まれる穴。
 *
 * `no problem` / `no objection(s)` / `don't hesitate` / `don't mind` は
 * 意味としては承認だが、`DENIAL_WORDS` の `no` / `don't` が語境界で一致
 * してしまい、`inferDecision` の1段目（`DENIAL_PHRASES`/`DENIAL_WORDS`）
 * で `deny` が確定していた——3値化（#1827/#1837）で新設された `unreadable`
 * （承認とも拒否とも読めない回。SDK へは deny のまま返るが、クローンには
 * 「decision を付けて答え直せ」と伝わる）にすら届かず、`問題ない` のような
 * 日本語の否定込み承認（`ない` が `NEGATION_MARKERS_JA` に在るので
 * `hasApprovalMarker && !hasNegationMarker` で自然に unreadable へ落ちる）
 * と扱いが揃っていなかった。
 *
 * 直し方は `allow` へ倒すことではない——`allow` へ寄せると #1827 が閉じた
 * 「迷ったら通さない」の既定を緩めることになる。ここでの直しは
 * `unreadable` への着地であり、SDK から見える結果（deny）は1文字も
 * 変わらない。
 */
describe('inferDecision / 否定の語を含む承認の言い方は unreadable（issue #1877）', () => {
  it.each([
    'no problem',
    'No problem!',
    'There is no problem with that.',
    'no objection',
    'no objections',
    "don't hesitate",
    "Don't hesitate, go for it.",
    "don't mind",
    "I don't mind at all.",
  ])('「%s」は unreadable（deny へ化けない）', (message) => {
    expect(inferDecision(message)).toBe('unreadable');
  });

  it('decideAnswer（permission・decision なし）も、SDK へは deny を返しつつ unreadable: true を運ぶ', () => {
    expect(decideAnswer('permission', undefined, 'no problem')).toEqual({
      decision: 'deny',
      unreadable: true,
    });
  });

  it.each(['no problem, but stop', "don't hesitate to cancel", 'no objection, I refuse'])(
    '対照: 同じ回答に別の本物の否定が在れば「%s」は deny のまま',
    (message) => {
      expect(inferDecision(message)).toBe('deny');
    },
  );

  it("対照: 既存の歯を壊していない —— 「won't approve」は今までどおり deny", () => {
    expect(inferDecision("won't approve")).toBe('deny');
  });

  it('対照: 既存の歯を壊していない —— 日本語「問題ない」は今までどおり unreadable', () => {
    expect(inferDecision('問題ない')).toBe('unreadable');
  });
});

/**
 * issue #1890: `don't worry` / `no worries` が #1877 の一覧に無く、
 * 案内の無い `deny` に化ける穴。
 *
 * `don't hesitate` / `don't mind` と同格の「心配しないで＝進めてよい」と
 * いう言い回しなのに、`NEGATED_APPROVAL_PHRASES` に入っていなかったため
 * `DENIAL_WORDS` の `\bdon't\b` / `\bno\b` が先に `deny` を確定させ、
 * #1877 が作った救済（`unreadable`。答え直しの案内付き）にすら届いて
 * いなかった。直し方は #1877 と同じ形——`allow` へは倒さず、
 * `NEGATED_APPROVAL_PHRASES` に2つ足して `unreadable` へ着地させるだけ
 * である（SDK から見える結果は deny のまま）。
 */
describe('inferDecision / "don\'t worry" と "no worries" は unreadable（issue #1890）', () => {
  it("「Yes, please proceed. Don't worry, I trust your judgement.」は unreadable", () => {
    expect(inferDecision("Yes, please proceed. Don't worry, I trust your judgement.")).toBe(
      'unreadable',
    );
  });

  it('decideAnswer（permission・decision なし）も、SDK へは deny を返しつつ unreadable: true を運ぶ', () => {
    expect(
      decideAnswer(
        'permission',
        undefined,
        "Yes, please proceed. Don't worry, I trust your judgement.",
      ),
    ).toEqual({
      decision: 'deny',
      unreadable: true,
    });
  });

  it('「No worries, go ahead.」も unreadable', () => {
    expect(inferDecision('No worries, go ahead.')).toBe('unreadable');
  });

  it.each(["Don't worry, but stop.", 'no worries — cancel it'])(
    '対照: 同じ回答に別の本物の否定が在れば「%s」は deny のまま',
    (message) => {
      expect(inferDecision(message)).toBe('deny');
    },
  );

  it.each(['no problem', 'no objection', "don't hesitate", "don't mind"])(
    '対照: #1877 の既存4語「%s」は引き続き unreadable（今回の変更で壊れていない）',
    (message) => {
      expect(inferDecision(message)).toBe('unreadable');
    },
  );
});

/**
 * issue #1907: 曲がった引用符（U+2019 RIGHT SINGLE QUOTATION MARK '’'）で
 * 書かれた `don't` / `won't` が否定として読まれず、`Don’t go ahead.` が
 * allow に化ける穴。
 *
 * `DENIAL_WORDS`（`don't` / `won't`）・`NEGATION_MARKERS_EN`（`n't`）・
 * `NEGATED_APPROVAL_PHRASES`（`don't hesitate` 等6語）はいずれも素の
 * アポストロフィ（U+0027 `'`）だけを見ている。スマートフォンや macOS の
 * 入力・Slack 等の自動整形は曲がった引用符（U+2019 `’`、および見た目が
 * 近い U+2018 `‘` / U+02BC `ʼ`）を使うことが多く、その形で届いた否定は
 * どの一覧にも当たらない——`Don’t go ahead.` は `go ahead`
 * （`APPROVAL_WORDS`）に当たる一方、否定側のどの一覧にも当たらないので
 * `allow` になる（#1827/#1837 で「読めなければ allow にしない」へ反転した
 * 方針の抜け）。
 *
 * 直し方は `inferDecision` の入口でアポストロフィの変種を素の `'` へ
 * 揃えてから各一覧に当てること——`NEGATED_APPROVAL_PHRASES` の照合にも
 * 同じ正規化が及ぶようにする（`hasNegatedApprovalPhrase` /
 * `hasNegatedApprovalDenial` は `inferDecision` 内でしか呼ばれないので、
 * 入口1箇所の正規化で足りる。呼び出し元は他に無い——`packages/core/src/*.ts`
 * を `grep -Fn` した実測は PR 本文にある）。
 */
describe('inferDecision / 曲がった引用符の apostrophe が否定として読まれない（issue #1907）', () => {
  it('「Don’t go ahead.」（U+2019）は deny（曲がった引用符の否定を見落として allow に化けない）', () => {
    expect(inferDecision('Don’t go ahead.')).toBe('deny');
  });

  it('「I won’t approve this, don’t proceed.」（U+2019 を2箇所）も deny', () => {
    expect(inferDecision('I won’t approve this, don’t proceed.')).toBe('deny');
  });

  it('decideAnswer（permission・decision なし）でも同じ穴を通らない', () => {
    expect(decideAnswer('permission', undefined, 'Don’t go ahead.')).toEqual({
      decision: 'deny',
      unreadable: false,
    });
  });

  it.each(['Don’t worry, go ahead.', 'Don’t mind, go ahead.', 'Don’t hesitate, go ahead.'])(
    "「%s」（U+2019）は unreadable（#1877/#1890 の NEGATED_APPROVAL_PHRASES と同じ着地。素の ' と揃う）",
    (message) => {
      expect(inferDecision(message)).toBe('unreadable');
    },
  );

  it.each([
    ['U+2018 LEFT SINGLE QUOTATION MARK', 'Don‘t go ahead.'],
    ['U+02BC MODIFIER LETTER APOSTROPHE', 'Donʼt go ahead.'],
  ])(
    '%s の変種「%s」も deny（U+2019 以外の見た目が近い変種も同じ経路を通る）',
    (_label, message) => {
      expect(inferDecision(message)).toBe('deny');
    },
  );

  it.each([
    ['U+2018 LEFT SINGLE QUOTATION MARK', 'Don‘t worry, go ahead.'],
    ['U+02BC MODIFIER LETTER APOSTROPHE', 'Donʼt worry, go ahead.'],
  ])('%s の変種「%s」も unreadable', (_label, message) => {
    expect(inferDecision(message)).toBe('unreadable');
  });

  it.each([
    "Don't go ahead.",
    "I won't do this.",
    "won't approve",
    'Rejected.',
    'それは拒否する。',
  ])("対照: 素の ' の既存の例「%s」は今回の変更で変わらず deny のまま", (message) => {
    expect(inferDecision(message)).toBe('deny');
  });

  it.each(["don't hesitate", "don't mind", "don't worry", 'no worries', 'no problem'])(
    "対照: 素の ' の既存の例「%s」は今回の変更で変わらず unreadable のまま",
    (message) => {
      expect(inferDecision(message)).toBe('unreadable');
    },
  );

  it.each(['はい、どうぞ', 'OK、進めてよい', '許可する', 'go ahead', 'approved'])(
    '対照: 曲がった引用符と無関係な既存の承認の例「%s」は allow のまま',
    (message) => {
      expect(inferDecision(message)).toBe('allow');
    },
  );
});

/**
 * issue #1923: 承認の語（はい・どうぞ・OK・Sure など）と、一覧に無い
 * 「進めるな」の言い方が同じ回答に入ると allow になっていた穴。`inferDecision`
 * は「承認の語が在り、否定の印が無いときだけ allow」なので、否定の印にも
 * `DENIAL_*` にも無い言い方（保留・見送り・不要・カタカナのダメ・wait・
 * hold off・pause・abort）や、全角の英字（`ＳＴＯＰ` / `ＮＯ`）は、承認の語に
 * 負けて許す側へ倒れる。
 *
 * はっきりした否定（ダメ・abort・全角の STOP / NO）は deny、保留・一時停止の
 * 言い方は unreadable（答え直しの案内）へ落ちることを見る。後者を deny に
 * しないのは、「確認は不要です、どうぞ」「Don't wait, go ahead」のように
 * 承認の文にも現れうるからである。
 */
describe('inferDecision / 承認の語と一覧に無い否定が同居しても allow にしない（issue #1923）', () => {
  it.each([
    'はい、ダメです',
    'はい、でもダメ',
    'Sure — abort',
    'OK, aborting',
    'はい、ＳＴＯＰ',
    'ＮＯ、go ahead',
    'Ｎｏ. go ahead',
  ])('「%s」は deny', (message) => {
    expect(inferDecision(message)).toBe('deny');
  });

  it.each([
    'どうぞ、いったん保留でお願いします',
    'はい、今回は不要です',
    'はい、いったん見送りましょう',
    'OKですが今は保留でお願いします',
    'OK、保留で',
    'OK\n実は保留にしたい',
    'OK, wait a moment',
    'Sure, hold off for now',
    'Sure, wait',
    'ok, hold off',
    'Yes, but hold on',
    'OK, pause for now',
  ])('「%s」は unreadable（allow へ倒れない）', (message) => {
    expect(inferDecision(message)).toBe('unreadable');
  });

  it('decideAnswer（permission・decision なし）でも「はい、保留」は SDK へ deny を返しつつ unreadable: true を運ぶ', () => {
    expect(decideAnswer('permission', undefined, 'はい、保留')).toEqual({
      decision: 'deny',
      unreadable: true,
    });
  });

  it.each(['ＯＫ', 'はい', 'どうぞ', 'OK, go ahead', 'Sure'])(
    '対照: 承認だけの「%s」は allow のまま（全角の ＯＫ も半角と同じに読む）',
    (message) => {
      expect(inferDecision(message)).toBe('allow');
    },
  );

  it.each(['nothing', 'sunny', 'bookish', 'oklahoma', 'awaiting', 'unpaused'])(
    '対照: 語の一部に当たるだけの「%s」は allow にも deny にもならない',
    (message) => {
      expect(inferDecision(message)).toBe('unreadable');
    },
  );
});

/**
 * issue #1926（クローン teto の判断、2026-09-28）: decision の無い回答を allow と
 * 推定するのは、**回答が承認の言い方だけでできているとき**に限る。承認の語に
 * 句読点・空白・敬語程度が付いた形までを「承認だけ」と数え、それ以外の文は
 * 承認の語を含んでいても unreadable（答え直しの案内）にする。
 *
 * 理由は #1827 / #1837 の線（判定できないときは閉じる側に倒す。読み違えて
 * 通すより、聞き直す方が安い）の延長である。#1837 / #1907 / #1923 は、承認の
 * 語と一覧に無い否定が同居する形を、語を足して塞いできた。語を足す形では
 * 漏れが残り続けるので、allow の側を形で絞る。
 *
 * **下の一覧が、承認の言い方だけで allow になる文の固定である。** 足す・外す
 * ときは、この一覧を先に動かすこと。
 */
describe('inferDecision / allow は承認の言い方だけでできた回答に限る（issue #1926）', () => {
  it.each([
    'はい',
    'はい。',
    'はい！',
    'はい、どうぞ',
    'はい、どうぞ。',
    'どうぞ',
    'どうぞ、お願いします',
    'はい、お願いします',
    'お願いします、どうぞ',
    '進めてよい',
    'OK、進めてよい',
    '進めてよいです',
    '許可する',
    '許可します',
    '承認する',
    '承認します',
    'OK',
    'ok',
    'Ok.',
    'okay',
    'ＯＫ',
    'OK です',
    'OKです',
    'yes',
    'Yes.',
    'Yes!',
    'yes please',
    'sure',
    'Sure.',
    'go ahead',
    'Go ahead.',
    'Go ahead, please.',
    'Please go ahead.',
    'OK, go ahead',
    'Yes, go ahead.',
    'Sure, go ahead!',
    'approved',
    'Approved.',
    'approve',
    'OK, thanks',
    'はい、よろしくお願いします',
    '  はい  ',
  ])('承認の言い方だけの「%s」は allow', (message) => {
    expect(inferDecision(message)).toBe('allow');
  });

  it.each([
    // 承認の語に、一覧に無い条件や注文が付いた形——#1923 のように否定が
    // 隠れていても、語の一覧に無ければ見分けられないので、allow にしない。
    'OK、ただし main には push しないで',
    'はい、でも本番には触らないこと',
    'どうぞ、ただ先に相談して',
    'Sure, but only on the staging branch',
    'OK, go ahead but ask me first next time',
    'Yes, go ahead with the dry run only',
    'go ahead after lunch',
    'はい、あとで',
    'OK 🚫',
    'OK?',
    'はい、進めて',
    'yes and no',
    'ok ok but hmm',
    // 承認の語が別の語の中にあるだけの形
    'yesterday',
    'okra',
    'approval pending',
  ])('承認の語以外を含む「%s」は unreadable（allow へ倒れない）', (message) => {
    expect(inferDecision(message)).not.toBe('allow');
  });

  it('decideAnswer: decision を付けた回答は、文がどうであっても decision のまま効く', () => {
    expect(decideAnswer('permission', 'allow', 'OK、ただし main には push しないで')).toEqual({
      decision: 'allow',
      unreadable: false,
    });
    expect(decideAnswer('permission', 'deny', 'はい、どうぞ')).toEqual({
      decision: 'deny',
      unreadable: false,
    });
  });

  it('decideAnswer: decision の無い「OK、ただ先に相談して」は SDK へ deny を返しつつ unreadable: true を運ぶ', () => {
    expect(decideAnswer('permission', undefined, 'OK、ただ先に相談して')).toEqual({
      decision: 'deny',
      unreadable: true,
    });
  });
});
