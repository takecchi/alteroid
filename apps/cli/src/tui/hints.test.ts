import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import { HINT_INPUT, HINT_NAV, HINT_PICKER, HINT_QUITTING } from './hints.js';

describe('フッタのキーヒント', () => {
  it('どれも 80 桁の端末で切れない（1 行で読み切れる）', () => {
    for (const hint of [HINT_INPUT, HINT_NAV, HINT_PICKER, HINT_QUITTING]) {
      expect(stringWidth(hint)).toBeLessThanOrEqual(80);
    }
  });
});
