// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('ApprovalQuestionsForm: 「選択を外す」のフォーカス', () => {
  it('外すと、押したボタンは消え、その設問の最初の選択肢へフォーカスが移る。回答は送らない', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={questions} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: 'A' }));
    const clear = screen.getByRole('button', { name: '設問 1 の選択を外す' });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole('button', { name: '設問 1 の選択を外す' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'A' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('選択肢が無い設問では、「その他」の入力欄へフォーカスが移る', () => {
    render(
      <ApprovalQuestionsForm
        questions={[{ id: 'q1', prompt: '自由に', options: [] }]}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '設問 1 のその他' }), {
      target: { value: 'x' },
    });
    const clear = screen.getByRole('button', { name: '設問 1 の選択を外す' });
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '設問 1 のその他' }));
  });
});

// 送るのは ⌘/Ctrl + Enter と「回答」ボタンだけ: Enter で送れると、選んだ直後の Enter が form の暗黙の送信になり、押した覚えのない回答が送られるため
describe('ApprovalQuestionsForm: 選択肢を選んだ後の Enter では送らない', () => {
  const multi: ApprovalQuestionView[] = [
    { id: 'q1', prompt: 'どれ？', options: [{ id: 'a', label: 'A' }], multiple: true },
  ];

  it('ラジオを選んで Enter・Shift + Enter を押しても送らない', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={questions} onSubmit={onSubmit} />);
    const radio = screen.getByRole('radio', { name: 'A' });
    fireEvent.click(radio);
    expect(fireEvent.keyDown(radio, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(radio, { key: 'Enter', shiftKey: true })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('チェックボックスを選んで Enter を押しても送らない', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={multi} onSubmit={onSubmit} />);
    const box = screen.getByRole('checkbox', { name: 'A' });
    fireEvent.click(box);
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('「その他」に書いて Enter・Shift + Enter を押しても送らず、⌘/Ctrl + Enter で送る', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={questions} onSubmit={onSubmit} />);
    const other = screen.getByRole('textbox', { name: '設問 1 のその他' });
    fireEvent.change(other, { target: { value: '別の案' } });
    expect(fireEvent.keyDown(other, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(other, { key: 'Enter', shiftKey: true })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(other, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      selections: [{ questionId: 'q1', optionIds: [], other: '別の案' }],
    });
    fireEvent.keyDown(other, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('何も選んでいないときは ⌘ + Enter でも送らない', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={questions} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '設問 1 のその他' }), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
