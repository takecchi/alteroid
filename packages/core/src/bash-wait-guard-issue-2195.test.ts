import { describe, expect, it } from 'vitest';

import { hasTailFollowPattern, inspectBashCommand, TAIL_FOLLOW_RE } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

const TAIL = ['ta', 'il'].join('');

describe('tail-f: issue #2195 —— 引用符の中の誤検知4形を通す（許可リストに当たる）', () => {
  const falsePositives: ReadonlyArray<[string, string]> = [
    ['1: git commit -m の引用符の中', 'git commit -m "use ' + TAIL + ' -f x.log"'],
    [
      '2: gh issue comment --body の引用符の中',
      'gh issue comment 1 --body "run ' + TAIL + ' -f x.log"',
    ],
    ['3: grep のパターンの引用符の中', 'grep -n "' + TAIL + ' -f x.log" a.md'],
    ['4: echo の単一引用符の中', "echo '" + TAIL + " -f x.log'"],
  ];

  for (const [label, command] of falsePositives) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  it('誤検知4形すべてで falsePositives の件数が4件であること（表と実装のずれを検知する）', () => {
    expect(falsePositives.length).toBe(4);
  });
});

describe('tail-f: issue #2195 —— 本物11形は引き続き弾く', () => {
  const knownForms: ReadonlyArray<[string, string]> = [
    ['1: 素の tail -f', TAIL + ' -f x'],
    ['2: sudo 付き', 'sudo ' + TAIL + ' -f x'],
    ['3: -F（大文字）', TAIL + ' -F x'],
    ['4: --follow', TAIL + ' --follow x'],
    ['5: bash -c（二重引用符）', 'bash -c "' + TAIL + ' -f x"'],
    ['6: sh -c（単一引用符）', "sh -c '" + TAIL + " -f x'"],
    ['7: eval', 'eval "' + TAIL + ' -f x"'],
    ['8: ssh host（引用符の中身）', 'ssh h "' + TAIL + ' -f x"'],
    ['9: コマンド置換 $( … )', 'echo $(' + TAIL + ' -f x)'],
    ['10: バッククォート', 'echo `' + TAIL + ' -f x`'],
    ['11: 引用符の後ろに在る本物', 'a "q"; ' + TAIL + ' -f x'],
  ];

  for (const [label, command] of knownForms) {
    it(`${label}: 弾く（form: tail-f）`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
    });
  }

  it('本物11形すべてで knownForms の件数が11件であること（表と実装のずれを検知する）', () => {
    expect(knownForms.length).toBe(11);
  });
});

describe(
  'tail-f: issue #2195 —— 列挙していなかった実行形10形（レビューで見つかった）は弾く' +
    '（許可リストに当たらない）',
  () => {
    const newlyBlockedForms: ReadonlyArray<[string, string]> = [
      ['1: watch', 'watch "' + TAIL + ' -f x"'],
      ['2: su -c', 'su -c "' + TAIL + ' -f x"'],
      ['3: script -qc', 'script -qc "' + TAIL + ' -f x"'],
      ['4: docker exec c sh -c', 'docker exec c sh -c "' + TAIL + ' -f x"'],
      ['5: ヒアストリング bash <<<', 'bash <<<"' + TAIL + ' -f x"'],
      ['6: env -S', 'env -S "' + TAIL + ' -f x"'],
      ['7: コマンド名を二重引用符で囲む', '"' + TAIL + '" -f x'],
      ['8: コマンド名を単一引用符で囲む', "'" + TAIL + "' -f x"],
      ['9: 代入した変数をそのまま実行', 'x="' + TAIL + ' -f y"; $x'],
      ['10: 代入した変数を eval で実行', 'x="' + TAIL + ' -f y"; eval $x'],
    ];

    for (const [label, command] of newlyBlockedForms) {
      it(`${label}: 弾く（form: tail-f）`, () => {
        const verdict = inspectBashCommand(command);
        expect(verdict.blocked).toBe(true);
        if (!verdict.blocked) throw new Error('unreachable');
        expect(verdict.form).toBe('tail-f');
      });
    }

    it('10形すべてで newlyBlockedForms の件数が10件であること（表と実装のずれを検知する）', () => {
      expect(newlyBlockedForms.length).toBe(10);
    });
  },
);

describe('tail-f: issue #2195 —— 意図して弾いたままにする2形（許可リストの外なので誤検知として扱わない）', () => {
  it(
    '代入 x="' +
      TAIL +
      ' -f y"; echo $x は弾く（代入の単純コマンド自体が許可リストに当たらないため。' +
      '「代入した変数を後で実行するかもしれない」ことは静的には読めない）',
    () => {
      const command = 'x="' + TAIL + ' -f y"; echo $x';
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
    },
  );

  it(
    'bash -c \'echo "' +
      TAIL +
      ' -f x"\' は弾く（外側の bash -c が許可リストに当たらないので、内側の echo の' +
      '引数ごと生の字面のまま見る——1段目の版とは逆になった対照）',
    () => {
      const command = 'bash -c \'echo "' + TAIL + ' -f x"\'';
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
    },
  );
});

describe('tail-f: issue #2195 —— 許可リストの語の境界（範囲外・自主追加の対照）', () => {
  it('git log（commit ではない）の引用符の中は弾く', () => {
    const command = 'git log --oneline "' + TAIL + ' -f x"';
    expect(inspectBashCommand(command).blocked).toBe(true);
  });

  it('gh issue list（許可リストのサブコマンドではない）の引用符の中は弾く', () => {
    const command = 'gh issue list --search "' + TAIL + ' -f x"';
    expect(inspectBashCommand(command).blocked).toBe(true);
  });

  it('gh pr comment（許可リストのサブコマンド）の引用符の中は通す', () => {
    const command = 'gh pr comment 1 --body "run ' + TAIL + ' -f x.log"';
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  for (const name of ['echo-x', 'grep.sh', 'rg2']) {
    it(`${name}（許可リストの語で始まる別のコマンド）の引用符の中は弾く`, () => {
      const command = `${name} "${TAIL} -f x"`;
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  it('プロセス置換の出力側（echo … > >(sh)）は、出力をシェルへ渡すので弾く', () => {
    const command = 'echo "' + TAIL + ' -f x" > >(sh)';
    expect(inspectBashCommand(command).blocked).toBe(true);
  });
});

describe(
  'tail-f: issue #2195 —— 許可リストのコマンドでも、本物のパイプの左側なら消さない' +
    '（レビューで見つかった3形）',
  () => {
    const pipedForms: ReadonlyArray<[string, string]> = [
      ['1: echo … | bash', 'echo "' + TAIL + ' -f x" | bash'],
      ['2: printf … | sh', "printf '%s\\n' \"" + TAIL + ' -f x" | sh'],
      ['3: echo … | xargs -I{} sh -c {}', 'echo "' + TAIL + ' -f x" | xargs -I{} sh -c {}'],
    ];

    for (const [label, command] of pipedForms) {
      it(`${label}: 弾く（form: tail-f）`, () => {
        const verdict = inspectBashCommand(command);
        expect(verdict.blocked).toBe(true);
        if (!verdict.blocked) throw new Error('unreachable');
        expect(verdict.form).toBe('tail-f');
      });
    }

    it('3形すべてで pipedForms の件数が3件であること（表と実装のずれを検知する）', () => {
      expect(pipedForms.length).toBe(3);
    });

    it(
      '対照: パイプが無い単独の形（git commit -m "' + TAIL + ' -f x.log"）は今までどおり通す',
      () => {
        const command = 'git commit -m "use ' + TAIL + ' -f x.log"';
        expect(inspectBashCommand(command).blocked).toBe(false);
      },
    );

    it(
      '意図して残す形: echo "' +
        TAIL +
        ' -f x" > r.sh; bash r.sh（ファイルへ書いてから別の呼び出しで実行する形）は通す' +
        '——`>` はパイプではないので isRealPipeBoundary に当たらず、書いた直後の同じ' +
        '呼び出しの中で実行される形だけを塞ぐこのガードの守備範囲の外である' +
        '（`stripDataHeredocsForWaitForms` の「別の呼び出しで書いたファイルを後で走らせる' +
        '形はもともと見えない」と同じ限界）',
      () => {
        const command = 'echo "' + TAIL + ' -f x" > r.sh; bash r.sh';
        expect(inspectBashCommand(command).blocked).toBe(false);
      },
    );
  },
);

describe('hasTailFollowPattern —— 元の TAIL_FOLLOW_RE と同じ一致（issue #2195）', () => {
  const TAIL_FOLLOW_ORACLE_RE = TAIL_FOLLOW_RE;

  const handPicked = [
    TAIL + ' -f x',
    TAIL + ' -F x',
    TAIL + ' --follow x',
    TAIL + ' -5 foo.log; other -f bar',
    'sudo ' + TAIL + ' -qF x',
    TAIL + 'ing -f x',
    'x ' + TAIL + '\n-f y',
    TAIL + ' && -f',
    TAIL + ' || -f',
    TAIL + ' & -f',
    TAIL + ' -x -f',
    TAIL,
    '',
    TAIL + ' -',
  ];
  for (const command of handPicked) {
    it(`手で選んだ形: ${JSON.stringify(command)}`, () => {
      expect(hasTailFollowPattern(command)).toBe(TAIL_FOLLOW_ORACLE_RE.test(command));
    });
  }

  function prng(seed: number): () => number {
    let x = seed >>> 0 || 1;
    return () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x / 0x1_0000_0000;
    };
  }

  const PIECES = [
    TAIL,
    ' ',
    ' ',
    '-f',
    '-F',
    '--follow',
    '-qf',
    ';',
    '&&',
    '||',
    '|',
    '&',
    '\n',
    'x',
    'sudo',
    'ing',
  ];

  function randomCommand(next: () => number): string {
    const length = 1 + Math.floor(next() * 20);
    let out = '';
    for (let i = 0; i < length; i += 1) out += PIECES[Math.floor(next() * PIECES.length)] ?? '';
    return out;
  }

  it('乱数で作った 20000 通りの入力で、元の正規表現と一致する', () => {
    const next = prng(21_95);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const command = randomCommand(next);
      if (hasTailFollowPattern(command) !== TAIL_FOLLOW_ORACLE_RE.test(command)) {
        mismatches.push(command);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });
});

describe('tail-f の判定が、区切りの無い繰り返しで後戻りで爆発しない（issue #2195）', () => {
  it('区切りの無い tail の繰り返しが予算内に終わる（inspectBashCommand 経由）', () => {
    expectNotSuperlinear(
      (command: string) => inspectBashCommand(command),
      (n) => (TAIL + ' ').repeat(n),
      { n: 2000 },
    );
  });

  it('hasTailFollowPattern 単体でも予算内に終わる', () => {
    expectNotSuperlinear(
      (command: string) => hasTailFollowPattern(command),
      (n) => (TAIL + ' ').repeat(n),
      { n: 2000 },
    );
  });
});
