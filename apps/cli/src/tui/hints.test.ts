import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import {
  HINT_INPUT,
  HINT_MGR_CONFIRM,
  HINT_MGR_DETAIL,
  HINT_MGR_INPUT,
  HINT_MGR_LIST,
  HINT_NAV,
  HINT_PICKER,
  HINT_QUITTING,
} from './hints.js';

describe('フッタのキーヒント', () => {
  it('どれも 80 桁の端末で切れない（1 行で読み切れる）', () => {
    for (const hint of [
      HINT_INPUT,
      HINT_NAV,
      HINT_PICKER,
      HINT_QUITTING,
      HINT_MGR_LIST,
      HINT_MGR_DETAIL,
      HINT_MGR_INPUT,
      HINT_MGR_CONFIRM,
    ]) {
      expect(stringWidth(hint)).toBeLessThanOrEqual(80);
    }
  });
});
