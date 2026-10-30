// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { cutAt, WindowedText, WINDOWED_TEXT_CHUNK_CHARS } from './windowed-text';

afterEach(cleanup);

// 窓の幅は props では変えられないので、既定の窓（WINDOWED_TEXT_CHUNK_CHARS）を何度かまたぐ長さにする
const lines = (count: number) => Array.from({ length: count }, (_, i) => `L${i}`).join('\n');
const LONG_LINES = 60_000;

describe('cutAt', () => {
  it('行の切れ目（改行の直後）で切る', () => {
    expect(cutAt('aaaa\nbbbb\ncccc', 0, 7)).toBe(5);
  });
  it('切れ目が窓の半分より前にしか無ければ硬く切る', () => {
    expect(cutAt('a\nbbbbbbbbbbbb', 0, 10)).toBe(10);
  });
  it('残りが窓に収まるなら末尾まで', () => {
    expect(cutAt('abc', 0, 10)).toBe(3);
  });
});

describe('WindowedText', () => {
  it('短ければ全部を出し、続きのボタンは無い', () => {
    render(<WindowedText text="abc" testId="t" />);
    expect(screen.getByTestId('t').textContent).toBe('abc');
    expect(screen.queryByText('続きを表示')).toBeNull();
    expect(screen.getByText('全体を表示しています（3 文字）')).toBeTruthy();
  });

  it('totalNote が在れば、出し終えた表示の括弧へ入る', () => {
    render(<WindowedText text="abc" totalNote="3 B" />);
    expect(screen.getByText('全体を表示しています（3 B）')).toBeTruthy();
  });

  it('長ければ先頭の窓だけ出し、「続きを表示」で伸びて、最後はボタンが消える', () => {
    const text = lines(LONG_LINES);
    render(<WindowedText text={text} testId="t" />);
    const first = screen.getByTestId('t').textContent ?? '';
    expect(first.length).toBeLessThanOrEqual(WINDOWED_TEXT_CHUNK_CHARS);
    expect(text.startsWith(first)).toBe(true);
    expect(screen.getByText(/全体 [\d,]+ 文字を表示しています/)).toBeTruthy();

    let previous = first.length;
    for (let guard = 0; guard < 100 && screen.queryByText('続きを表示'); guard += 1) {
      fireEvent.click(screen.getByText('続きを表示'));
      const now = screen.getByTestId('t').textContent ?? '';
      expect(now.length).toBeGreaterThan(previous);
      expect(text.startsWith(now)).toBe(true);
      previous = now.length;
    }
    expect(screen.getByTestId('t').textContent).toBe(text);
    expect(screen.queryByText('続きを表示')).toBeNull();
  });

  it('text が入れ替わっても、広げた窓は縮まない', () => {
    const text = lines(LONG_LINES);
    const { rerender } = render(<WindowedText text={text} testId="t" />);
    fireEvent.click(screen.getByText('続きを表示'));
    const widened = (screen.getByTestId('t').textContent ?? '').length;
    rerender(<WindowedText text={`${text}\nlast`} testId="t" />);
    expect((screen.getByTestId('t').textContent ?? '').length).toBe(widened);
  });

  it('text が縮んだら上限だけ詰める', () => {
    const { rerender } = render(<WindowedText text={lines(LONG_LINES)} testId="t" />);
    fireEvent.click(screen.getByText('続きを表示'));
    rerender(<WindowedText text="short" testId="t" />);
    expect(screen.getByTestId('t').textContent).toBe('short');
    expect(screen.queryByText('続きを表示')).toBeNull();
  });
});
