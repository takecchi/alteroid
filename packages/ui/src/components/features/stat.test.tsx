// @vitest-environment jsdom
/**
 * `<Stat>` の数字の書体（#2843）。装飾の書体（`font-display`、Michroma）は 0 と O が
 * 同じ形で、件数・金額・id を読み違える。数字は本文の書体の等幅数字（`tabular-nums`）で出す。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Stat } from './stat';

afterEach(() => {
  cleanup();
});

describe('Stat の数字の書体', () => {
  it('数字は font-display にならず、桁の揃う tabular-nums で出る', () => {
    const { container } = render(<Stat label="件数" value="100" unit="件" />);
    const value = container.querySelector('[data-numeric]');
    expect(value?.textContent).toBe('100');
    const tokens = (value?.className ?? '').split(/\s+/);
    expect(tokens).not.toContain('font-display');
    expect(tokens).toContain('tabular-nums');
  });
});
