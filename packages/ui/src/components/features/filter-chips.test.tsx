// @vitest-environment jsdom
/**
 * `FilterChips` の選択の渡し方。
 *
 * 既定は `onChange` に「次の選択の配列」を渡す。`onToggle` / `onClear` は省略可能な口で、
 * 渡した操作では `onChange` の代わりに「押された1つ」／「解除」だけを渡す（正本が URL の
 * 画面が、押した時点の値から次を作れるように）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilterChips } from './filter-chips';

afterEach(cleanup);

const OPTIONS = [{ value: 'a' }, { value: 'b' }, { value: 'c' }] as const;

describe('FilterChips', () => {
  it('既定: チップを押すと次の配列を onChange に渡す（追加・除外）', () => {
    const onChange = vi.fn();
    render(<FilterChips label="絞る" options={OPTIONS} selected={['a']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('既定: 解除は onChange([]) で、選択が無い間は解除のボタンが出ない', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FilterChips label="絞る" options={OPTIONS} selected={[]} onChange={onChange} />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(3);
    rerender(<FilterChips label="絞る" options={OPTIONS} selected={['a']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('onToggle を渡すと、押された1つだけを渡し、onChange は呼ばない', () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    render(
      <FilterChips
        label="絞る"
        options={OPTIONS}
        selected={['a']}
        onChange={onChange}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onToggle.mock.calls).toEqual([['b'], ['a']]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('onClear を渡すと、解除で onClear を呼び、onChange は呼ばない', () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(
      <FilterChips
        label="絞る"
        options={OPTIONS}
        selected={['a']}
        onChange={onChange}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('onToggle だけ渡した場合、解除は onChange([]) のまま（口ごとに独立）', () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        label="絞る"
        options={OPTIONS}
        selected={['a']}
        onChange={onChange}
        onToggle={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
