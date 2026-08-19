// @vitest-environment jsdom
/**
 * `<Markdown>` の受け入れ条件。
 *
 * とくに重いのは2本 — **`rehype-raw` を入れていないこと**（生 HTML が要素に
 * ならないこと）と、**`javascript:` リンクが実行可能にならないこと**。
 * どちらも「サニタイズを書いた」のではなく「そもそも解釈しない経路を採った」
 * という設計の帰結なので、次に `rehype-raw` を足したくなった人・URL の
 * 扱いを変えたくなった人がここで気づけるようにしてある。
 *
 * **クローンの応答は「Markdown で返す」という取り決めではなく、モデルの
 * 出力習慣に過ぎない**（`packages/core/src/prompt.ts` に Markdown 指定は無い）。
 * だから Markdown として無効な入力・素のテキストが来ても壊れないことも
 * 同じ強さで保証する。
 */
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
  });

  it('GFM の表が table 要素になる', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    render(<Markdown>{md}</Markdown>);

    const table = await screen.findByRole('table');
    expect(table.tagName).toBe('TABLE');
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('コードフェンスの中身は逐語で保たれる（`**強調**` が強調にならない）', async () => {
    const md = ['```', '**not bold**', '```'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent?.trim()).toBe('**not bold**');
    // 強調として解釈されていれば `<strong>` が中に生まれる。無いことを見る。
    expect(code?.querySelector('strong')).toBeNull();
  });

  it('言語無しのフェンス（罫線図のような複数行）も横スクロールの pre になる', async () => {
    // docs/architecture.md の全体像図と同じ形（言語タグ無し・複数行）。
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

    // 要素として解釈されていれば `<img>` が実際に生まれる。無いことを見る。
    expect(container.querySelector('img')).toBeNull();
    // 生の文字列がテキストとしてそのまま出ていること（消えていない）。
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

    // `href=""` は ARIA 上「link」ロールを失う（testing-library の実装が
    // 空文字の href を「href 無し」と同じ扱いにする）。役割ではなく
    // 属性そのものを見る。
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
});

describe('remark-breaks: 単独の改行を畳まない', () => {
  it('Markdown 記法を含む本文で、単独の改行が <br> になる', async () => {
    const { container } = render(<Markdown>{'1行目\n2行目'}</Markdown>);

    expect(container.querySelectorAll('br').length).toBe(1);
    expect(container.textContent).toContain('1行目');
    expect(container.textContent).toContain('2行目');
  });

  /**
   * **Markdown 記法を1つも含まない素の複数行テキスト**でも同じであること。
   *
   * クローンの応答が Markdown なのはモデルの出力習慣であって取り決めでは
   * ない（`prompt.ts` に指定は無い）ので、素のテキストが来る前提を外せない。
   * これまでの画面は `whitespace-pre-wrap` で改行をそのまま見せていたので、
   * ここが崩れると「今まで見えていた行区切りが消える」という劣化になる。
   */
  it('Markdown 記法を含まない素の複数行テキストでも、行の区切りが保たれる', async () => {
    const plain = ['先客のターンが走っている', '数分待つことがある', '受理はしている'].join('\n');
    const { container } = render(<Markdown>{plain}</Markdown>);

    expect(container.querySelectorAll('br').length).toBe(2);
    expect(container.textContent).toContain('先客のターンが走っている');
    expect(container.textContent).toContain('数分待つことがある');
    expect(container.textContent).toContain('受理はしている');
  });
});

/**
 * chat.tsx はチャンクを継ぎ足していく実装なので、届く途中の「まだ閉じて
 * いない ``` や `**`」を毎回パースし直すことになる（受信中かどうかを見分ける
 * 信号が無いため、常時 Markdown で描画する設計にした）。ここでは
 * **例外を投げないこと**と**中身が消えずに見えること**だけを保証する
 * （閉じた瞬間に見た目が変わる揺れ自体は許容している。PR 本文に明記）。
 */
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
