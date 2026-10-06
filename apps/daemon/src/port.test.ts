import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, resolvePort } from './port.js';

const of = (value: string | undefined) =>
  resolvePort(value === undefined ? {} : { ALTEROID_PORT: value });

describe('resolvePort（#3582）', () => {
  it.each([undefined, '', ' ', '\t\n  '])('未設定・空・空白だけ（%j）は既定', (value) => {
    expect(of(value)).toEqual({ ok: true, port: DEFAULT_PORT });
    expect(DEFAULT_PORT).toBe(4517);
  });

  it.each([
    ['8080', 8080],
    [' 8080 ', 8080],
    ['1', 1],
    ['65535', 65535],
    ['04517', 4517],
  ])('1〜65535 の整数 %j はそのまま', (value, port) => {
    expect(of(value)).toEqual({ ok: true, port });
  });

  it.each([
    'abc',
    '12ab',
    '1.5',
    '1e3',
    '0x50',
    '+80',
    '-1',
    '0',
    '00',
    '65536',
    '99999999999999999999',
    'NaN',
    'Infinity',
  ])('読めない・範囲外 %j は断る', (value) => {
    const result = of(value);
    expect(result.ok).toBe(false);
  });

  it('断る文言に、受け取った値と直し方（1〜65535 の整数・未設定なら 4517）が出る', () => {
    const result = of('abc');
    if (result.ok) throw new Error('断るはず');
    expect(result.message).toContain('ALTEROID_PORT="abc"');
    expect(result.message).toContain('1〜65535');
    expect(result.message).toContain('未設定');
    expect(result.message).toContain('4517');
  });

  it('表示する値の制御文字はエスケープされ、長い値は切り詰められる', () => {
    const control = of('a\nb\u001b[31m\u2028c');
    if (control.ok) throw new Error('断るはず');
    expect(control.message).not.toMatch(/[\u0000-\u001f\u2028\u2029]/);
    expect(control.message).toContain('\\u000a');
    expect(control.message).toContain('\\u001b');

    const long = of('9'.repeat(5000) + 'x');
    if (long.ok) throw new Error('断るはず');
    expect(long.message.length).toBeLessThan(300);
    expect(long.message).toContain('5001');
  });
});
