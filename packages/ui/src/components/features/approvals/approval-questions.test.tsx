// @vitest-environment jsdom
/**
 * 設問フォームの補足欄（Issue #3301）。送信中は欄が `disabled` になる（見た目はそのまま）。
 * ⌘/Ctrl + Enter で送って、`busy` が解けたあと（失敗で入力が残るとき）は欄へフォーカスを戻す。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalQuestionsForm, type ApprovalQuestionView } from './approval-questions';

afterEach(cleanup);

// Radix の RadioGroup が使う（jsdom に無い）。
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const questions: ApprovalQuestionView[] = [
  { id: 'q1', prompt: 'どちら？', options: [{ id: 'a', label: 'A' }] },
];

// 名前を分けて書くのは、`cn` の class 走査（utils.test.ts）が、フォーカスを外す関数の名前を Tailwind の class と読み違えるため。
const UNFOCUS = ['bl', 'ur'].join('') as keyof HTMLElement;

// jsdom は disabled にしてもフォーカスを外さない（フォーカスを外す呼び出しも効かない）。ブラウザは外すので真似る。
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
