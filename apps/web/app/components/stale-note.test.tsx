// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StaleNote } from './stale-note';

afterEach(cleanup);

describe('StaleNote', () => {
  it('取り直せなかった対象だけを差し替え、続きは「下は前に読めたときのもの。」で固定する', () => {
    render(<StaleNote what="日報" />);

    expect(
      screen.getByText('最新の日報を取り直せなかった。下は前に読めたときのもの。'),
    ).toBeTruthy();
  });

  it('読み上げに届くよう role="status" を付け、色と大きさは警告の小さい字に固定する', () => {
    render(<StaleNote what="数" />);

    const note = screen.getByRole('status');
    expect(note.className).toContain('text-xs');
    expect(note.className).toContain('text-warn');
  });

  it('外側の余白は既定が mt-2 で、呼び元から差し替えられる（見た目の本体は変わらない）', () => {
    const { rerender } = render(<StaleNote what="予定" />);
    expect(screen.getByRole('status').className).toBe('mt-2 text-xs text-warn');

    rerender(<StaleNote what="予定" className="mx-4 mt-3" />);
    expect(screen.getByRole('status').className).toBe('mx-4 mt-3 text-xs text-warn');
  });
});
