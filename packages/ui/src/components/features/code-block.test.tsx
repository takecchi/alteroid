// @vitest-environment jsdom
/**
 * `<CodeBlock>` の写しのタイマー（#3579）。写しの Promise が unmount の**後**に解決しても、
 * `done()` はタイマーを仕掛けず、状態も変えない。仕掛けると、テストが終わって環境が畳まれた後に
 * 発火して `window is not defined` の Unhandled Error になり、CI を赤くする。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeBlock } from './code-block';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function stubClipboard() {
  let resolve: () => void = () => {};
  let reject: (e: Error) => void = () => {};
  const writeText = vi.fn(
    () =>
      new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { resolve: () => resolve(), reject: (e: Error) => reject(e) };
}

describe('CodeBlock の写しのタイマー', () => {
  it('mounted のまま解決したら「写した」を出し、1600ms 後に戻す（対照）', async () => {
    const clip = stubClipboard();
    render(<CodeBlock>abc</CodeBlock>);
    fireEvent.click(screen.getByRole('button'));
    await act(async () => {
      clip.resolve();
    });
    expect(screen.getByText('写した')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText('写す')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmount の後に写しの Promise が解決しても、タイマーを仕掛けない', async () => {
    const clip = stubClipboard();
    const { unmount } = render(<CodeBlock>abc</CodeBlock>);
    fireEvent.click(screen.getByRole('button'));
    unmount();
    await act(async () => {
      clip.resolve();
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmount の後に写しの Promise が拒まれても、タイマーを仕掛けない', async () => {
    const clip = stubClipboard();
    const { unmount } = render(<CodeBlock>abc</CodeBlock>);
    fireEvent.click(screen.getByRole('button'));
    unmount();
    await act(async () => {
      clip.reject(new Error('denied'));
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
