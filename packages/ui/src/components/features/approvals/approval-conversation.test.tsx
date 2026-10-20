// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ApprovalConversation,
  clipMessageText,
  type ApprovalConversationMessage,
} from './approval-conversation';

afterEach(cleanup);

function messages(count: number): ApprovalConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? 'inbound' : 'outbound',
    text: `発言${index + 1}`,
  }));
}

describe('clipMessageText', () => {
  it('行数と文字数の内に収まる本文は、そのまま返す', () => {
    expect(clipMessageText('1\n2\n3\n4', 4, 200)).toEqual({ head: '1\n2\n3\n4', clipped: false });
  });

  it('行数を超えたら頭の行だけを返し、切ったことを「…」で示す', () => {
    expect(clipMessageText('1\n2\n3\n4\n5', 4, 200)).toEqual({
      head: '1\n2\n3\n4…',
      clipped: true,
    });
  });

  it('1行でも文字数を超えたら切る', () => {
    expect(clipMessageText('あ'.repeat(201), 4, 200)).toEqual({
      head: `${'あ'.repeat(200)}…`,
      clipped: true,
    });
  });
});

describe('ApprovalConversation: 直近の数件だけを出す', () => {
  it('既定は直近の3件だけを出し、取れた件数と「全部を見る」を出す', () => {
    render(<ApprovalConversation messages={messages(5)} reachedStart />);
    expect(screen.queryByText('発言1')).toBeNull();
    expect(screen.queryByText('発言2')).toBeNull();
    expect(screen.getByText('発言3')).toBeTruthy();
    expect(screen.getByText('発言5')).toBeTruthy();
    expect(screen.getByText('取れた 5 件のうち、直近の 3 件だけを出している')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '全部を見る（5 件）' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('「全部を見る」で取れた全部を古い順に出し、もう一度押すと直近だけへ戻す', () => {
    render(<ApprovalConversation messages={messages(5)} reachedStart />);
    fireEvent.click(screen.getByRole('button', { name: '全部を見る（5 件）' }));
    expect(
      screen
        .getAllByRole('listitem')
        .map((item) => item.textContent?.replace(/^(人間|クローン)/, '')),
    ).toEqual(['発言1', '発言2', '発言3', '発言4', '発言5']);

    fireEvent.click(screen.getByRole('button', { name: '直近の 3 件だけにする' }));
    expect(screen.queryByText('発言1')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('3件以下なら畳む操作を出さない', () => {
    render(<ApprovalConversation messages={messages(3)} reachedStart />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/直近の/)).toBeNull();
  });

  it('窓が先頭に届いていなければ、取れた発言だけだと断る（畳んでいても）', () => {
    render(<ApprovalConversation messages={messages(5)} reachedStart={false} />);
    expect(
      screen.getByText('窓が会話の先頭に届いていないので、取れた発言だけを出している'),
    ).toBeTruthy();
  });
});

describe('ApprovalConversation: 長い発言は頭だけを出す', () => {
  const long = Array.from({ length: 10 }, (_, index) => `行${index + 1}`).join('\n');

  it('長い発言は頭の行だけを出し、「続きを読む」で全文、「畳む」で頭へ戻す', () => {
    render(
      <ApprovalConversation messages={[{ id: 'm1', role: 'outbound', text: long }]} reachedStart />,
    );
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('行4…');
    expect(item.textContent).not.toContain('行5');

    fireEvent.click(screen.getByRole('button', { name: '続きを読む' }));
    expect(item.textContent).toContain('行10');

    fireEvent.click(screen.getByRole('button', { name: '畳む' }));
    expect(item.textContent).not.toContain('行5');
  });

  it('短い発言には「続きを読む」を出さない', () => {
    render(<ApprovalConversation messages={messages(1)} reachedStart />);
    expect(screen.queryByRole('button', { name: '続きを読む' })).toBeNull();
  });

  it('添付の注記は、本文を切っても消さない', () => {
    render(
      <ApprovalConversation
        messages={[{ id: 'm1', role: 'inbound', text: long, note: '［添付 1件: a.png］' }]}
        reachedStart
      />,
    );
    expect(screen.getByText('［添付 1件: a.png］')).toBeTruthy();
  });
});
