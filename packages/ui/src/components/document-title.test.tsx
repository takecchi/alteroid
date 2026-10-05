// @vitest-environment jsdom
/**
 * タブの題名（#2754）。h1 を描く部品が同じ文字列から題名も出し、画面が入れ替わると追従する。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { formatDocumentTitle } from './document-title';
import { ChatHeader } from './features/chat/chat-header';
import { ScreenState } from './layout/screen-state';
import { Page } from './page';

afterEach(cleanup);

describe('document.title', () => {
  it('Page の title が文字列なら、h1 と同じ文字列で「<画面名> - alteroid」になる', () => {
    const { getByRole } = render(<Page title="承認待ち">本文</Page>);
    expect(document.title).toBe('承認待ち - alteroid');
    expect(getByRole('heading', { level: 1 }).textContent).toBe('承認待ち');
    expect(formatDocumentTitle('承認待ち')).toBe(document.title);
  });

  it('title が部品のときは documentTitle を使い、無ければ題名を出さない', () => {
    render(
      <Page title={<span>記憶 / x</span>} documentTitle="x - 記憶">
        本文
      </Page>,
    );
    expect(document.title).toBe('x - 記憶 - alteroid');
    cleanup();
    render(<Page title={<span>記憶 / x</span>}>本文</Page>);
    expect(document.title).not.toContain('x - 記憶');
  });

  it('画面が入れ替わると題名も入れ替わる（SPA の遷移）', () => {
    const { rerender } = render(<Page title="日誌">a</Page>);
    expect(document.title).toBe('日誌 - alteroid');
    rerender(<Page title="記憶">b</Page>);
    expect(document.title).toBe('記憶 - alteroid');
  });

  it('ScreenState と ChatHeader も h1 と同じ題名を出す', () => {
    render(<ScreenState title="デーモンに繋がらない" />);
    expect(document.title).toBe('デーモンに繋がらない - alteroid');
    cleanup();
    const { getByRole } = render(<ChatHeader conversationId={undefined} />);
    expect(document.title).toBe(`${getByRole('heading', { level: 1 }).textContent} - alteroid`);
  });
});
