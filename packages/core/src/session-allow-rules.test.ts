import { describe, expect, it } from 'vitest';

import { SessionAllowRuleBook, sessionAllowRuleShapeOf } from './session-allow-rules.js';

describe('一時規則の形（#4905）', () => {
  it('Bash の command は全文のまま `Bash(<command>)` にする', () => {
    expect(sessionAllowRuleShapeOf('Bash', { command: 'git push origin a', timeout: 1 })).toEqual({
      kind: 'rule',
      rule: 'Bash(git push origin a)',
      command: 'git push origin a',
    });
  });

  it('完全一致より広くなりうる command（`*`・`:*`・改行・CR）は規則にしない', () => {
    expect(sessionAllowRuleShapeOf('Bash', { command: 'ls *.ts' })).toMatchObject({
      kind: 'unruleable',
      reason: '`*` を含む',
    });
    expect(sessionAllowRuleShapeOf('Bash', { command: 'npm run:*' })).toMatchObject({
      kind: 'unruleable',
    });
    expect(sessionAllowRuleShapeOf('Bash', { command: 'a\nb' })).toMatchObject({
      kind: 'unruleable',
      reason: '改行を含む',
    });
    expect(sessionAllowRuleShapeOf('Bash', { command: 'a\rb' })).toMatchObject({
      kind: 'unruleable',
      reason: '改行を含む',
    });
    expect(sessionAllowRuleShapeOf('Bash', { command: 3 })).toMatchObject({
      kind: 'unruleable',
      reason: 'command が文字列でない',
    });
  });

  it('Bash 以外の道具は対象にしない', () => {
    expect(sessionAllowRuleShapeOf('Edit', { command: 'x' })).toEqual({ kind: 'not-bash' });
    expect(sessionAllowRuleShapeOf(undefined, { command: 'x' })).toEqual({ kind: 'not-bash' });
  });
});

describe('一時規則の一覧（#4905）', () => {
  const grant = (rule: string, expiresAt: number) => ({
    rule,
    expiresAt,
    grantActor: 'manager:mgr-1',
    inputHead: undefined,
  });

  it('印を付けた呼び出しの決着で1回だけ外れ、同じ規則の他の印も消える', () => {
    const book = new SessionAllowRuleBook();
    book.add(grant('Bash(echo a)', 100));
    const mark = (toolUseId: string, useActor: string) =>
      book.markUse({
        toolUseId,
        toolName: 'Bash',
        toolInput: { command: 'echo a' },
        useActor,
        nowMs: 0,
      });
    expect(mark('t1', 'worker:mgr-1:worker')).toBe(true);
    expect(mark('t2', 'manager:mgr-1')).toBe(true);

    expect(book.settleUse('t1')).toMatchObject({ useActor: 'worker:mgr-1:worker' });
    expect(book.rules()).toEqual([]);
    expect(book.settleUse('t2')).toBeUndefined();
  });

  it('期限ちょうどは過ぎた側に入れる', () => {
    const book = new SessionAllowRuleBook();
    book.add(grant('Bash(echo a)', 100));
    book.add(grant('Bash(echo b)', 101));
    expect(
      book.markUse({
        toolUseId: 't1',
        toolName: 'Bash',
        toolInput: { command: 'echo a' },
        useActor: 'manager:mgr-1',
        nowMs: 100,
      }),
    ).toBe(false);
    expect(book.sweepExpired(100).map((g) => g.rule)).toEqual(['Bash(echo a)']);
    expect(book.rules()).toEqual(['Bash(echo b)']);
  });
});
