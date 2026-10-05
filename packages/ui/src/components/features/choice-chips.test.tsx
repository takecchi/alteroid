// @vitest-environment jsdom
/**
 * `ChoiceChips`（単一選択）。常にちょうど1つが選ばれ、解除は無い。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChoiceChips } from './choice-chips';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Radix の roving focus は次のチップへの focus を setTimeout(0) で行う。偽の時計で進める。
const arrow = (key: 'ArrowRight' | 'ArrowLeft') => {
  fireEvent.keyDown(document.activeElement!, { key });
  act(() => {
    vi.runAllTimers();
  });
};

const OPTIONS = [
  { value: 'a', label: 'エー' },
  { value: 'b', label: 'ビー' },
  { value: 'c' },
] as const;

const checkedStates = () => screen.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'));

describe('ChoiceChips', () => {
  it('押すと、その値を onChange に渡す', () => {
    const onChange = vi.fn();
    render(<ChoiceChips label="窓" options={OPTIONS} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'ビー' }));
    expect(onChange.mock.calls).toEqual([['b']]);
  });

  it('選択中を押しても外れない（onChange は呼ばれず、選択は残り、解除のボタンも無い）', () => {
    const onChange = vi.fn();
    render(<ChoiceChips label="窓" options={OPTIONS} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'エー' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(checkedStates()).toEqual(['true', 'false', 'false']);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('矢印キーで隣へ動き、動いた先が選ばれる（端は回り込む）', () => {
    const onChange = vi.fn();
    render(<ChoiceChips label="窓" options={OPTIONS} value="a" onChange={onChange} />);
    vi.useFakeTimers();
    screen.getByRole('radio', { name: 'エー' }).focus();
    arrow('ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'ビー' }));
    arrow('ArrowLeft');
    arrow('ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  it('支援技術向け: radiogroup に名前があり、選択中だけ aria-checked=true', () => {
    render(<ChoiceChips label="集計の窓" options={OPTIONS} value="b" onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: '集計の窓' })).toBeTruthy();
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
  });

  it('label が無い選択肢は value を表示する', () => {
    render(<ChoiceChips label="窓" options={OPTIONS} value="a" onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'c' })).toBeTruthy();
  });

  it('知らない値が value に来ても落ちない（どれも選ばれず、押せば選び直せる）', () => {
    const onChange = vi.fn();
    render(<ChoiceChips label="窓" options={OPTIONS} value={'zzz' as 'a'} onChange={onChange} />);
    expect(checkedStates()).toEqual(['false', 'false', 'false']);
    fireEvent.click(screen.getByRole('radio', { name: 'ビー' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('ChoiceChips の寸法', () => {
  it('タッチ（pointer: coarse）では 44px（min-h-11）まで広がる', () => {
    render(<ChoiceChips label="窓" options={OPTIONS} value="a" onChange={() => {}} />);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.className).toContain('min-h-7');
      expect(radio.className).toContain('pointer-coarse:min-h-11');
    }
  });
});
