// runner.ts の承認の読み取り（inferDecision / decideAnswer と、それだけが使う語の一覧・補助関数）を別ファイルへ移す前の固定の試験。
// 仕様を先に書いたものではない: 期待の値は今の作りの出力から `vitest run <path> -u` で生成し、目で読んで確かめた。
// runner-infer-decision.test.ts が縛っていない「一覧の各語」「付け足しの各語・残りの記号」「否定の印の各語」を、
// 「その語だけが効く入力」で1つずつ縛る（語を1つ消すと、その行が赤くなる）。純関数だけで、時計も待ちも使わない。
// 縛れないもの（入力で区別できない）: 全角の `，．！…` を APPROVAL_ONLY_REMAINDER から消す変更（NFKC で `,.!...` に揃うため）・escapeRegExp（一覧に記号が無い）・
// 承認だけの判定が否定の印と重ならないことで余る `!hasNegationMarker`（語3個までの連結 36万通りで確認した）。
import { describe, expect, it } from 'vitest';

import { decideAnswer, hasNegationMarker, inferDecision } from './runner.js';

const decisionsOf = (messages: readonly string[]): Record<string, string> =>
  Object.fromEntries(messages.map((message) => [message, inferDecision(message)]));

describe('inferDecision pin / 語の一覧の各語', () => {
  it('DENIAL_PHRASES の各語が単独で deny', () => {
    expect(
      decisionsOf([
        'やめ',
        'だめ',
        'ダメ',
        '駄目',
        '不可',
        '中止',
        '却下',
        '拒否',
        '無理',
        '断る',
        'お断り',
        'しないで',
        '止めて',
        '待って',
        '許可しない',
        '許可できな',
        '許可できません',
        '承認しない',
        '承認できな',
        '承認できません',
        '認めない',
        '認められない',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "お断り": "deny",
        "しないで": "deny",
        "だめ": "deny",
        "やめ": "deny",
        "ダメ": "deny",
        "不可": "deny",
        "中止": "deny",
        "却下": "deny",
        "待って": "deny",
        "承認しない": "deny",
        "承認できな": "deny",
        "承認できません": "deny",
        "拒否": "deny",
        "断る": "deny",
        "止めて": "deny",
        "無理": "deny",
        "許可しない": "deny",
        "許可できな": "deny",
        "許可できません": "deny",
        "認めない": "deny",
        "認められない": "deny",
        "駄目": "deny",
      }
    `);
  });

  it('DENIAL_WORDS の各語（大文字・語尾つき）が単独で deny', () => {
    expect(
      decisionsOf([
        'deny',
        'denied',
        'denying',
        'no',
        'NO',
        'nope',
        "don't",
        'do not',
        "won't",
        'will not',
        'cannot',
        'can not',
        'stop',
        'stopping',
        'cancel',
        'cancelled',
        'reject',
        'rejecting',
        'refuse',
        'refused',
        'decline',
        'declined',
        'abort',
        'aborting',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "NO": "deny",
        "abort": "deny",
        "aborting": "deny",
        "can not": "deny",
        "cancel": "deny",
        "cancelled": "deny",
        "cannot": "deny",
        "decline": "deny",
        "declined": "deny",
        "denied": "deny",
        "deny": "deny",
        "denying": "deny",
        "do not": "deny",
        "don't": "deny",
        "no": "deny",
        "nope": "deny",
        "refuse": "deny",
        "refused": "deny",
        "reject": "deny",
        "rejecting": "deny",
        "stop": "deny",
        "stopping": "deny",
        "will not": "deny",
        "won't": "deny",
      }
    `);
  });

  it('DENIAL_WORDS は前後を語境界で見る（語の頭・途中に一致しても読まない）。語幹＋語尾（`\\w*`）は deny', () => {
    expect(
      decisionsOf(['nothing', 'know', 'stopwatch', 'denim', 'nonstop', 'rejection', 'cancel_x']),
    ).toMatchInlineSnapshot(`
      {
        "cancel_x": "deny",
        "denim": "unreadable",
        "know": "unreadable",
        "nonstop": "unreadable",
        "nothing": "unreadable",
        "rejection": "deny",
        "stopwatch": "unreadable",
      }
    `);
  });

  it('APPROVAL_PHRASES の各語が単独で allow', () => {
    expect(
      decisionsOf([
        'どうぞ',
        '進めてよい',
        '許可する',
        '許可します',
        '承認する',
        'はい',
        '承認します',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "どうぞ": "allow",
        "はい": "allow",
        "承認します": "allow",
        "承認する": "allow",
        "許可します": "allow",
        "許可する": "allow",
        "進めてよい": "allow",
      }
    `);
  });

  it('APPROVAL_WORDS の各語（大文字つき）が単独で allow', () => {
    expect(
      decisionsOf([
        'go ahead',
        'GO AHEAD',
        'approved',
        'approve',
        'ok',
        'okay',
        'OKAY',
        'yes',
        'sure',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "GO AHEAD": "allow",
        "OKAY": "allow",
        "approve": "allow",
        "approved": "allow",
        "go ahead": "allow",
        "ok": "allow",
        "okay": "allow",
        "sure": "allow",
        "yes": "allow",
      }
    `);
  });

  it('承認の一覧に無い言い方は unreadable（allow へ寄せない）', () => {
    expect(decisionsOf(['進めて', 'proceed', 'fine', 'agreed', 'ありがとう']))
      .toMatchInlineSnapshot(`
      {
        "agreed": "unreadable",
        "fine": "unreadable",
        "proceed": "unreadable",
        "ありがとう": "unreadable",
        "進めて": "unreadable",
      }
    `);
  });
});

describe('inferDecision pin / 承認だけの判定（付け足し・残りの記号・取り除く順）', () => {
  it('APPROVAL_ONLY_FILLERS_JA の各語は、承認の語と並べても allow', () => {
    expect(
      decisionsOf([
        'はい、よろしくお願いします',
        'はい、お願いします',
        'はい、お願い',
        'はい、ください',
        'はいです',
        'どうぞ、お願いします',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "どうぞ、お願いします": "allow",
        "はい、お願い": "allow",
        "はい、お願いします": "allow",
        "はい、ください": "allow",
        "はい、よろしくお願いします": "allow",
        "はいです": "allow",
      }
    `);
  });

  it('APPROVAL_ONLY_FILLERS_EN の各語は、承認の語と並べても allow', () => {
    expect(
      decisionsOf([
        'yes please',
        'yes, thanks',
        'yes thank you',
        'yes, thank you',
        'Please yes',
        'YES THANKS',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "Please yes": "allow",
        "YES THANKS": "allow",
        "yes please": "allow",
        "yes thank you": "allow",
        "yes, thank you": "allow",
        "yes, thanks": "allow",
      }
    `);
  });

  it('付け足しだけ・付け足し単独は承認の語が無いので allow にならない', () => {
    expect(decisionsOf(['お願いします', 'ください', 'です', 'please', 'thanks', 'thank you']))
      .toMatchInlineSnapshot(`
      {
        "please": "unreadable",
        "thank you": "unreadable",
        "thanks": "unreadable",
        "お願いします": "unreadable",
        "ください": "unreadable",
        "です": "unreadable",
      }
    `);
  });

  it('APPROVAL_ONLY_REMAINDER の各記号は、承認の語に続いても allow', () => {
    expect(
      decisionsOf(
        [
          '、',
          '。',
          '，',
          '．',
          ',',
          '.',
          '!',
          '！',
          '・',
          '…',
          '~',
          '〜',
          'ー',
          '—',
          '–',
          '-',
          ' ',
          '\t',
          '\n',
        ].map((tail) => `はい${tail}`),
      ),
    ).toMatchInlineSnapshot(`
      {
        "はい	": "allow",
        "はい
      ": "allow",
        "はい ": "allow",
        "はい!": "allow",
        "はい,": "allow",
        "はい-": "allow",
        "はい.": "allow",
        "はい~": "allow",
        "はい–": "allow",
        "はい—": "allow",
        "はい…": "allow",
        "はい、": "allow",
        "はい。": "allow",
        "はい〜": "allow",
        "はい・": "allow",
        "はいー": "allow",
        "はい！": "allow",
        "はい，": "allow",
        "はい．": "allow",
      }
    `);
  });

  it('APPROVAL_ONLY_REMAINDER に無い記号・文字が残れば allow にならない', () => {
    expect(
      decisionsOf([
        'はい?',
        'はい？',
        'はい;',
        'はい:',
        'はい/',
        'はい_',
        'はい(',
        'はい+',
        'はいa',
        'はい1',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "はい(": "unreadable",
        "はい+": "unreadable",
        "はい/": "unreadable",
        "はい1": "unreadable",
        "はい:": "unreadable",
        "はい;": "unreadable",
        "はい?": "unreadable",
        "はい_": "unreadable",
        "はいa": "unreadable",
        "はい？": "unreadable",
      }
    `);
  });

  it('承認の語を長い順に取り除く（短い語が先だと残りが出る組）', () => {
    expect(
      decisionsOf([
        '承認します',
        '承認します、お願いします',
        'よろしくお願いします、はい',
        'はい、よろしくお願いします。',
        '許可します',
        'okay',
        'ok okay',
        'approve approved',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "approve approved": "allow",
        "ok okay": "allow",
        "okay": "allow",
        "はい、よろしくお願いします。": "allow",
        "よろしくお願いします、はい": "allow",
        "承認します": "allow",
        "承認します、お願いします": "allow",
        "許可します": "allow",
      }
    `);
  });

  it('承認の語を含まない回答は、承認だけの判定に入らず unreadable', () => {
    expect(decisionsOf(['', ' ', '。', 'hmm', 'o k'])).toMatchInlineSnapshot(`
      {
        "": "unreadable",
        " ": "unreadable",
        "hmm": "unreadable",
        "o k": "unreadable",
        "。": "unreadable",
      }
    `);
  });
});

describe('hasNegationMarker pin / 否定の印の各語', () => {
  const messages = [
    'not',
    'never',
    'cannot',
    'wait',
    'hold off',
    'hold on',
    'pause',
    'paused',
    'pausing',
    "isn't",
    "n't",
    'NOT',
    'ない',
    'ません',
    'ず',
    '保留',
    '見送',
    '不要',
    'はい',
    'ok',
    'nothing',
    'notable',
    'neverland',
    'holdup',
    'await',
  ];

  it('各語が単独で当たる／当たらない', () => {
    expect(Object.fromEntries(messages.map((message) => [message, hasNegationMarker(message)])))
      .toMatchInlineSnapshot(`
      {
        "NOT": true,
        "await": false,
        "cannot": true,
        "hold off": true,
        "hold on": true,
        "holdup": false,
        "isn't": true,
        "n't": true,
        "never": true,
        "neverland": false,
        "not": true,
        "notable": false,
        "nothing": false,
        "ok": false,
        "pause": true,
        "paused": true,
        "pausing": false,
        "wait": true,
        "ず": true,
        "ない": true,
        "はい": false,
        "ません": true,
        "不要": true,
        "保留": true,
        "見送": true,
      }
    `);
  });

  it('承認の語の隣に否定の印が在れば allow にならない', () => {
    expect(
      decisionsOf(
        [
          'not',
          'never',
          'wait',
          'hold off',
          'hold on',
          'pause',
          "isn't",
          'ない',
          'ません',
          'ず',
          '保留',
          '見送',
          '不要',
        ].map((marker) => `はい、${marker}`),
      ),
    ).toMatchInlineSnapshot(`
      {
        "はい、hold off": "unreadable",
        "はい、hold on": "unreadable",
        "はい、isn't": "unreadable",
        "はい、never": "unreadable",
        "はい、not": "unreadable",
        "はい、pause": "unreadable",
        "はい、wait": "unreadable",
        "はい、ず": "unreadable",
        "はい、ない": "unreadable",
        "はい、ません": "unreadable",
        "はい、不要": "unreadable",
        "はい、保留": "unreadable",
        "はい、見送": "unreadable",
      }
    `);
  });
});

describe('inferDecision pin / 否定の語を含む承認の言い方（6語・大文字・複数回・残りの否定）', () => {
  const phrases = [
    'no problem',
    'no objection',
    "don't hesitate",
    "don't mind",
    "don't worry",
    'no worries',
  ];

  it('各語が単独で unreadable（大文字でも）', () => {
    expect(decisionsOf([...phrases, ...phrases.map((phrase) => phrase.toUpperCase())]))
      .toMatchInlineSnapshot(`
      {
        "DON'T HESITATE": "unreadable",
        "DON'T MIND": "unreadable",
        "DON'T WORRY": "unreadable",
        "NO OBJECTION": "unreadable",
        "NO PROBLEM": "unreadable",
        "NO WORRIES": "unreadable",
        "don't hesitate": "unreadable",
        "don't mind": "unreadable",
        "don't worry": "unreadable",
        "no objection": "unreadable",
        "no problem": "unreadable",
        "no worries": "unreadable",
      }
    `);
  });

  it('各語の後ろに別の本物の否定が在れば deny（英語の語・日本語の語）', () => {
    expect(
      decisionsOf([
        ...phrases.map((phrase) => `${phrase}, but stop`),
        ...phrases.map((phrase) => `${phrase}、でも拒否`),
        ...phrases.map((phrase) => `${phrase.toUpperCase()}, but stop`),
      ]),
    ).toMatchInlineSnapshot(`
      {
        "DON'T HESITATE, but stop": "deny",
        "DON'T MIND, but stop": "deny",
        "DON'T WORRY, but stop": "deny",
        "NO OBJECTION, but stop": "deny",
        "NO PROBLEM, but stop": "deny",
        "NO WORRIES, but stop": "deny",
        "don't hesitate, but stop": "deny",
        "don't hesitate、でも拒否": "deny",
        "don't mind, but stop": "deny",
        "don't mind、でも拒否": "deny",
        "don't worry, but stop": "deny",
        "don't worry、でも拒否": "deny",
        "no objection, but stop": "deny",
        "no objection、でも拒否": "deny",
        "no problem, but stop": "deny",
        "no problem、でも拒否": "deny",
        "no worries, but stop": "deny",
        "no worries、でも拒否": "deny",
      }
    `);
  });

  it('取り除いた跡は空白になる（両隣がつながって新しい否定の語にならない）', () => {
    expect(decisionsOf(['nno problemo', 'やno problemめ', 'no problem'])).toMatchInlineSnapshot(`
      {
        "nno problemo": "unreadable",
        "no problem": "unreadable",
        "やno problemめ": "unreadable",
      }
    `);
  });

  it('同じ語が複数回出ても、残りに否定が無ければ unreadable（全部取り除く）', () => {
    expect(
      decisionsOf(['no problem, no problem', "don't mind, don't mind", 'No Problem. NO PROBLEM.']),
    ).toMatchInlineSnapshot(`
      {
        "No Problem. NO PROBLEM.": "unreadable",
        "don't mind, don't mind": "unreadable",
        "no problem, no problem": "unreadable",
      }
    `);
  });

  it('別の一覧の語が混ざると取り除く対象が増える（どの語も取り除かれる）', () => {
    expect(
      decisionsOf([
        'no problem, no objection',
        "don't hesitate, don't mind, don't worry, no worries",
        'no problem, no worries, go ahead',
      ]),
    ).toMatchInlineSnapshot(`
      {
        "don't hesitate, don't mind, don't worry, no worries": "unreadable",
        "no problem, no objection": "unreadable",
        "no problem, no worries, go ahead": "unreadable",
      }
    `);
  });
});

describe('decideAnswer pin / 各枝の戻り値', () => {
  const rows: ReadonlyArray<
    readonly ['question' | 'permission', 'allow' | 'deny' | undefined, string]
  > = [
    ['question', undefined, 'はい'],
    ['question', undefined, 'no'],
    ['question', 'deny', 'はい'],
    ['question', 'allow', 'no'],
    ['permission', 'allow', 'no'],
    ['permission', 'deny', 'はい'],
    ['permission', undefined, 'はい'],
    ['permission', undefined, 'no'],
    ['permission', undefined, 'hmm'],
    ['permission', undefined, ''],
    ['permission', undefined, 'no problem'],
  ];

  it('kind・decision・message の組ごとの戻り値', () => {
    expect(
      rows.map(([kind, decision, message]) => ({
        kind,
        decision,
        message,
        result: decideAnswer(kind, decision, message),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "decision": undefined,
          "kind": "question",
          "message": "はい",
          "result": {
            "decision": "allow",
            "unreadable": false,
          },
        },
        {
          "decision": undefined,
          "kind": "question",
          "message": "no",
          "result": {
            "decision": "allow",
            "unreadable": false,
          },
        },
        {
          "decision": "deny",
          "kind": "question",
          "message": "はい",
          "result": {
            "decision": "allow",
            "unreadable": false,
          },
        },
        {
          "decision": "allow",
          "kind": "question",
          "message": "no",
          "result": {
            "decision": "allow",
            "unreadable": false,
          },
        },
        {
          "decision": "allow",
          "kind": "permission",
          "message": "no",
          "result": {
            "decision": "allow",
            "unreadable": false,
          },
        },
        {
          "decision": "deny",
          "kind": "permission",
          "message": "はい",
          "result": {
            "decision": "deny",
            "unreadable": false,
          },
        },
        {
          "decision": undefined,
          "kind": "permission",
          "message": "はい",
          "result": {
            "decision": "allow",
            "unreadable": false,
          },
        },
        {
          "decision": undefined,
          "kind": "permission",
          "message": "no",
          "result": {
            "decision": "deny",
            "unreadable": false,
          },
        },
        {
          "decision": undefined,
          "kind": "permission",
          "message": "hmm",
          "result": {
            "decision": "deny",
            "unreadable": true,
          },
        },
        {
          "decision": undefined,
          "kind": "permission",
          "message": "",
          "result": {
            "decision": "deny",
            "unreadable": true,
          },
        },
        {
          "decision": undefined,
          "kind": "permission",
          "message": "no problem",
          "result": {
            "decision": "deny",
            "unreadable": true,
          },
        },
      ]
    `);
  });
});
