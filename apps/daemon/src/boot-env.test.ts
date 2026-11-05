import { describe, expect, it } from 'vitest';

import { bindHostnameOf, workspaceOf } from './boot-env.js';

describe('bindHostnameOf', () => {
  it('置かれた値はそのまま使う', () => {
    expect(bindHostnameOf({ ALTEROID_BIND: '0.0.0.0' }, '127.0.0.1')).toBe('0.0.0.0');
  });

  it.each([undefined, '', '   ', '\t\n'])('置かれていない（%j）なら既定に倒れる', (value) => {
    expect(bindHostnameOf({ ALTEROID_BIND: value }, '127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('workspaceOf', () => {
  it('置かれた値はそのまま使う', () => {
    expect(workspaceOf({ ALTEROID_WORKSPACE: '/work' }, '/cwd')).toBe('/work');
  });

  it.each([undefined, '', '   ', '\t\n'])('置かれていない（%j）なら cwd に倒れる', (value) => {
    expect(workspaceOf({ ALTEROID_WORKSPACE: value }, '/cwd')).toBe('/cwd');
  });
});
