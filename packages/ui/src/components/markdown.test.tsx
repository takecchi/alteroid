// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Markdown } from './markdown';

afterEach(() => {
  cleanup();
});

describe('見出し・表・コードブロック', () => {
  it('## 見出し が見出し要素（h2）になる', async () => {
    render(<Markdown>{'## 見出し'}</Markdown>);

    const heading = await screen.findByRole('heading', { name: '見出し' });
    expect(heading.tagName).toBe('H2');
    expect(heading.classList.contains('sr-only')).toBe(false);
  });

  it('GFM の表が table 要素になる', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    render(<Markdown>{md}</Markdown>);

    const table = await screen.findByRole('table');
    expect(table.tagName).toBe('TABLE');
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('表は横スクロールの包みに入り、狭い画面ではセルが最小幅を持つ（#2805）', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '本文 `code`'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const table = await screen.findByRole('table');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
    const cell = screen.getByText('1');
    expect(cell.tagName).toBe('TD');
    expect(cell.className).toContain('max-lg:min-w-28');
    const paragraph = container.querySelector('p');
    expect(paragraph?.className ?? '').not.toContain('min-w-28');
  });

  it('コードフェンスの中身は逐語で保たれる（`**強調**` が強調にならない）', async () => {
    const md = ['```', '**not bold**', '```'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent?.trim()).toBe('**not bold**');
    expect(code?.querySelector('strong')).toBeNull();
  });

  it('言語無しのフェンス（罫線図のような複数行）も横スクロールの pre になる', async () => {
    const md = ['```', '┌──┐', '│  │', '└──┘', '```'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain('overflow-x-auto');
    expect(pre?.className).toContain('whitespace-pre');
    expect(pre?.textContent).toContain('┌──┐');
  });
});

describe('安全性: rehype-raw を入れていないこと', () => {
  it('生の HTML（img の onerror）が要素として解釈されず、テキストとして出る', async () => {
    const md = '本文中に <img src=x onerror="alert(1)"> が混ざる';
    const { container } = render(<Markdown>{md}</Markdown>);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('生の HTML（<script>）が要素として解釈されず、テキストとして出る', async () => {
    const md = '<script>alert(1)</script>';
    const { container } = render(<Markdown>{md}</Markdown>);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});

describe('安全性: javascript: リンクが実行可能な URL にならない', () => {
  it('href が空へ潰れる（react-markdown の defaultUrlTransform）', async () => {
    render(<Markdown>{'[click](javascript:alert(1))'}</Markdown>);

    // 役割ではなく属性を見る: testing-library は空文字の href を href 無しと扱い、link ロールを失うため
    const anchor = await screen.findByText('click');
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('');
  });

  it('http のリンクは潰れず、外部リンクとして開く', async () => {
    render(<Markdown>{'[click](https://example.com/path)'}</Markdown>);

    const link = await screen.findByRole('link', { name: 'click' });
    expect(link.getAttribute('href')).toBe('https://example.com/path');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('文中のリンクは、タッチでは疑似要素で上下に押せる範囲が広がる（行の高さは動かさない）', async () => {
    render(<Markdown>{'[click](https://example.com/path)'}</Markdown>);

    const link = await screen.findByRole('link', { name: 'click' });
    expect(link.className).toContain('pointer-coarse:relative');
    expect(link.className).toContain('pointer-coarse:after:-inset-y-3');
    expect(link.className).not.toMatch(/(^| )(py-|my-|inline-block|block)/);
  });

  it('data: リンクの href も javascript: と同じく空へ潰れる', async () => {
    render(
      <Markdown>{'[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'}</Markdown>,
    );

    const anchor = await screen.findByText('click');
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('');
  });

  it('vbscript: リンクの href も javascript: と同じく空へ潰れる', async () => {
    render(<Markdown>{'[click](vbscript:msgbox(1))'}</Markdown>);

    const anchor = await screen.findByText('click');
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('');
  });
});

describe('GFM: 取り消し線（`~`1つと`~~`2つの両方が <del> になる）', () => {
  it('`~1つ~` が <del> になる', async () => {
    const { container } = render(<Markdown>{'a ~b~ c'}</Markdown>);

    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe('b');
  });

  it('`~~2つ~~` も同じく <del> になる', async () => {
    const { container } = render(<Markdown>{'a ~~b~~ c'}</Markdown>);

    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe('b');
  });
});

describe('GFM: タスクリスト（チェックボックスが描かれ、操作できない）', () => {
  it('`- [ ]` / `- [x]` がチェック状態の異なる disabled のチェックボックスになる', async () => {
    const md = ['- [ ] todo', '- [x] done'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0]!.checked).toBe(false);
    expect(checkboxes[1]!.checked).toBe(true);
    expect(checkboxes[0]!.disabled).toBe(true);
    expect(checkboxes[1]!.disabled).toBe(true);
  });
});

describe('GFM: 脚注（本文の参照と末尾の脚注の節）', () => {
  it('本文中の参照と末尾の脚注が、id で相互に辿れる（死んだリンクにならない）', async () => {
    const md = ['Here is a note[^1].', '', '[^1]: The note text.'].join('\n');
    const { container } = render(<Markdown idPrefix="">{md}</Markdown>);

    const ref = container.querySelector('sup a');
    expect(ref).not.toBeNull();
    expect(ref?.getAttribute('href')).toBe('#user-content-fn-1');
    expect(ref?.textContent).toBe('1');

    expect(ref?.getAttribute('id')).toBe('user-content-fnref-1');
    expect(ref?.getAttribute('data-footnote-ref')).toBe('true');
    expect(ref?.getAttribute('aria-describedby')).toBe('footnote-label');

    expect(ref?.getAttribute('target')).toBeNull();
    expect(ref?.getAttribute('rel')).toBeNull();

    const refTargetId = ref!.getAttribute('href')!.slice(1);
    const refTarget = container.querySelector(`#${refTargetId}`);
    expect(refTarget).not.toBeNull();
    expect(refTarget?.tagName).toBe('LI');

    const label = container.querySelector('#footnote-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Footnotes');

    const section = container.querySelector('section[data-footnotes="true"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Footnotes');
    expect(section?.textContent).toContain('The note text.');
    expect(section).toBe(refTarget?.closest('section'));

    const backref = section?.querySelector('a');
    expect(backref).not.toBeNull();
    expect(backref?.getAttribute('href')).toBe('#user-content-fnref-1');
    expect(backref?.textContent).toBe('↩');
    expect(backref?.getAttribute('data-footnote-backref')).toBe('');
    expect(backref?.getAttribute('aria-label')).toBe('Back to reference 1');

    expect(backref?.getAttribute('target')).toBeNull();
    expect(backref?.getAttribute('rel')).toBeNull();

    const backrefTargetId = backref!.getAttribute('href')!.slice(1);
    const backrefTarget = container.querySelector(`#${backrefTargetId}`);
    expect(backrefTarget).not.toBeNull();
    expect(backrefTarget).toBe(ref);
  });

  it('脚注の節の見出し（footnote-label）は sr-only で、見た目のクラスを持たない', async () => {
    const md = ['Here is a note[^1].', '', '[^1]: The note text.'].join('\n');
    render(<Markdown idPrefix="">{md}</Markdown>);

    const label = screen.getByText('Footnotes');
    expect(label.id).toBe('footnote-label');
    expect(label.tagName).toBe('H2');

    expect(label.className).toBe('sr-only');
  });

  it('1画面に2つ描いても脚注の id が重複せず、各参照が自分の脚注を指す', async () => {
    const first = ['一通目[^1]。', '', '[^1]: 一通目の注。'].join('\n');
    const second = ['二通目[^1]。', '', '[^1]: 二通目の注。'].join('\n');
    const { container } = render(
      <>
        <section data-testid="first">
          <Markdown>{first}</Markdown>
        </section>
        <section data-testid="second">
          <Markdown>{second}</Markdown>
        </section>
      </>,
    );
    const a = screen.getByTestId('first');
    const b = screen.getByTestId('second');

    const ids = Array.from(container.querySelectorAll('[id]')).map((e) => e.id);
    expect(a.querySelectorAll('sup a[data-footnote-ref]')).toHaveLength(1);
    expect(b.querySelectorAll('sup a[data-footnote-ref]')).toHaveLength(1);
    expect(a.querySelectorAll('li[id]')).toHaveLength(1);
    expect(b.querySelectorAll('li[id]')).toHaveLength(1);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);

    for (const [own, note] of [
      [a, '一通目の注。'],
      [b, '二通目の注。'],
    ] as const) {
      const ref = own.querySelector('sup a[data-footnote-ref]')!;
      const href = ref.getAttribute('href')!;
      expect(href.startsWith('#')).toBe(true);
      const target = document.getElementById(href.slice(1));
      expect(target).not.toBeNull();
      expect(target?.tagName).toBe('LI');
      expect(own.contains(target)).toBe(true);
      expect(target?.textContent).toContain(note);

      const backref = target!.querySelector('a[data-footnote-backref]')!;
      expect(backref).not.toBeNull();
      const back = document.getElementById(backref.getAttribute('href')!.slice(1));
      expect(back).toBe(ref);

      const label = document.getElementById(ref.getAttribute('aria-describedby')!);
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe('Footnotes');
      expect(own.contains(label)).toBe(true);

      expect(own.querySelector(href)).toBe(target);
    }
  });
});

describe('GFM: 自動リンク（オートリンク）', () => {
  it('`www.` で始まる裸のドメインが `http://` リンクになる', async () => {
    render(<Markdown>{'see www.example.com for more'}</Markdown>);

    const link = await screen.findByRole('link', { name: 'www.example.com' });
    expect(link.getAttribute('href')).toBe('http://www.example.com');
  });

  it('メールアドレスが `mailto:` リンクになる', async () => {
    render(<Markdown>{'contact me at foo@example.com please'}</Markdown>);

    const link = await screen.findByRole('link', { name: 'foo@example.com' });
    expect(link.getAttribute('href')).toBe('mailto:foo@example.com');
  });

  it('URL 末尾の `.` はリンクへ含まれない', async () => {
    const { container } = render(<Markdown>{'visit https://example.com/path.'}</Markdown>);

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/path');
    expect(link?.nextSibling?.textContent).toBe('.');
  });

  it('URL 末尾の `,` はリンクへ含まれない', async () => {
    const { container } = render(<Markdown>{'visit https://example.com/path, next'}</Markdown>);

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/path');
    expect(link?.nextSibling?.textContent).toBe(', next');
  });

  it('URL を囲む閉じ括弧 `)` はリンクへ含まれない', async () => {
    const { container } = render(<Markdown>{'see (https://example.com/path) here'}</Markdown>);

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/path');
    expect(link?.nextSibling?.textContent).toBe(') here');
  });
});

describe('GFM: 表の中の `\\|`（パイプのエスケープ）', () => {
  it('`\\|` は列区切りにならず、逐語の `|` として1つのセルに描かれる', async () => {
    const md = ['| a\\|b | c |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const headers = Array.from(container.querySelectorAll('th'));
    expect(headers.map((th) => th.textContent)).toEqual(['a|b', 'c']);
  });
});

describe('GFM: 入れ子（表のセルの中の取り消し線）', () => {
  it('表のセルの中の `~~取り消し線~~` も <del> になる', async () => {
    const md = ['| a | b |', '| --- | --- |', '| ~~x~~ | y |'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const cell = container.querySelector('td');
    expect(cell?.querySelector('del')).not.toBeNull();
    expect(cell?.querySelector('del')?.textContent).toBe('x');
  });
});

describe('remark-breaks: 単独の改行を畳まない', () => {
  it('Markdown 記法を含む本文で、単独の改行が <br> になる', async () => {
    const { container } = render(<Markdown>{'1行目\n2行目'}</Markdown>);

    expect(container.querySelectorAll('br').length).toBe(1);
    expect(container.textContent).toContain('1行目');
    expect(container.textContent).toContain('2行目');
  });

  it('Markdown 記法を含まない素の複数行テキストでも、行の区切りが保たれる', async () => {
    const plain = ['先客のターンが走っている', '数分待つことがある', '受理はしている'].join('\n');
    const { container } = render(<Markdown>{plain}</Markdown>);

    expect(container.querySelectorAll('br').length).toBe(2);
    expect(container.textContent).toContain('先客のターンが走っている');
    expect(container.textContent).toContain('数分待つことがある');
    expect(container.textContent).toContain('受理はしている');
  });
});

describe('壊れた・未完成の Markdown でも例外を投げない', () => {
  it('閉じていない ** でも例外を投げず、テキストとして見える', () => {
    expect(() => {
      render(<Markdown>{'ここまで **まだ閉じていない強調'}</Markdown>);
    }).not.toThrow();

    expect(screen.getByText(/まだ閉じていない強調/)).toBeTruthy();
  });

  it('閉じていない ``` でも例外を投げず、中身が見える', () => {
    const chunk = ['```', 'まだ閉じていないコードブロック'].join('\n');

    expect(() => {
      render(<Markdown>{chunk}</Markdown>);
    }).not.toThrow();

    expect(screen.getByText(/まだ閉じていないコードブロック/)).toBeTruthy();
  });
});

describe('見出しの段下げ（headingOffset、#2842）', () => {
  const md = ['# a', '## b', '### c', '#### d', '##### e', '###### f'].join('\n\n');
  const tagsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.tagName);

  it('省略すると書かれた段のまま（今までどおり）', () => {
    const { container } = render(<Markdown>{md}</Markdown>);
    expect(tagsOf(container)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  });

  it('0 や負の値も段を変えない', () => {
    const zero = render(<Markdown headingOffset={0}>{md}</Markdown>);
    expect(tagsOf(zero.container)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const negative = render(<Markdown headingOffset={-1}>{md}</Markdown>);
    expect(tagsOf(negative.container)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  });

  it('2 を渡すと # は h3、## は h4、h5 と h6 は h6 に畳む（日報の画面の差し替えと同じ結果）', () => {
    const { container } = render(<Markdown headingOffset={2}>{md}</Markdown>);
    expect(tagsOf(container)).toEqual(['H3', 'H4', 'H5', 'H6', 'H6', 'H6']);
  });

  it('大きな値でも h6 を超えない', () => {
    const { container } = render(<Markdown headingOffset={9}>{md}</Markdown>);
    expect(tagsOf(container)).toEqual(['H6', 'H6', 'H6', 'H6', 'H6', 'H6']);
  });

  it('見た目は下がり先の段のものになり、h1 は残らない', () => {
    const { container } = render(<Markdown headingOffset={2}>{'# 題'}</Markdown>);
    const heading = container.querySelector('h3');
    expect(heading?.className).toContain('text-xs');
    expect(container.querySelector('h1')).toBeNull();
  });

  it('脚注節の見出し（sr-only）は下がっても sr-only のまま、id も保つ', () => {
    const { container } = render(
      <Markdown headingOffset={2} idPrefix="t-">
        {'本文[^1]\n\n[^1]: 注'}
      </Markdown>,
    );
    const label = container.querySelector('[id$="footnote-label"]');
    expect(label?.tagName).toBe('H4');
    expect(label?.classList.contains('sr-only')).toBe(true);
  });
});
