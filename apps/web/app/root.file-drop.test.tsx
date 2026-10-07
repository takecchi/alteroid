// @vitest-environment jsdom
/**
 * ウィンドウへのファイルのドロップ（issue #3780）。
 *
 * 入力欄の外にファイルを落とすと、ブラウザの既定の動作（そのタブでファイルを開く）が走って
 * アプリを離れる。`App` がウィンドウで `Files` を含む `dragover` / `drop` だけ止める。
 * 文字のドラッグは止めない。入力欄へのドロップは今までどおり添付になる。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '@alteroid/ui';

import App from './root';

afterEach(cleanup);

const onAttach = vi.fn();

function mount() {
  onAttach.mockClear();
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: App,
        children: [
          {
            index: true,
            Component: () => (
              <>
                <div data-testid="outside">会話の履歴</div>
                <ChatComposer value="" onChange={() => {}} onSend={() => {}} onAttach={onAttach} />
              </>
            ),
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

function dataTransfer(types: string[], files: File[] = []) {
  return { types, files } as unknown as DataTransfer;
}

/** イベントを投げる。戻りは「既定の動作が止められなかった」（= `defaultPrevented` でない）か。 */
function fire(type: 'dragover' | 'drop', target: Element, types?: string[]) {
  const init = types === undefined ? undefined : { dataTransfer: dataTransfer(types) };
  return type === 'drop' ? fireEvent.drop(target, init) : fireEvent.dragOver(target, init);
}

describe('ウィンドウへのファイルのドロップ', () => {
  for (const type of ['dragover', 'drop'] as const) {
    it(`${type}: 入力欄の外でも Files を含むなら既定の動作を止める`, () => {
      mount();
      const notPrevented = fire(type, screen.getByTestId('outside'), ['Files']);
      expect(notPrevented).toBe(false);
    });

    it(`${type}: 文字のドラッグ（Files を含まない）は止めない`, () => {
      mount();
      const notPrevented = fire(type, screen.getByTestId('outside'), ['text/plain']);
      expect(notPrevented).toBe(true);
    });

    it(`${type}: dataTransfer が無いイベントでも落ちず、止めない`, () => {
      mount();
      expect(fire(type, screen.getByTestId('outside'))).toBe(true);
    });
  }

  it('入力欄へのドロップは今までどおり添付になる', () => {
    mount();
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const target = screen.getByPlaceholderText('クローンに話しかける');
    const notPrevented = fireEvent.drop(target, {
      dataTransfer: dataTransfer(['Files'], [file]),
    });
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach).toHaveBeenCalledWith([file]);
    expect(notPrevented).toBe(false);
  });

  it('アンマウントすると止めなくなる', () => {
    mount();
    cleanup();
    const el = document.body.appendChild(document.createElement('div'));
    expect(fireEvent.drop(el, { dataTransfer: dataTransfer(['Files']) })).toBe(true);
    el.remove();
  });
});
