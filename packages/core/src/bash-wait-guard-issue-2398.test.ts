import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

const BODY = 'while true; do sleep 5; done';
const WRITE = `cat > r.sh <<'EOF'\n${BODY}\nEOF\n`;

describe('書いたファイルを走らせる形は、本文を消さない（#2398）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['対照: bash r.sh', `${WRITE}bash r.sh`],
    ['bash -x r.sh', `${WRITE}bash -x r.sh`],
    ['bash -x -e r.sh', `${WRITE}bash -x -e r.sh`],
    ['cat r.sh | bash', `${WRITE}cat r.sh | bash`],
    ['cat r.sh | sh -x', `${WRITE}cat r.sh | sh -x`],
    ['| bash の後ろに区切り', `${WRITE}cat r.sh | bash; echo done`],
    ['| bash の後ろに &&', `${WRITE}cat r.sh | bash && echo done`],
    ['> >(sh)', `cat <<'EOF' > >(sh)\ntail -f x.log\nEOF`],
    ['> >(bash -x)', `cat <<'EOF' > >(bash -x)\ntail -f x.log\nEOF`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['書くだけ', `${WRITE}echo done`],
    ['bash -c は別の経路（中身が安全）', `${WRITE}bash -c "echo hi"`],
    ['名前が bash で始まる別のコマンド', `${WRITE}cat r.sh | bashful`],
    ['bash --version（走らせない）', `${WRITE}bash --version`],
    ['sh を含むだけの grep', `${WRITE}cat r.sh | grep sh`],
    ['> >(tee log) はデータ', `cat <<'EOF' > >(tee log)\ntail -f x.log\nEOF`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('シェルの後ろのオプション列が長くても後戻りで爆発しない（#2398）', () => {
  it('bash の後ろの -x の繰り返し', () => {
    const makeInput = (n: number) => `${WRITE}bash ${'-x '.repeat(n)}`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });
  it('| bash -x の繰り返し', () => {
    const makeInput = (n: number) => `${WRITE}${'cat r.sh | bash -x -x; '.repeat(n)}`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 200 });
  });
});
