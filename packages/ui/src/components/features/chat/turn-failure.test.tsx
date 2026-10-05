// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChatTurnFailure,
  classifyTurnFailure,
  TURN_FAILURE_COPY,
  TurnFailureNote,
} from './turn-failure';

afterEach(cleanup);

const LOGIN_MESSAGE =
  '結果なしで終了: success（result_is_error） / Not logged in · Please run /login';

describe('classifyTurnFailure', () => {
  it('認証切れ・上限・その他を分ける', () => {
    expect(classifyTurnFailure(LOGIN_MESSAGE)).toBe('auth');
    expect(
      classifyTurnFailure('結果なしで終了: authentication_failed（assistant_error） / x'),
    ).toBe('auth');
    expect(classifyTurnFailure("You've hit your org's monthly spend limit")).toBe('quota');
    expect(classifyTurnFailure('something broke')).toBe('other');
    // 混雑は利用者の上限ではない（「利用上限に当たっていて」は嘘になる）。
    expect(classifyTurnFailure('API Error: Overloaded')).toBe('other');
    expect(classifyTurnFailure('結果なしで終了: overloaded（assistant_error） / x')).toBe('other');
    expect(classifyTurnFailure('結果なしで終了: rate_limit（assistant_error） / x')).toBe('quota');
  });
});

describe('TurnFailureNote', () => {
  it('利用者向けの1文を出し、生の文は「詳細」の中に畳む', () => {
    render(<TurnFailureNote message={LOGIN_MESSAGE} />);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.auth.what))).toBeTruthy();
    const details = screen.getByText('詳細').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('result_is_error');
    // 帯の本文（詳細の外）に内部の語は出ない。
    const visible = document.querySelector('p')?.textContent ?? '';
    expect(visible).not.toMatch(/result_is_error|success|\/login/);
  });

  it('認証切れのときだけ導線を差し込む', () => {
    const action = (kind: string) =>
      kind === 'auth' ? <a href="#t">認証トークンの画面を開く</a> : null;
    const { rerender } = render(<TurnFailureNote message={LOGIN_MESSAGE} action={action} />);
    expect(screen.getByRole('link', { name: '認証トークンの画面を開く' })).toBeTruthy();
    rerender(<TurnFailureNote message="other failure" action={action} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('ChatTurnFailure', () => {
  const noticeText = 'この発言には返せなかった（ターンが失敗した）。';

  it('失敗: エラーの見た目で、onRetry があるときだけ「もう一度送る」を出す', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ChatTurnFailure kind="failed" text={noticeText} onRetry={onRetry} />,
    );
    expect(document.querySelector('[data-turn-failure="failed"]')?.className).toContain(
      'border-destructive',
    );
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送る' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // 内部の語（ターン）は詳細の外に出ない。
    expect(screen.getByText('この発言には返事を作れませんでした。').textContent).not.toContain(
      'ターン',
    );
    rerender(<ChatTurnFailure kind="failed" text={noticeText} />);
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
  });

  it('保持: 再送は出さない（枠が開けばクローンが自分で試し直す）', () => {
    render(
      <ChatTurnFailure kind="held" text="いま利用上限に当たっている。" onRetry={() => undefined} />,
    );
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
    expect(screen.getByText('いま利用上限に当たっている。')).toBeTruthy();
  });
});
