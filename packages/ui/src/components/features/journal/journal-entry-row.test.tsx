// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { JournalEntryRow } from './journal-entry-row';

afterEach(cleanup);

const base = {
  atLabel: '09-30 05:45',
  type: 'decision',
  summary: '要旨',
  raw: { type: 'decision', id: 'd-1' },
};

describe('JournalEntryRow: time', () => {
  it('time を渡すと、その位置に差し込む（<time> と Tab の停止点は出さない）', () => {
    const { container } = render(<JournalEntryRow {...base} time="たった今" />);
    expect(container.querySelector('time')).toBeNull();
    expect(container.querySelector('[tabindex]')).toBeNull();
    expect(screen.getByText('たった今')).toBeTruthy();
  });
});

describe('JournalEntryRow: rawBar', () => {
  function open() {
    fireEvent.click(screen.getByRole('button', { expanded: false }));
  }

  it('既定: 開くと生の中身の上に種別の名前と「写す」ボタンを出す', () => {
    render(<JournalEntryRow {...base} />);
    expect(screen.getAllByText('decision')).toHaveLength(1);
    open();
    expect(screen.getAllByText('decision')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /写す/ })).toBeTruthy();
  });

  it('rawBar={false}: 帯を出さない。種別の文字は増えず、写すボタンも無く、中身の JSON は出る', () => {
    const { container } = render(<JournalEntryRow {...base} rawBar={false} />);
    open();
    expect(screen.getAllByText('decision')).toHaveLength(1);
    expect(screen.queryByText('写す')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(base.raw, null, 2));
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('閉じている間は、どちらでも生の中身を出さない', () => {
    const { container } = render(<JournalEntryRow {...base} rawBar={false} />);
    expect(container.querySelector('pre')).toBeNull();
  });
});

describe('JournalEntryRow: 構造（#2756 / #2775）', () => {
  it('要旨は開閉の button の外にある（button の中の文字は Chromium でドラッグ選択できない）', () => {
    render(<JournalEntryRow {...base} summary="選べる要旨" />);
    const summary = screen.getByText('選べる要旨');
    expect(summary.closest('button')).toBeNull();
    expect(screen.getByRole('button', { expanded: false }).textContent).not.toContain('選べる要旨');
  });

  it('要旨を押しても開閉しない（選択のためのクリックで開閉が動かない）', () => {
    render(<JournalEntryRow {...base} summary="選べる要旨" />);
    fireEvent.click(screen.getByText('選べる要旨'));
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
  });

  it('スマホ幅では要旨を2段目に回して3行まで折り返し、sm 以上で1行 truncate に戻る', () => {
    render(<JournalEntryRow {...base} />);
    const cls = screen.getByTestId('journal-row-summary').className;
    expect(cls).toContain('line-clamp-3');
    expect(cls).toContain('w-full');
    expect(cls).toContain('sm:truncate');
    expect(cls).toContain('sm:flex-1');
  });
});
