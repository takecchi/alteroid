// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatTurnFailure, TURN_FAILURE_COPY, TurnFailureNote } from './turn-failure';

afterEach(cleanup);

const LOGIN_MESSAGE =
  '結果なしで終了: success（result_is_error） / Not logged in · Please run /login';

const authLink = (kind: string) =>
  kind === 'auth' ? <a href="#t">認証トークンの画面を開く</a> : null;

describe('TurnFailureNote', () => {
  it('利用者向けの1文を出し、生の文は「詳細」の中に畳む', () => {
    render(<TurnFailureNote kind="auth" message={LOGIN_MESSAGE} />);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.auth.what))).toBeTruthy();
    const details = screen.getByText('詳細').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('result_is_error');
    const visible = document.querySelector('p')?.textContent ?? '';
    expect(visible).not.toMatch(/result_is_error|success|\/login/);
  });

  it('認証切れのときだけ導線を差し込む', () => {
    const { rerender } = render(
      <TurnFailureNote kind="auth" message={LOGIN_MESSAGE} action={authLink} />,
    );
    expect(screen.getByRole('link', { name: '認証トークンの画面を開く' })).toBeTruthy();
    rerender(<TurnFailureNote kind="other" message="other failure" action={authLink} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('案内は kind だけで決める（本文に 401 や上限の語があっても other は一般の案内）', () => {
    const { rerender } = render(
      <TurnFailureNote kind="other" message="HTTP 401 / usage limit / Not logged in" />,
    );
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.other.what))).toBeTruthy();
    expect(screen.queryByText(new RegExp(TURN_FAILURE_COPY.auth.what))).toBeNull();
    rerender(<TurnFailureNote kind="quota" message="x" />);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.quota.what))).toBeTruthy();
  });
});

describe('ChatTurnFailure（読み直した失敗）', () => {
  it('turnFailureKind の案内と導線を、受信中の帯と同じ形で出す', () => {
    render(<ChatTurnFailure kind="failed" failureKind="auth" text="x" action={authLink} />);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.auth.what))).toBeTruthy();
    expect(screen.getByRole('link', { name: '認証トークンの画面を開く' })).toBeTruthy();
  });

  it('本文に 401 の語があっても other なら一般の案内で、導線は出さない', () => {
    render(<ChatTurnFailure kind="failed" failureKind="other" text="HTTP 401" action={authLink} />);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.other.what))).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('ChatTurnFailure', () => {
  const noticeText = 'この発言には返せなかった（ターンが失敗した）。';

  it('失敗: エラーの見た目で、onRetry があるときだけ「もう一度送る」を出す', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ChatTurnFailure kind="failed" failureKind="other" text={noticeText} onRetry={onRetry} />,
    );
    expect(document.querySelector('[data-turn-failure="failed"]')?.className).toContain(
      'border-destructive',
    );
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送る' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.other.what)).textContent).not.toContain(
      'ターン',
    );
    rerender(<ChatTurnFailure kind="failed" failureKind="other" text={noticeText} />);
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
