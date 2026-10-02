// @vitest-environment jsdom
/**
 * 承認待ちの設問のフォーム（issue #2525）。部品は `@alteroid/ui` に在るが、Radix のラジオ・チェックが
 * `ResizeObserver` を要るので、jsdom の足場（`~/test-support`）を持つここに置く。単一はラジオ・複数はチェック、推奨の印と説明、
 * 「その他」（単一では選択肢と排他）、補足、何も無ければ送れない・未回答の設問があっても送れる。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '~/test-support';
import {
  ApprovalCard,
  ApprovalQuestionsForm,
  buildApprovalAnswer,
  summarizeApprovalQuestions,
  type ApprovalQuestionView,
} from '@alteroid/ui';

afterEach(cleanup);

const questions: ApprovalQuestionView[] = [
  {
    id: 'deploy',
    prompt: 'デプロイ先',
    options: [
      { id: 'railway', label: 'Railway', description: '今の本番と同じ', recommended: true },
      { id: 'fly', label: 'Fly.io' },
    ],
  },
  {
    id: 'notify',
    prompt: '通知先',
    multiple: true,
    options: [
      { id: 'slack', label: 'Slack' },
      { id: 'mail', label: 'メール' },
    ],
  },
  {
    id: 'closed',
    prompt: '固定の問い',
    allowOther: false,
    options: [{ id: 'yes', label: 'はい' }],
  },
];

function setup() {
  const onSubmit = vi.fn();
  render(<ApprovalQuestionsForm questions={questions} onSubmit={onSubmit} />);
  return onSubmit;
}

const send = () => screen.getByRole('button', { name: '回答' });

describe('ApprovalQuestionsForm', () => {
  it('単一はラジオ、複数はチェックで出し、推奨の印と description を添える', () => {
    setup();
    expect(screen.getAllByRole('radio', { name: /Railway|Fly\.io/ })).toHaveLength(2);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('推奨')).toBeTruthy();
    expect(screen.getByText('今の本番と同じ')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: /デプロイ先/ })).toBeTruthy();
  });

  it('その他は allowOther が false の設問には出ない', () => {
    setup();
    expect(screen.getByLabelText('設問 1 のその他')).toBeTruthy();
    expect(screen.getByLabelText('設問 2 のその他')).toBeTruthy();
    expect(screen.queryByLabelText('設問 3 のその他')).toBeNull();
  });

  it('何も選ばず、その他も補足も空なら「回答」は押せない', () => {
    const onSubmit = setup();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
    // 空白だけでも同じ。
    fireEvent.change(screen.getByLabelText('設問 1 のその他'), { target: { value: '  ' } });
    expect((send() as HTMLButtonElement).disabled).toBe(true);
  });

  it('補足だけでも送れる（selections は空）', () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByRole('textbox', { name: /補足/ }), {
      target: { value: 'ざっくりで' },
    });
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({ selections: [], supplement: 'ざっくりで' });
  });

  it('未回答の設問があっても送れる（答えた設問だけ載る）', () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByRole('radio', { name: /Railway/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Slack' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'メール' }));
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({
      selections: [
        { questionId: 'deploy', optionIds: ['railway'] },
        { questionId: 'notify', optionIds: ['slack', 'mail'] },
      ],
    });
  });

  it('複数選択のチェックは外せる', () => {
    const onSubmit = setup();
    const slack = screen.getByRole('checkbox', { name: 'Slack' });
    fireEvent.click(slack);
    fireEvent.click(slack);
    fireEvent.change(screen.getByRole('textbox', { name: /補足/ }), { target: { value: 'x' } });
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({ selections: [], supplement: 'x' });
  });

  it('単一選択の「その他」は選択肢と排他（書き始めると選択肢が外れ、選択肢を押すと外れる）', () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByRole('radio', { name: /Railway/ }));
    fireEvent.change(screen.getByLabelText('設問 1 のその他'), { target: { value: 'ただし来週' } });
    expect(screen.getByRole('radio', { name: /Railway/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith({
      selections: [{ questionId: 'deploy', optionIds: [], other: 'ただし来週' }],
    });

    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    fireEvent.click(send());
    // 書いたその他は、選択肢を選び直したら送らない。
    expect(onSubmit).toHaveBeenLastCalledWith({
      selections: [{ questionId: 'deploy', optionIds: ['fly'] }],
    });
  });

  it('複数選択の「その他」は選択肢と並べて送れる。補足も添える', () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Slack' }));
    fireEvent.change(screen.getByLabelText('設問 2 のその他'), { target: { value: 'LINE' } });
    fireEvent.change(screen.getByRole('textbox', { name: /補足/ }), {
      target: { value: '金曜は避けたい' },
    });
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({
      selections: [{ questionId: 'notify', optionIds: ['slack'], other: 'LINE' }],
      supplement: '金曜は避けたい',
    });
  });

  it('「選択を外す」で単一選択を未回答に戻せる', () => {
    setup();
    fireEvent.click(screen.getByRole('radio', { name: /Railway/ }));
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '設問 1 の選択を外す' }));
    expect((send() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('buildApprovalAnswer', () => {
  it('知らない選択肢 id は送らない', () => {
    const answer = buildApprovalAnswer(
      questions,
      { deploy: { chosen: ['ghost'], other: '', otherOn: false } },
      '',
    );
    expect(answer).toEqual({ selections: [] });
  });

  it('allowOther が false の設問の other は送らない', () => {
    const answer = buildApprovalAnswer(
      questions,
      { closed: { chosen: ['yes'], other: 'ほか', otherOn: false } },
      '',
    );
    expect(answer.selections).toEqual([{ questionId: 'closed', optionIds: ['yes'] }]);
  });
});

describe('ApprovalCard と設問', () => {
  const base = {
    state: 'unanswered' as const,
    createdAt: '2026-09-29T20:06:00Z',
    question: 'どうする',
  };

  it('一覧では設問を全文で出さず、要約1行と開くボタンだけ（開くまでフォームは見えない）', () => {
    render(<ApprovalCard {...base} questions={questions} />);
    expect(screen.getByText(summarizeApprovalQuestions(questions))).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    const open = screen.getByRole('button', { name: '選択肢を開いて答える' });
    fireEvent.click(open);
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
    // 普通の回答欄と許可・却下は出ない。
    expect(screen.queryByRole('button', { name: '許可' })).toBeNull();
    expect(screen.queryByPlaceholderText(/答える/)).toBeNull();
  });

  it('「回答」で onSubmitQuestions に一括で渡す', () => {
    const onSubmitQuestions = vi.fn();
    render(<ApprovalCard {...base} questions={questions} onSubmitQuestions={onSubmitQuestions} />);
    fireEvent.click(screen.getByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onSubmitQuestions).toHaveBeenCalledWith({
      selections: [{ questionId: 'deploy', optionIds: ['fly'] }],
    });
  });

  it('questions が無い・空なら、これまでの回答欄（許可・却下つき）のまま', () => {
    for (const q of [undefined, []]) {
      const { unmount } = render(<ApprovalCard {...base} questions={q} />);
      expect(screen.getByPlaceholderText(/答える/)).toBeTruthy();
      expect(screen.getByRole('button', { name: '許可' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '選択肢を開いて答える' })).toBeNull();
      unmount();
    }
  });

  it('回答済みなら設問は出さず、畳んだ文（answer）がそのまま読める', () => {
    render(
      <ApprovalCard
        {...base}
        state="answered"
        questions={questions}
        answer={'Q1 デプロイ先: (a) Railway［推奨］\nQ2 通知先: 未回答'}
      />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/Q1 デプロイ先: \(a\) Railway/)).toBeTruthy();
  });
});
