import { describe, expect, it } from 'vitest';

import { denialInputAbsence, denialInputShape } from './denial-shape.js';

/**
 * `denialInputShape` / `denialInputAbsence`（拒否の記録に残す「入力の形」）。
 *
 * **この doc（`denial-shape.ts` 冒頭）が「出す・出さない」の全部の線を引いている。**
 * ここでは doc の主張を1つずつ歯にする——分岐を数え上げて1本ずつ通す（A）、
 * 秘密が漏れないこと自体を守る（B、この PR で一番大事な歯）、Markdown の面へ
 * 素で埋まる一文が記号を含まないこと（C）、「無い」の種類を空文字へ潰さない
 * こと（D）、の4本立てにする。
 */

describe('denialInputShape（分岐の網羅）', () => {
  // ここから先は実測した現在の出力をそのまま固定する。字面が変わったら
  // 落ちてほしいので `toContain` ではなく `toBe` を使う。

  it('入力そのものが無い（undefined）→ undefined を返す', () => {
    expect(denialInputShape(undefined)).toBe(undefined);
  });

  it('入力が null → 文字列 "null"（"入力が無い" とは別の字面にする）', () => {
    expect(denialInputShape(null)).toBe('null');
  });

  it('素の文字列 → 種別と長さだけ（先頭の語は当てない）', () => {
    // doc「先頭の語をどこまで出すか」の節が言うとおり——道具の入力は普通
    // オブジェクトで、文字列がそのまま来る形はシェルのコマンド行ではない。
    // 先頭の語の規則は `command` 欄にしか当てないので、ここには現れない。
    expect(denialInputShape('git status')).toBe('文字列 / chars=10');
  });

  it('素の文字列には先頭の語を当てない（値が1語でも、その語をまるごと出さない）', () => {
    // A の分岐網羅とは別に、この線そのものを歯にする。ここが崩れると、
    // 「入力全体が1語の値だった」回に、その値をまるごと先頭の語として
    // 出す経路が復活する（B の［既知の穴］が塞がった、その裏側）。
    const shape = denialInputShape('hunter2');
    expect(shape).not.toContain('hunter2');
    expect(shape).toBe('文字列 / chars=7');
  });

  it('command 欄を持つオブジェクト → 欄の名前・command の先頭の語・長さ', () => {
    const input = { command: 'git status -sb', description: 'x' };
    expect(denialInputShape(input)).toBe('欄=command,description / 先頭の語=git / chars=46');
  });

  it('command の先頭が代入（TOKEN=…）→ 先頭の語は伏せる（値そのものだから）', () => {
    const input = { command: 'TOKEN=ghp_abc123 curl https://x/?token=ghp_abc123' };
    expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=63');
  });

  it('command の先頭が URL → 先頭の語は伏せる（"/" "." ":" を含むので通らない）', () => {
    const input = { command: 'https://ex.com/?token=s3cr3t' };
    expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=42');
  });

  it('command の先頭の語が長すぎる（32文字超）→ 伏せる', () => {
    const input = { command: `${'a'.repeat(36)} arg` };
    expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=54');
  });

  it('command を持たないオブジェクト（file_path 等）→ 先頭の語の節ごと落ちる', () => {
    // file_path は COMMAND_KEYS に無いので「先頭の語=(伏せた)」とすら書かない
    // ——見に行って隠した、ではなく最初から見ていないことを区別する。
    const input = {
      file_path: 'apps/web/app/routes/chat.test.tsx',
      old_string: 'a',
      new_string: 'b',
    };
    expect(denialInputShape(input)).toBe('欄=file_path,old_string,new_string / chars=83');
  });

  it('欄が無いオブジェクト（{}）→ "(欄なし)"', () => {
    expect(denialInputShape({})).toBe('欄=(欄なし) / chars=2');
  });

  it('配列 → 種別と要素数', () => {
    expect(denialInputShape([1, 2, 3])).toBe('配列 / 要素=3 / chars=7');
  });

  it('number → typeof と長さ', () => {
    expect(denialInputShape(42)).toBe('number / chars=2');
  });

  it('boolean → typeof と長さ', () => {
    expect(denialInputShape(true)).toBe('boolean / chars=4');
  });

  it('command が空白だけ → 先頭の語が取れず伏せる（空文字を先頭の語にしない）', () => {
    const input = { command: '   ' };
    expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=17');
  });

  it('command が文字列でない（number）→ 先頭の語の節ごと落ちる', () => {
    const input = { command: 5 };
    expect(denialInputShape(input)).toBe('欄=command / chars=13');
  });

  it('欄が9個（MAX_KEYS=8超）→ 先頭8個 + "…" で切る', () => {
    const nine: Record<string, unknown> = {};
    'abcdefghi'.split('').forEach((key, index) => {
      nine[key] = index;
    });
    expect(denialInputShape(nine)).toBe('欄=a,b,c,d,e,f,g,h,… / chars=55');
  });

  it('循環参照 → 長さが測れない（0 と偽らず「長さ不明」にする）', () => {
    const self: Record<string, unknown> = {};
    self.self = self;
    expect(denialInputShape(self)).toBe('欄=self / 長さ不明');
  });

  describe('SAFE_HEAD_WORD の境界（32文字ちょうどは通り、33文字は伏せる）', () => {
    it('先頭の語が32文字ちょうど → そのまま出す', () => {
      const input = { command: `${'a'.repeat(32)} arg` };
      expect(denialInputShape(input)).toBe(`欄=command / 先頭の語=${'a'.repeat(32)} / chars=50`);
    });

    it('先頭の語が33文字 → 伏せる', () => {
      const input = { command: `${'a'.repeat(33)} arg` };
      expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=51');
    });
  });

  it('先頭の語が記号始まり（_foo）→ 伏せる（最初の文字は英数字のみ許す）', () => {
    const input = { command: '_foo bar' };
    expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=22');
  });

  /**
   * `headWordOf` に足された追加条件——`SAFE_HEAD_WORD` を通ったあとでも、
   * **英字と数字が両方混ざっていて12文字以上（`SECRET_ISH_MIN_LENGTH`）**
   * の語は出さない。GitHub の PAT・Anthropic の API 鍵・AWS のアクセスキー id
   * はどれもこの形に当たる。「両方混ざっている」「12文字以上」という**2つの
   * 条件が両方揃わないと伏せない**ことを、片方だけ崩す入力で確かめる。
   */
  describe('SECRET_ISH_MIN_LENGTH の境界（英数字混在・12文字以上だけを伏せる）', () => {
    it('英数字混在・12文字ちょうど → 伏せる', () => {
      const input = { command: 'abcdefghij12 --x' };
      expect(denialInputShape(input)).toBe('欄=command / 先頭の語=(伏せた) / chars=30');
    });

    it('英数字混在・11文字 → そのまま出す（境界の下側）', () => {
      const input = { command: 'abcdefghi12 --x' };
      expect(denialInputShape(input)).toBe('欄=command / 先頭の語=abcdefghi12 / chars=29');
    });

    it('数字を含まない長い語（19文字）→ 出る。長いだけでは伏せない', () => {
      // `update-alternatives` は実在するプログラム名で、数字を含まない。
      // 「英数字が両方混ざっている」条件が無ければここも伏せてしまう。
      const input = { command: 'update-alternatives --config editor' };
      expect(denialInputShape(input)).toBe('欄=command / 先頭の語=update-alternatives / chars=49');
    });

    it('数字だけの語（英字が無い）→ 出る。「英字と数字の両方が要る」を固定する', () => {
      const input = { command: '1234567890123 x' };
      expect(denialInputShape(input)).toBe('欄=command / 先頭の語=1234567890123 / chars=29');
    });
  });
});

describe('denialInputShape（秘密が漏れないこと）', () => {
  /**
   * **秘密を含む入力を渡しても、返り値のどこにも秘密の文字列が現れない**こと。
   * ここは値ではなく形だけを出すという doc の中心の主張そのものなので、
   * 「たまたま今は漏れていない」ではなく、入力の形を変えても崩れないことを
   * 配列で束ねて確かめる。
   *
   * ⚠ ここに書くのは全部ダミーの値である（本物のトークンは書かない）。
   */
  const safeCases: { label: string; input: unknown; forbidden: string[] }[] = [
    {
      label: '代入が先頭に来る形（TOKEN=… git push）',
      input: { command: 'TOKEN=ghp_XXXXXXXXXXXX git push' },
      forbidden: ['ghp_XXXXXXXXXXXX', 'TOKEN='],
    },
    {
      label: 'URL に埋まった鍵（先頭の語 curl 自体は出てよい）',
      input: { command: 'curl "https://api.example.com/v1?token=s3cr3t-value"' },
      forbidden: ['s3cr3t-value', 'token=s3cr3t-value', 'api.example.com'],
    },
    {
      label: '環境変数の参照（$AWS_SECRET_ACCESS_KEY）',
      input: { command: 'echo $AWS_SECRET_ACCESS_KEY' },
      forbidden: ['AWS_SECRET_ACCESS_KEY', '$AWS_SECRET_ACCESS_KEY'],
    },
    {
      label: 'ヒアドキュメントで渡す鍵（gh auth login --with-token）',
      input: { command: 'gh auth login --with-token <<< ghp_XXXXXXXXXXXX' },
      forbidden: ['ghp_XXXXXXXXXXXX'],
    },
    {
      label: 'パスと編集内容の両方に鍵・平文パスワードが入る形（file_path 系）',
      input: {
        file_path: '/home/u/.config/ghp_XXXXXXXXXXXX/x',
        old_string: 'password: hunter2',
        new_string: 'password: hunter3',
      },
      forbidden: ['ghp_XXXXXXXXXXXX', 'hunter2', 'hunter3'],
    },
    {
      // GitHub の PAT は `ghp_` + 36文字。プログラム名の位置（先頭の語）に
      // 単独で来た、現実的な長さの鍵の形。SECRET_ISH_MIN_LENGTH（英数字混在・
      // 12文字以上を伏せる）が狙って落とす対象そのもの。
      label: '鍵が現実的な形でプログラム名の位置に来た回（ghp_ + 36文字ダミー）',
      input: { command: 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX push' },
      forbidden: ['ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'],
    },
  ];

  it.each(safeCases)('$label → 返り値に秘密の文字列を含まない', ({ input, forbidden }) => {
    const shape = denialInputShape(input);
    expect(shape).toBeDefined();
    for (const secret of forbidden) {
      expect(shape).not.toContain(secret);
    }
  });

  /**
   * **この穴は塞がった。** doc「先頭の語をどこまで出すか」の節が言うとおり
   * ——入力が素の文字列で来た回には、先頭の語の規則をそもそも当てなくなった
   * （道具の入力は普通オブジェクトで、文字列がそのまま来る形はシェルの
   * コマンド行ではないため）。以前はここで種別を "文字列" と判定した上で、
   * その文字列全体を先頭の語として扱っていた——入力全体が鍵だった回に、
   * 鍵をまるごと出す経路だった。ここでは「塞がった」側を固定する。
   */
  it('入力が素の文字列で、それ自体が鍵の形 → 先頭の語を当てないので漏れない（塞がった）', () => {
    const shape = denialInputShape('ghp_XXXXXXXXXXXX');
    expect(shape).toBe('文字列 / chars=16');
    expect(shape).not.toContain('ghp_XXXXXXXXXXXX');
  });

  /**
   * **こちらは塞がっていない。** doc「それでも塞げていないものを書いておく」の
   * 節（改訂後）が言うとおり——GitHub / Anthropic のトークンも AWS の
   * アクセスキー id も `SECRET_ISH_MIN_LENGTH`（英数字混在・12文字以上を
   * 伏せる）で落ちるようになったが、**英字だけ・数字だけでできた短い秘密**
   * （`hunter2` のようなパスワード）はまだ落ちない。`hunter2` は英字と数字が
   * 混ざってはいるが7文字しかなく、`SECRET_ISH_MIN_LENGTH`（12文字以上）にも
   * 届かないので、`SAFE_HEAD_WORD` をそのまま素通りして "安全な先頭の語" として
   * 出てしまう。ここを塞ぐには `command` 欄の先頭の語も一切出さないしかなく、
   * それではこの関数の意味（誤検知か正当な拒否かを読む側が判断できること）が
   * 消えるため、doc は塞がない側を選んでいる。「漏れない」と嘘の assert を
   * 書かずに、漏れる事実そのものを固定する。
   */
  it('［既知の穴］command 欄の値がプログラム名の位置に単独の秘密 → 先頭の語として出てしまう', () => {
    const shape = denialInputShape({ command: 'hunter2' });
    expect(shape).toBe('欄=command / 先頭の語=hunter2 / chars=21');
    expect(shape).toContain('hunter2');
  });
});

describe('denialInputAbsence（Markdown 安全性）', () => {
  // この一文は react-markdown で描かれる報告本文へそのまま埋まる。
  // `_` や `*` を書くと `<em>` に化ける（doc に明記）。
  it('via: live の一文に "_" も "*" も含まない', () => {
    const text = denialInputAbsence('live');
    expect(text).not.toContain('_');
    expect(text).not.toContain('*');
  });

  it('via: result の一文に "_" も "*" も含まない', () => {
    const text = denialInputAbsence('result');
    expect(text).not.toContain('_');
    expect(text).not.toContain('*');
  });

  it('via: live と via: result で異なる一文を返す（走行中と result を区別する）', () => {
    expect(denialInputAbsence('live')).toBe(
      '入力は付いていない（走行中の合図には入力の欄が無い。' +
        'ターン終わりの記録が届けば、続く note に形だけ残る）',
    );
    expect(denialInputAbsence('result')).toBe(
      '入力は付いていない（result の記録に入力の欄が無かった）',
    );
  });
});

describe('denialInputShape（「無い」の種類を潰さない）', () => {
  /**
   * この関数の出発点そのもの。`brief(undefined)` が `''` を返していたせいで
   * 「空のコマンドだった」と「そもそも入力が届かない経路だった」が同じ字面に
   * 見えていた——`undefined` は `undefined` のまま返し、空文字へ書き換えない。
   */
  it('undefined を返す。空文字にすり替えない', () => {
    const shape = denialInputShape(undefined);
    expect(shape).toBeUndefined();
    expect(shape).not.toBe('');
  });
});
