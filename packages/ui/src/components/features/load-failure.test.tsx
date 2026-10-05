// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisplayTextProvider } from '@/lib/display-text';

import { LoadFailure } from './load-failure';

afterEach(cleanup);

describe('LoadFailure', () => {
  it('何を読めなかったかを主文に、生の文は「詳細」の中に出す', () => {
    render(
      <LoadFailure
        title="日報を読み込めませんでした"
        summary="デーモンの側で処理に失敗しました。"
        detail="HTTP 500: boom"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('日報を読み込めませんでした');
    const details = alert.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('HTTP 500: boom');
    // 主文（details の外）に生の文は出ない
    const outside = alert.cloneNode(true) as HTMLElement;
    outside.querySelector('details')?.remove();
    expect(outside.textContent).not.toContain('boom');
  });

  it('onRetry があれば「もう一度試す」が取り直しを呼び、retrying の間は押せない', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<LoadFailure title="t" summary="s" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<LoadFailure title="t" summary="s" onRetry={onRetry} retrying />);
    expect(
      (screen.getByRole('button', { name: 'もう一度試す' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('onRetry が無ければボタンを出さない', () => {
    render(<LoadFailure title="t" summary="s" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('余白の className は帯ではなく外側の枠に付く（帯が親の右端からはみ出さない）', () => {
    render(<LoadFailure title="t" summary="s" className="m-4" />);
    const alert = screen.getByRole('alert');
    expect(alert.className).not.toContain('m-4');
    expect(alert.parentElement?.className).toContain('m-4');
  });

  it('詳細は表示用の変換（伏せ字）を通る', () => {
    render(
      <DisplayTextProvider value={{ body: (t) => t, error: (t) => t.replace('secret', '***') }}>
        <LoadFailure title="t" summary="s" detail="token=secret" />
      </DisplayTextProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain('token=***');
    expect(screen.getByRole('alert').textContent).not.toContain('secret');
  });
});
