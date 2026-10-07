// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatMessage, ChatMessageList, type ChatRole } from './chat-message';
import { ChatMessageEditor } from './chat-message-editor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatMessageList / ChatMessage: 描き分け', () => {
  it('list は「やりとり」、行は li。人間・system は素のテキスト、クローンだけ Markdown', () => {
    render(
      <ChatMessageList>
        <ChatMessage role="human" text="**打ったまま**" />
        <ChatMessage role="clone" text="**太字**" />
        <ChatMessage role="system" text="**事情**" />
      </ChatMessageList>,
    );
    const list = screen.getByRole('list', { name: 'やりとり' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('**打ったまま**').className.split(/\s+/)).toEqual(
      expect.arrayContaining(['break-words', 'whitespace-pre-wrap']),
    );
    expect(within(list).getByText('**事情**').className.split(/\s+/)).toContain('break-words');
    expect(within(list).getByText('太字').tagName).toBe('STRONG');
  });

  it('クローンの本文が空なら「…」', () => {
    render(<ChatMessage role="clone" text="" />);
    expect(screen.getByText('…')).toBeTruthy();
  });

  it('知らない役割の行が来ても落ちない（素のテキストで出す）', () => {
    render(
      <ChatMessageList>
        <ChatMessage role={'manager' as unknown as ChatRole} text="**未知**" />
      </ChatMessageList>,
    );
    const text = screen.getByText('**未知**');
    expect(text.closest('li')).not.toBeNull();
    expect(text.className.split(/\s+/)).toContain('whitespace-pre-wrap');
  });

  it('transient の行も本文の文字列で引ける', () => {
    render(<ChatMessage role="system" text="考えている…" transient />);
    expect(screen.getByText('考えている…')).toBeTruthy();
  });
});

describe('ChatMessage: 編集の入口', () => {
  it('指だけの端末（pointer: coarse）では鉛筆を薄く出す。マウスのホバーで出す振る舞いは残す（#3403）', () => {
    render(<ChatMessage role="human" text="やあ" onEdit={() => {}} />);
    const classes = screen.getByRole('button', { name: '発言を編集' }).className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        'opacity-0',
        'group-hover:opacity-100',
        'pointer-coarse:opacity-60',
        'pointer-coarse:group-focus-within:opacity-100',
      ]),
    );
  });

  it('hasDraft のときは、鉛筆を常に見せ、名前で書きかけを知らせる（#3565）', () => {
    const { rerender } = render(<ChatMessage role="human" text="やあ" onEdit={() => {}} />);
    expect(screen.queryByRole('button', { name: /書きかけ/ })).toBeNull();
    rerender(<ChatMessage role="human" text="やあ" onEdit={() => {}} hasDraft />);
    const button = screen.getByRole('button', { name: '発言を編集（書きかけあり）' });
    expect(button.className.split(/\s+/)).toContain('opacity-100');
  });

  it('onEdit を渡したときだけ鉛筆が出る。編集中（children）は出ない', () => {
    const onEdit = vi.fn();
    const { rerender } = render(<ChatMessage role="human" text="やあ" />);
    expect(screen.queryByRole('button', { name: '発言を編集' })).toBeNull();
    rerender(<ChatMessage role="human" text="やあ" onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: '発言を編集' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    rerender(
      <ChatMessage role="human" text="やあ" onEdit={onEdit}>
        <span>下書き</span>
      </ChatMessage>,
    );
    expect(screen.queryByRole('button', { name: '発言を編集' })).toBeNull();
    expect(screen.getByText('下書き')).toBeTruthy();
    expect(screen.queryByText('やあ')).toBeNull();
  });
});

describe('ChatMessage: 版の切り替え', () => {
  const hidden = [
    { role: 'human' as const, text: '旧本文' },
    { role: 'clone' as const, text: '旧応答' },
  ];

  it('最新では畳まれた往復を出さず、前へ戻ると出す。端では押せない', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <ChatMessage
        role="human"
        text="新"
        versions={{ index: 1, total: 2, onPrevious, onNext, hidden }}
      />,
    );
    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.queryByText('旧応答')).toBeNull();
    expect((screen.getByRole('button', { name: '次の版へ' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));
    expect(onPrevious).toHaveBeenCalledTimes(1);

    rerender(
      <ChatMessage
        role="human"
        text="旧"
        versions={{ index: 0, total: 2, onPrevious, onNext, hidden }}
      />,
    );
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('旧応答')).toBeTruthy();
    expect(screen.getByText('人間')).toBeTruthy();
    expect(screen.getByText('クローン')).toBeTruthy();
    expect((screen.getByRole('button', { name: '前の版へ' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '次の版へ' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('編集中は版の切り替えを隠す', () => {
    render(
      <ChatMessage
        role="human"
        text="新"
        versions={{ index: 1, total: 2, onPrevious: vi.fn(), onNext: vi.fn() }}
      >
        <span>下書き</span>
      </ChatMessage>,
    );
    expect(screen.queryByText('2/2')).toBeNull();
  });
});

describe('ChatMessageEditor: キー操作', () => {
  function setup(value = '下書き') {
    const onChange = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ChatMessageEditor
        value={value}
        onChange={onChange}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return {
      box: screen.getByLabelText('発言を編集する下書き'),
      onChange,
      onConfirm,
      onCancel,
    };
  }

  it('Ctrl+Enter で確定、Escape でやめる、素の Enter では何もしない', () => {
    const { box, onConfirm, onCancel } = setup();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('IME の変換中の Escape（isComposing / keyCode 229）では閉じない（#3394）', () => {
    const { box, onCancel } = setup();
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('IME の変換を確定する Enter（isComposing / keyCode 229）では確定しない', () => {
    const { box, onConfirm } = setup();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('空白だけでは確定できない（ボタンも無効）', () => {
    const { box, onConfirm } = setup('   ');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '確定' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('キャンセルのボタンで onCancel', () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ChatMessage: 範囲選択と編集欄の大きさ（実寸は jsdom で測れないのでクラスで固定）', () => {
  const classes = (el: Element) => el.className.split(/\s+/);

  it('人間の吹き出しは選択を潰さず、選択色が地（bg-primary）に溶けない', () => {
    render(<ChatMessage role="human" text="選べる本文" onEdit={() => undefined} />);
    const bubble = screen.getByText('選べる本文');
    const all = [bubble, ...Array.from(bubble.querySelectorAll('*'))];
    for (let up: Element | null = bubble; up !== null; up = up.parentElement) all.push(up);
    for (const el of all) {
      expect(classes(el)).not.toContain('select-none');
      expect(el.className).not.toMatch(/user-select|pointer-events-none/);
      expect(el.getAttribute('draggable')).toBeNull();
    }
    expect(classes(bubble)).toEqual(
      expect.arrayContaining(['bg-primary', 'selection:bg-primary-foreground']),
    );
  });

  it('クローンの本文にも選択を潰す指定は無い', () => {
    render(<ChatMessage role="clone" text="応答" />);
    const li = screen.getByText('応答').closest('li')!;
    for (const el of [li, ...Array.from(li.querySelectorAll('*'))]) {
      expect(classes(el)).not.toContain('select-none');
    }
  });

  it('編集中は外側が読む幅の上限まで広がり、吹き出しがそれを埋める', () => {
    render(
      <ChatMessage role="human" text="やあ" onEdit={() => undefined}>
        <span>下書き</span>
      </ChatMessage>,
    );
    const bubble = screen.getByText('下書き').closest('[data-role]')!;
    expect(classes(bubble)).toContain('flex-1');
    expect(classes(bubble.parentElement!)).toEqual(
      expect.arrayContaining(['w-full', 'max-w-[46rem]']),
    );
  });

  it('編集欄は幅いっぱい・本文に合わせて伸びる（scrollHeight から決め、上限は 60vh）', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      return this.value.split('\n').length * 20;
    });
    const { rerender } = render(
      <ChatMessageEditor value="1行" onChange={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(classes(area)).toContain('w-full');
    expect(classes(area)).toEqual(
      expect.arrayContaining(['bg-background', 'dark:bg-background', 'text-foreground']),
    );
    expect(classes(area)).not.toContain('dark:bg-input/30');
    expect(area.style.maxHeight).toBe('60vh');
    expect(area.style.height).toBe('20px');
    rerender(
      <ChatMessageEditor
        value={'a\nb\nc\nd\ne'}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(area.style.height).toBe('100px');
  });
});
