import { describe, expect, it } from 'vitest';

import { decideAnswer, hasNegationMarker, inferDecision } from './runner.js';

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
    expect(inferDecision("won't approve")).toBe('deny');
  });

  it('「問題ない」は否定の印（ない）を含むので、承認の意図があっても unreadable', () => {
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

describe("hasNegationMarker / n't の縮約でも否定の印が当たる（issue #1932）", () => {
  it.each([
    "isn't",
    "Yes, but it isn't safe yet.",
    "OK, but shouldn't you run the tests first?",
    "Sure, I wouldn't do that.",
    "Yes, I haven't decided.",
    "doesn't",
    "can't",
    "aren't",
    "wasn't",
    'Isn’t it risky?',
  ])('「%s」は否定の印に当たる', (message) => {
    expect(hasNegationMarker(message.replace(/[‘’ʼ]/g, "'"))).toBe(true);
  });

  it.each(['nothing', 'Yes', 'OK, go ahead', 'antenna', "n'est-ce pas"])(
    '対照: 「%s」は否定の印に当たらない',
    (message) => {
      expect(hasNegationMarker(message)).toBe(false);
    },
  );

  it.each(["Yes, but it isn't safe yet.", "OK, but shouldn't you run the tests first?"])(
    '「%s」は allow にならない（#1932 の症状）',
    (message) => {
      expect(inferDecision(message)).not.toBe('allow');
    },
  );
});

describe('inferDecision / 全角のアポストロフィ（U+FF07）の否定も読む（issue #1907 の残り）', () => {
  it.each(['Don＇t go ahead.', 'I won＇t approve this.', 'Please don＇t proceed.'])(
    '「%s」は deny',
    (message) => {
      expect(inferDecision(message)).toBe('deny');
    },
  );

  it("「Don＇t worry, go ahead.」は unreadable（素の ' と同じ着地）", () => {
    expect(inferDecision('Don＇t worry, go ahead.')).toBe('unreadable');
  });

  it('「Yes, but it isn＇t safe yet.」の縮約も否定の印に当たる（#1932 と同じ着地）', () => {
    expect(hasNegationMarker('Yes, but it isn＇t safe yet.'.normalize('NFKC'))).toBe(true);
    expect(inferDecision('Yes, but it isn＇t safe yet.')).not.toBe('allow');
  });
});
