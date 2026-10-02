// @vitest-environment jsdom
/**
 * 画面の部品が、本文と error の文を描画の直前に伏せ字へ通す（issue #2600）。
 *
 * 偽のトークンが出力から消え、40桁の sha は残る。データ（props）は書き換えない。
 * 伏せる関数は `@alteroid/ui` の外（apps/web の `WebDisplayTextProvider`）から渡る。
 */
import { cleanup, fireEvent, render as baseRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovalCard,
  ApprovalQuestionsForm,
  ChatMessage,
  ErrorNote,
  JournalEntryRow,
} from '@alteroid/ui';

import { WebDisplayTextProvider } from '~/lib/display-text';

/** 本番の root と同じ provider で包んで描く。 */
const render = (ui: ReactElement) => baseRender(ui, { wrapper: WebDisplayTextProvider });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 偽のトークン（本物ではない）。 */
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const BODY = `x ${TOKEN} y ${SHA}`;

function expectRedacted(container: HTMLElement): void {
  expect(container.textContent).not.toContain(TOKEN);
  expect(container.textContent).toContain(SHA);
}

describe('会話', () => {
  it.each(['human', 'clone', 'system'] as const)('ChatMessage（%s）', (role) => {
    const { container } = render(<ChatMessage role={role} text={BODY} />);
    expectRedacted(container);
  });

  it('版切り替えで出る畳まれた往復も伏せる', () => {
    const { container } = render(
      <ChatMessage
        role="human"
        text="いま"
        versions={{
          index: 0,
          total: 2,
          onPrevious: () => undefined,
          onNext: () => undefined,
          hidden: [{ role: 'clone', text: BODY }],
        }}
      />,
    );
    expectRedacted(container);
  });
});

describe('承認待ち', () => {
  it('question / context / answer', () => {
    const { container } = render(
      <ApprovalCard state="answered" question={BODY} context={BODY} answer={BODY} />,
    );
    expectRedacted(container);
    expect(container.textContent?.split(SHA).length).toBe(4);
  });

  it('withdrawnReason', () => {
    const { container } = render(
      <ApprovalCard state="withdrawn" question="q" withdrawnReason={BODY} />,
    );
    expectRedacted(container);
  });

  it('設問の prompt / label / description', () => {
    // jsdom に無い（radix の選択肢が測る）。測った値は使わないので何もしない実装で足りる。
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const { container } = render(
      <ApprovalQuestionsForm
        questions={[
          {
            id: 'q1',
            prompt: BODY,
            options: [{ id: 'o1', label: BODY, description: BODY }],
          },
        ]}
        onSubmit={() => undefined}
      />,
    );
    expectRedacted(container);
    expect(container.textContent?.split(SHA).length).toBe(4);
  });

  it('回答欄（下書き）の値は書き換えない', () => {
    render(<ApprovalCard state="unanswered" question="q" draft={BODY} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(BODY);
  });
});

describe('日誌', () => {
  it('要旨と、開いた生の JSON', () => {
    const { container } = render(
      <JournalEntryRow
        atLabel="09-30 05:45"
        type="exchange"
        summary={BODY}
        raw={{ type: 'exchange', text: BODY }}
      />,
    );
    expectRedacted(container);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expectRedacted(container);
    expect(container.textContent?.split(SHA).length).toBe(3);
  });
});

describe('error の文', () => {
  it('ErrorNote（Error）', () => {
    const { container } = render(<ErrorNote error={new Error(`401 ${TOKEN}`)} />);
    expect(container.textContent).not.toContain(TOKEN);
  });

  it('ErrorNote（文字列）', () => {
    const { container } = render(<ErrorNote error={`boom ${TOKEN}`} />);
    expect(container.textContent).not.toContain(TOKEN);
  });
});
