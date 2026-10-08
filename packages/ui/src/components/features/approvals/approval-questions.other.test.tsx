// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalQuestionsForm, type ApprovalQuestionView } from './approval-questions';

afterEach(cleanup);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const single: ApprovalQuestionView = {
  id: 'q1',
  prompt: 'どちら？',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
};

const multiple: ApprovalQuestionView = { ...single, id: 'q2', multiple: true };

const OTHER_NAME = '設問 1 のその他';
const OTHER_RADIO_NAME = '設問 1 のその他を選ぶ';
const NOT_WRITTEN = 'その他を選んだが、まだ書いていない';
const NOT_SENT = /その他は選ばれていないので、この文字は送られない/;

describe('ApprovalQuestionsForm: 単一選択の「その他」と選択肢の食い違い', () => {
  it('「その他」に書いたあと選択肢を選んでも、書いた文字は消さず、送られないと言う', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={[single]} onSubmit={onSubmit} />);
    const other = screen.getByRole('textbox', { name: OTHER_NAME }) as HTMLInputElement;
    fireEvent.change(other, { target: { value: '自由記述' } });
    expect(screen.queryByText(NOT_SENT)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'A' }));

    expect(other.value).toBe('自由記述');
    expect(screen.getByText(NOT_SENT)).toBeTruthy();
    expect(other.getAttribute('aria-describedby')).toBe(screen.getByText(NOT_SENT).id);
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onSubmit).toHaveBeenCalledWith({ selections: [{ questionId: 'q1', optionIds: ['a'] }] });
  });

  it('選択肢のあとで「その他」へ戻すと、残してあった文字がそのまま送られる', () => {
    const onSubmit = vi.fn();
    render(<ApprovalQuestionsForm questions={[single]} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole('textbox', { name: OTHER_NAME }), {
      target: { value: '自由記述' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'A' }));
    fireEvent.click(screen.getByRole('radio', { name: OTHER_RADIO_NAME }));

    expect(screen.queryByText(NOT_SENT)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onSubmit).toHaveBeenCalledWith({
      selections: [{ questionId: 'q1', optionIds: [], other: '自由記述' }],
    });
  });

  it('「その他」だけ選んで空のときは、入力欄の近くで「まだ書いていない」と言う', () => {
    render(<ApprovalQuestionsForm questions={[single]} onSubmit={() => {}} />);
    expect(screen.queryByText(NOT_WRITTEN)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: OTHER_RADIO_NAME }));

    const note = screen.getByText(NOT_WRITTEN);
    expect(screen.getByRole('textbox', { name: OTHER_NAME }).getAttribute('aria-describedby')).toBe(
      note.id,
    );
  });

  it('空白だけを書いた「その他」も、まだ書いていないと言う', () => {
    render(<ApprovalQuestionsForm questions={[single]} onSubmit={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: OTHER_NAME }), {
      target: { value: '   ' },
    });
    expect(screen.getByText(NOT_WRITTEN)).toBeTruthy();
  });

  it('「その他」に書いたら、まだ書いていないとは言わない', () => {
    render(<ApprovalQuestionsForm questions={[single]} onSubmit={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: OTHER_RADIO_NAME }));
    fireEvent.change(screen.getByRole('textbox', { name: OTHER_NAME }), {
      target: { value: '自由記述' },
    });
    expect(screen.queryByText(NOT_WRITTEN)).toBeNull();
    expect(screen.queryByText(NOT_SENT)).toBeNull();
  });

  it('複数選択では、どちらの案内も出さない（その他は選択肢と併用できる）', () => {
    render(<ApprovalQuestionsForm questions={[{ ...multiple, id: 'q1' }]} onSubmit={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: OTHER_NAME }), {
      target: { value: '自由記述' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    expect(screen.queryByText(NOT_WRITTEN)).toBeNull();
    expect(screen.queryByText(NOT_SENT)).toBeNull();
  });
});
