// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BarList } from './bar-list';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BarList', () => {
  it('同じ表示名の2行も、id があれば別々に出て key の警告が出ない', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <BarList
        items={[
          { id: 'a', label: '同名（aaaa）', value: 2 },
          { id: 'b', label: '同名（bbbb）', value: 1 },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('同名（aaaa）')).toBeTruthy();
    expect(screen.getByText('同名（bbbb）')).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
  });

  it('同じ表示名で id が無いと key が重なる（id を渡す理由）', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <BarList
        items={[
          { label: '同名', value: 2 },
          { label: '同名', value: 1 },
        ]}
      />,
    );
    expect(error).toHaveBeenCalled();
  });

  it('id が無ければ表示名が key になる（従来どおり）', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <BarList
        items={[
          { label: 'opus', value: 2 },
          { label: 'sonnet', value: 1 },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
  });
});
