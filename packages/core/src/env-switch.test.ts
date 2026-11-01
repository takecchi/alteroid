import { describe, expect, it } from 'vitest';

import { isEnvOffSpelling, readEnvSwitch } from './env-switch.js';

describe('環境変数の「止める」綴り', () => {
  it('周期の変数でも on/off の変数でも、同じ綴りが止める綴りとして読める（大文字小文字は問わない）', () => {
    for (const spelling of ['off', 'none', 'false', '0', 'no', 'disabled', 'OFF', 'Disabled']) {
      expect(isEnvOffSpelling(spelling)).toBe(true);
      expect(readEnvSwitch({ KEY: ` ${spelling} ` }, 'KEY', true)).toEqual({ enabled: false });
    }
  });

  it('止める綴りでない値は止める綴りとして読まない', () => {
    for (const spelling of ['on', '1', '60', 'yes', 'offf']) {
      expect(isEnvOffSpelling(spelling)).toBe(false);
    }
  });
});
