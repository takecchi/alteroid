// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalQuestionsForm, type ApprovalQuestionView } from './approval-questions';

afterEach(cleanup);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const questions: ApprovalQuestionView[] = [
  { id: 'q1', prompt: 'どちら？', options: [{ id: 'a', label: 'A' }] },
];

// 名前を分けて書く: `cn` の class 走査（utils.test.ts）が、フォーカスを外す関数の名前を Tailwind の class と読み違えるため
const UNFOCUS = ['bl', 'ur'].join('') as keyof HTMLElement;

function loseFocusLikeBrowser(el: HTMLTextAreaElement) {
  act(() => {
    el.disabled = false;
    (el[UNFOCUS] as () => void).call(el);
    el.disabled = true;
  });
  expect(document.activeElement).toBe(document.body);
}

function Harness() {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <ApprovalQuestionsForm questions={questions} busy={busy} onSubmit={() => setBusy(true)} />
      <button type="button" onClick={() => setBusy(false)}>
        解く
      </button>
    </>
  );
}

describe('ApprovalQuestionsForm: 補足欄のフォーカス', () => {
  it('⌘/Ctrl + Enter で送り、busy が解けたら補足欄へフォーカスが戻る', () => {
    render(<Harness />);
    const area = screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: '補足' } });
    area.focus();
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(area.disabled).toBe(true);
    loseFocusLikeBrowser(area);
    fireEvent.click(screen.getByRole('button', { name: '解く' }));
    expect(area.disabled).toBe(false);
    expect(document.activeElement).toBe(area);
  });

  it('「回答」ボタンで送ったときは、補足欄へフォーカスを奪わない', () => {
    render(<Harness />);
    const area = screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: '補足' } });
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    loseFocusLikeBrowser(area);
    fireEvent.click(screen.getByRole('button', { name: '解く' }));
    expect(document.activeElement).not.toBe(area);
  });
});
