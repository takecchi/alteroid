// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';

afterEach(cleanup);

const base = {
  state: 'unanswered' as const,
  createdAt: '2026-09-29T20:06:00Z',
  createdLabel: '42 分前',
  question: '進めてよいか',
};

describe('ApprovalCard: time', () => {
  it('既定: Timestamp（相対の表示を <time dateTime> で）を出す', () => {
    const { container } = render(<ApprovalCard {...base} />);
    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-09-29T20:06:00.000Z');
    expect(time?.textContent).toBe('42 分前');
  });

  it('time を渡すと、その位置に差し込み、Timestamp は出さない', () => {
    const { container } = render(
      <ApprovalCard
        {...base}
        time={
          <>
            <span>2026/09/29 20:06</span>
            <span>(42 分前)</span>
          </>
        }
      />,
    );
    expect(container.querySelector('time')).toBeNull();
    expect(screen.getByText('2026/09/29 20:06')).toBeTruthy();
    expect(screen.getByText('(42 分前)')).toBeTruthy();
  });

  it('time を渡すなら createdAt / createdLabel は要らない', () => {
    const { container } = render(<ApprovalCard state="unanswered" question="q" time="いま" />);
    expect(screen.getByText('いま')).toBeTruthy();
    expect(container.querySelector('time')).toBeNull();
  });
});

describe('ApprovalCard: 送るキー', () => {
  function typeAndPress(init: KeyboardEventInit & { isComposing?: boolean }, props = {}) {
    const onSubmit = vi.fn();
    render(<ApprovalCard {...base} draft="答え" onSubmit={onSubmit} {...props} />);
    fireEvent.keyDown(screen.getByRole('textbox'), init);
    return onSubmit;
  }

  it('既定: ⌘/Ctrl + Enter で送る', () => {
    expect(typeAndPress({ key: 'Enter', ctrlKey: true })).toHaveBeenCalledWith('答え');
    cleanup();
    expect(typeAndPress({ key: 'Enter', metaKey: true })).toHaveBeenCalledWith('答え');
  });

  it('既定: 修飾キー無しの Enter・IME の確定の Enter では送らない', () => {
    expect(typeAndPress({ key: 'Enter' })).not.toHaveBeenCalled();
    cleanup();
    expect(typeAndPress({ key: 'Enter', ctrlKey: true, isComposing: true })).not.toHaveBeenCalled();
  });

  it('空の回答・送信中は、ショートカットでも送らない（ボタンの disabled と同じ条件）', () => {
    expect(typeAndPress({ key: 'Enter', ctrlKey: true }, { draft: '  ' })).not.toHaveBeenCalled();
    cleanup();
    expect(typeAndPress({ key: 'Enter', ctrlKey: true }, { busy: true })).not.toHaveBeenCalled();
  });
});

describe('ApprovalCard: trailing と error の順序', () => {
  it('trailing は error の後ろ（いちばん下）に出る', () => {
    render(
      <ApprovalCard
        {...base}
        footer={<p>footer</p>}
        error={<p>error</p>}
        trailing={<p>trailing</p>}
      />,
    );
    const order = ['footer', 'error', 'trailing'].map((t) => screen.getByText(t));
    expect(
      order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('error を渡さなければ余白の箱を出さない', () => {
    const { container } = render(<ApprovalCard {...base} />);
    const empty = Array.from(container.querySelectorAll('div.mt-2')).filter(
      (box) => box.childElementCount === 0,
    );
    expect(empty).toHaveLength(0);
  });
});

// description は `aria-describedby` の指す要素の文字から読む: jest-dom は ui の依存に無いため
describe('ApprovalCard: どの確認への操作かの区別', () => {
  function descriptionOf(el: HTMLElement): string {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((i) => i !== '');
    return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  }

  it('2件並ぶと、回答欄と「許可」の description / 回答欄の名前が、各カードの確認の文になる', () => {
    render(
      <>
        <ApprovalCard {...base} question="本番へデプロイしてよいか" />
        <ApprovalCard {...base} question="古いブランチを消してよいか" />
      </>,
    );
    const boxes = screen.getAllByRole('textbox');
    const allows = screen.getAllByRole('button', { name: '許可' });
    expect(boxes).toHaveLength(2);
    expect(allows).toHaveLength(2);
    expect(boxes[0]?.getAttribute('aria-label')).toBe('「本番へデプロイしてよいか」への回答');
    expect(boxes[1]?.getAttribute('aria-label')).toBe('「古いブランチを消してよいか」への回答');
    expect(screen.getByRole('textbox', { name: /デプロイ/ })).toBe(boxes[0]);
    expect(descriptionOf(boxes[0] as HTMLElement)).toBe('本番へデプロイしてよいか');
    expect(descriptionOf(boxes[1] as HTMLElement)).toBe('古いブランチを消してよいか');
    expect(descriptionOf(allows[0] as HTMLElement)).toBe('本番へデプロイしてよいか');
    expect(descriptionOf(allows[1] as HTMLElement)).toBe('古いブランチを消してよいか');
    for (const name of ['却下', '回答する']) {
      const buttons = screen.getAllByRole('button', { name });
      expect(buttons.map((b) => descriptionOf(b))).toEqual([
        '本番へデプロイしてよいか',
        '古いブランチを消してよいか',
      ]);
    }
  });

  it('長い確認の文は、回答欄の名前では冒頭だけにする', () => {
    render(<ApprovalCard {...base} question={`${'あ'.repeat(40)}\n2行目`} />);
    expect(screen.getByRole('textbox').getAttribute('aria-label')).toBe(
      `「${'あ'.repeat(30)}…」への回答`,
    );
  });

  it('設問つき: 「選択肢を開いて答える」と「回答」が各カードの確認の文に結ばれる', () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const questions = [{ id: 'q1', prompt: 'どちら？', options: [{ id: 'a', label: 'A' }] }];
    render(
      <>
        <ApprovalCard {...base} question="一つ目の確認" questions={questions} />
        <ApprovalCard {...base} question="二つ目の確認" questions={questions} />
      </>,
    );
    const opens = screen.getAllByRole('button', { name: '選択肢を開いて答える' });
    expect(opens.map((b) => descriptionOf(b))).toEqual(['一つ目の確認', '二つ目の確認']);
    const submits = screen.getAllByRole('button', { name: '回答', hidden: true });
    expect(submits.map((b) => descriptionOf(b))).toEqual(['一つ目の確認', '二つ目の確認']);
  });
});
