import { describe, expect, it } from 'vitest';

import { hasTailFollowPattern, inspectBashCommand, TAIL_FOLLOW_RE } from './bash-wait-guard.js';

const TAIL = ['ta', 'il'].join('');

describe('tail-f: issue #5156 —— パスや名前の一部の語を命令と読まない（通す）', () => {
  const falsePositives: ReadonlyArray<[string, string]> = [
    [
      '1: psql の -h / -f のパスに語が在る',
      `psql -h /tmp/mgr-7d0315c7-${TAIL} -p 55917 -U postgres -d postgres -f /tmp/mgr-7d0315c7-${TAIL}/explain.sql`,
    ],
    ['2: cp のパスに語が在り、後ろに -f', `cp /tmp/mgr-7d0315c7-${TAIL}/a.txt /tmp/b -f`],
    ['3: ls のパスに語の頭が在り、後ろに -lf', `ls /srv/${TAIL}-logs -lf`],
    ['4: 語の前に名前が付いている（x-tail）', `cat x-${TAIL} -f`],
  ];

  for (const [label, command] of falsePositives) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
      expect(hasTailFollowPattern(command)).toBe(false);
      expect(TAIL_FOLLOW_RE.test(command)).toBe(false);
    });
  }
});

describe('tail-f: issue #5156 —— 独立した語の tail -f は引き続き弾く', () => {
  const realForms: ReadonlyArray<[string, string]> = [
    ['1: 素の tail -f', `${TAIL} -f x`],
    ['2: パスの頭が付いた形', `/usr/bin/${TAIL} -f x`],
    ['3: コマンド置換 $( … )', `echo $(${TAIL} -f x)`],
    ['4: 括弧', `(${TAIL} -f x)`],
    ['5: バッククォート', `\`${TAIL} -f x\``],
    ['6: パスに語が在り、後ろに本物（cd … && …）', `cd /tmp/a-${TAIL} && ${TAIL} -f x`],
  ];

  for (const [label, command] of realForms) {
    it(`${label}: 弾く（form: tail-f）`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
      expect(hasTailFollowPattern(command)).toBe(true);
      expect(TAIL_FOLLOW_RE.test(command)).toBe(true);
    });
  }
});

describe('tail-f: issue #5156 —— 手放すと決めたもの', () => {
  it('docker logs --tail 10 -f は止めない（偶然の一致を手放す。docker logs -f を止めていないのと揃える）', () => {
    expect(inspectBashCommand('docker logs --' + TAIL + ' 10 -f c').blocked).toBe(false);
  });
});
