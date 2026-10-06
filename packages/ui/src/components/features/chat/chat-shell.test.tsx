// @vitest-environment jsdom
/**
 * `ConversationList` / `ChatHeader` / `ChatComposer` の省略可能な口と、その既定。
 *
 * 口は `newConversationTabStop` だけ（画面が従来の Tab の順路を保つために足した）。
 * **口を渡さないときの振る舞いは変えていない**——既定の側もここで押さえる。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './chat-composer';
import { ChatHeader } from './chat-header';
import { ConversationList, type ConversationRenderLink } from './conversation-list';

afterEach(cleanup);

const renderLink: ConversationRenderLink = (target, slot) => (
  <a href={`#${target.id ?? 'new'}`} className={slot.className || undefined}>
    {slot.children}
  </a>
);

const items = [
  { id: 'a', preview: '選んでいる', updatedLabel: '3 分前', messages: 4 },
  { id: 'b', preview: '別の会話', updatedLabel: '昨日', messages: 2 },
];

function row(preview: string): HTMLElement {
  const link = screen.getByText(preview).closest('a');
  if (link === null) throw new Error('行が見つからない');
  return link;
}

describe('ConversationList: 行の見た目（既定）', () => {
  it('発言数を data-numeric で包み、選択中は lumen-edge bg-accent', () => {
    render(<ConversationList items={items} activeId="a" renderLink={renderLink} />);
    const active = row('選んでいる');
    expect(active.querySelector('[data-numeric]')?.textContent).toBe('4');
    expect(active.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['lumen-edge', 'bg-accent', 'transition-colors', 'hover:bg-muted']),
    );
    expect(row('別の会話').className.split(/\s+/)).not.toContain('lumen-edge');
  });
});

describe('ConversationList: 新しい会話のボタン', () => {
  it('既定: Tab の順路から外す（tabindex=-1）', () => {
    render(<ConversationList items={items} activeId={undefined} renderLink={renderLink} />);
    expect(screen.getByRole('button', { name: '新しい会話' }).getAttribute('tabindex')).toBe('-1');
  });

  it('newConversationTabStop を真にすると、tabindex を付けない', () => {
    render(
      <ConversationList
        items={items}
        activeId={undefined}
        renderLink={renderLink}
        newConversationTabStop
      />,
    );
    expect(screen.getByRole('button', { name: '新しい会話' }).hasAttribute('tabindex')).toBe(false);
  });
});

describe('ConversationList: 枠・空・但し書き', () => {
  it('inDrawer では枠と幅を持たない。広い画面では w-64 と border-r', () => {
    const { container, rerender } = render(
      <ConversationList items={items} activeId="a" renderLink={renderLink} />,
    );
    expect(container.querySelector('aside')?.className).toContain('w-64');
    rerender(<ConversationList items={items} activeId="a" renderLink={renderLink} inDrawer />);
    expect(container.querySelector('aside')?.className).not.toContain('w-64');
    expect(container.querySelector('aside')?.className).toContain('min-h-0');
  });

  it('0件・未取得は「まだ会話がない。」、notes は1件ずつ <p>', () => {
    const { rerender } = render(
      <ConversationList items={[]} activeId={undefined} renderLink={renderLink} />,
    );
    expect(screen.getByText('まだ会話がない。')).toBeTruthy();
    rerender(
      <ConversationList
        items={undefined}
        activeId={undefined}
        renderLink={renderLink}
        notes={['一つ目', '二つ目']}
      />,
    );
    expect(screen.getByText('まだ会話がない。')).toBeTruthy();
    expect(screen.getByText('一つ目').tagName).toBe('P');
    expect(screen.getByText('二つ目').tagName).toBe('P');
  });

  it('取得に失敗して1件も読めていない（unavailable）ときは「まだ会話がない。」を出さない（#2323）', () => {
    const { rerender } = render(
      <ConversationList
        items={undefined}
        activeId={undefined}
        renderLink={renderLink}
        error={new Error('失敗')}
        unavailable
      />,
    );
    expect(screen.queryByText('まだ会話がない。')).toBeNull();
    // 本当に0件で成功したときは、いままでどおり言う。
    rerender(<ConversationList items={[]} activeId={undefined} renderLink={renderLink} />);
    expect(screen.getByText('まだ会話がない。')).toBeTruthy();
  });
});

describe('ChatHeader', () => {
  it('見出し（h1）と題名は「会話」で、「クローンと話す」は見出しの下の説明に回る（#2844）', () => {
    render(<ChatHeader conversationId="c" subtitle="10/01 10:00 に開始" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('会話');
    expect(document.title).toBe('会話 - alteroid');
    expect(screen.getByText(/クローンと話す/).tagName).toBe('P');
    expect(screen.getByText('10/01 10:00 に開始')).toBeTruthy();
  });

  it('会話が無ければ操作は出ず、「新しい会話」と出る。決まっていれば2つの操作（id は出さない）', () => {
    const { rerender } = render(
      <ChatHeader
        conversationId={undefined}
        onInterrupt={() => undefined}
        onEnd={() => undefined}
      />,
    );
    expect(screen.getByText('新しい会話')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <ChatHeader conversationId="conv_1" onInterrupt={() => undefined} onEnd={() => undefined} />,
    );
    expect(screen.queryByText('conv_1')).toBeNull();
    expect(screen.getByRole('button', { name: 'クローンのターンを止める' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '会話を終える' })).toBeTruthy();
  });

  it('subtitle を渡すと見出しの下に出す。「会話を終える」は確認を挟み、「終える」で初めて onEnd を呼ぶ', () => {
    const onEnd = vi.fn();
    render(
      <ChatHeader conversationId="c" subtitle="10/01 10:00 に開始 · 発言 8 件" onEnd={onEnd} />,
    );
    expect(screen.getByText('10/01 10:00 に開始 · 発言 8 件')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '会話を終える' }));
    expect(onEnd).not.toHaveBeenCalled();
    expect(screen.getByText(/学びを記憶にまとめます/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '終える' }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('帯と notice は同じ safe-area の余白を持つ', () => {
    const { container } = render(<ChatHeader conversationId="c" notice="止めた" />);
    const header = container.querySelector('header');
    const notice = screen.getByText('止めた');
    for (const element of [header, notice]) {
      const classes = (element?.className ?? '').split(/\s+/);
      expect(classes).toContain('pl-[calc(1rem+var(--safe-left))]');
      expect(classes).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');
    }
  });

  it('onOpenList を渡したときだけ「会話一覧を開く」を出す', () => {
    const onOpenList = vi.fn();
    const { rerender } = render(<ChatHeader conversationId="c" />);
    expect(screen.queryByRole('button', { name: '会話一覧を開く' })).toBeNull();
    rerender(<ChatHeader conversationId="c" onOpenList={onOpenList} />);
    fireEvent.click(screen.getByRole('button', { name: '会話一覧を開く' }));
    expect(onOpenList).toHaveBeenCalledTimes(1);
  });
});

describe('ChatComposer', () => {
  function composer(props: Partial<React.ComponentProps<typeof ChatComposer>> = {}): {
    onSend: ReturnType<typeof vi.fn>;
    band: HTMLElement;
  } {
    const onSend = vi.fn();
    render(
      <ChatComposer value="こんにちは" onChange={() => undefined} onSend={onSend} {...props} />,
    );
    const textbox = screen.getByRole('textbox');
    const band = textbox.closest('[data-slot="chat-composer-frame"]')?.parentElement;
    if (band === undefined || band === null) throw new Error('帯が見つからない');
    return { onSend, band };
  }

  it('帯に bg-background と縦横の safe-area を持つ', () => {
    const { band } = composer();
    const classes = band.className.split(/\s+/);
    expect(classes).toContain('bg-background');
    expect(classes).toContain('pb-[calc(0.75rem+var(--safe-bottom))]');
  });

  it('Ctrl + Enter（Mac 以外）で送る。Enter 単体・Shift + Enter・IME の確定の Enter では送らない', () => {
    const { onSend } = composer();
    const textbox = screen.getByRole('textbox');
    fireEvent.keyDown(textbox, { key: 'Enter' });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('受信中は「受信をやめる」を「送る」と並べて出し、但し書きも出す', () => {
    composer({ sending: true, onStopReceiving: () => undefined });
    expect(
      screen.getByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
    expect(screen.getByText(/画面を閉じてもクローンは考え続ける/)).toBeTruthy();
  });

  it('空の下書きでは送信ボタンが押せない', () => {
    composer({ value: '  ' });
    expect(
      (screen.getByRole('button', { name: 'メッセージを送信' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('ChatComposer: 入力に合わせて高さが伸びる', () => {
  // jsdom は寸法を計算しないので、scrollHeight をテキストの行数から返す。
  function stubHeights(lineHeight: number) {
    const proto = HTMLTextAreaElement.prototype;
    vi.spyOn(proto, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
      return Math.max(2, this.value.split('\n').length) * lineHeight;
    });
  }
  afterEach(() => vi.restoreAllMocks());

  function box(value: string) {
    const ui = (v: string) => (
      <ChatComposer value={v} onChange={() => undefined} onSend={() => undefined} />
    );
    const view = render(ui(value));
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    return { el, update: (v: string) => view.rerender(ui(v)) };
  }

  it('行が増えると高さが伸び、空に戻すと元の高さに戻る', () => {
    stubHeights(24);
    const { el, update } = box('');
    expect(el.style.height).toBe('48px');
    update(Array.from({ length: 10 }, () => 'a').join('\n'));
    expect(el.style.height).toBe('240px');
    update('');
    expect(el.style.height).toBe('48px');
  });

  it('上限は CSS の max-height で掛かり、超えた分は内側をスクロールする', () => {
    stubHeights(24);
    const { el } = box(Array.from({ length: 30 }, () => 'a').join('\n'));
    expect(el.style.height).toBe('720px'); // 測った高さはそのまま入れ、止めるのは max-height
    const classes = el.className.split(/\s+/);
    expect(el.style.maxHeight.replace(/\s/g, '')).toBe('min(40dvh,15rem)');
    expect(classes).toContain('overflow-y-auto');
  });

  it('リサイズのつまみを出さない（resize-none が resize-y に負けない）', () => {
    const { el } = box('');
    const classes = el.className.split(/\s+/);
    expect(classes).toContain('resize-none');
    expect(classes).not.toContain('resize-y');
  });
});
