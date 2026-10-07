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
    expect(classifyTurnFailure('API Error: Overloaded')).toBe('other');
    expect(classifyTurnFailure('結果なしで終了: overloaded（assistant_error） / x')).toBe('other');
    expect(classifyTurnFailure('結果なしで終了: rate_limit（assistant_error） / x')).toBe('quota');
  });
});

describe('classifyTurnFailure — 自由文の語だけでは決めない（#3953）', () => {
  it('本文の中の 401 / quota では認証・上限と言わない', () => {
    const head = '結果なしで終了: error_during_execution（result_subtype） / ';
    expect(classifyTurnFailure(`${head}port 8401 ... 401 files`)).toBe('other');
    expect(classifyTurnFailure(`${head}curl returned 401 from the tool`)).toBe('other');
    expect(classifyTurnFailure(`${head}disk quota exceeded`)).toBe('other');
    expect(classifyTurnFailure('EDQUOT: quota exceeded, write')).toBe('other');
    expect(classifyTurnFailure('tool said: not logged in to the registry')).toBe('other');
  });

  it('SDK の印（assistant.error の語・api_error_status）があれば分ける', () => {
    const via = (code: string, kind: string) => `結果なしで終了: ${code}（${kind}） / x`;
    expect(classifyTurnFailure(via('billing_error', 'assistant_error'))).toBe('quota');
    expect(classifyTurnFailure(via('error_during_execution/401', 'result_subtype'))).toBe('auth');
    expect(classifyTurnFailure(via('error_during_execution/429', 'result_subtype'))).toBe('quota');
  });

  it('印の語が本文側に在るだけなら分けない', () => {
    expect(
      classifyTurnFailure(
        '結果なしで終了: unknown（assistant_error） / authentication_failed in log',
      ),
    ).toBe('other');
  });
});

describe('TurnFailureNote', () => {
  it('利用者向けの1文を出し、生の文は「詳細」の中に畳む', () => {
    render(<TurnFailureNote message={LOGIN_MESSAGE} />);
    expect(screen.getByText(new RegExp(TURN_FAILURE_COPY.auth.what))).toBeTruthy();
    const details = screen.getByText('詳細').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('result_is_error');
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
