import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultRoot } from './paths.js';

describe('defaultRoot', () => {
  it('置かれた ALTEROID_HOME をそのまま使う', () => {
    expect(defaultRoot({ ALTEROID_HOME: '/data/alteroid' })).toBe('/data/alteroid');
  });

  it.each([undefined, '', '   ', '\t\n'])(
    '置かれていない（%j）なら ~/.alteroid に倒れる（空白だけを置き場の名前にしない）',
    (value) => {
      expect(defaultRoot({ ALTEROID_HOME: value })).toBe(join(homedir(), '.alteroid'));
    },
  );
});
