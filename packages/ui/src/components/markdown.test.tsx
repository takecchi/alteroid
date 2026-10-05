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
    // 普通の見出しは sr-only を持たない（`sr-only` は GFM の脚注節の見出し
    // だけに現れる特別なクラスであって、既定で漏れて付くものではない）。
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
    // jsdom はレイアウトを持たず列幅を測れない（390px で備考列が44px・17行に潰れた
    // 実寸はブラウザで測った）。潰れを防ぐ指定そのもの（包みの横スクロールと、td の
    // 狭い画面での最小幅）をクラスで固定する。表の外の要素には付かないことも見る。
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '本文 `code`'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    const table = await screen.findByRole('table');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
    const cell = screen.getByText('1');
    expect(cell.tagName).toBe('TD');
    expect(cell.className).toContain('max-lg:min-w-28');
    // 表の外（段落）には最小幅の指定が漏れない。
    const paragraph = container.querySelector('p');
    expect(paragraph?.className ?? '').not.toContain('min-w-28');
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

/**
 * ここから下は、PR #1665（`e4b3a93`）で `remark-gfm` パッケージ自体をやめ
 * `remarkGfmParseOnly`（`micromark-extension-gfm` の `gfm()` ＋
 * `mdast-util-gfm` の `gfmFromMarkdown()`）だけに替えたときの横断レビューで、
 * `remark-gfm@4.0.1` と描画が完全一致することを確認した機能を固定する歯である。
 *
 * **期待値はどれも「今の描画」（＝確認済みの `remark-gfm` と同じ描画）である。**
 * ここより前のテストは表・生 HTML・`javascript:`・改行しか見ていないので、
 * GFM の plugin をまた差し替えたときに描画が変わっても、ここが無いと気づけない。
 *
 * 直す前に赤くなる歯ではない（`markdown.tsx` はまだ元の実装のまま）ので、
 * 代わりに変異で赤くなることを確認してある — (a) `remarkPlugins` の配列から
 * `remarkGfmParseOnly` を抜くと GFM の歯が赤くなる (b) `gfm()` に
 * `{ singleTilde: false }` を渡すと `~1つ~` の歯だけが赤くなる。PR 本文に
 * 生出力がある。
 */
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
    // 操作できない（disabled）こと — 表示用であって、押して状態を変えられては
    // 本文の Markdown と表示が食い違う。
    expect(checkboxes[0]!.disabled).toBe(true);
    expect(checkboxes[1]!.disabled).toBe(true);
  });
});

describe('GFM: 脚注（本文の参照と末尾の脚注の節）', () => {
  /**
   * ⚠️ このテストは元々（PR #1671）「`components.a` はカスタムの `<a>` で
   * `href` と `children` だけを転送するので、hast が持つ `data-footnote-ref` /
   * `id` は描画に残らない（既存の `a` の実装に由来し、この PR が作った差では
   * ない）。だからここでは残る側（`href` と表示テキスト）で固定する。」と
   * 書き、`id` が落ちることを前提として回避していた。
   *
   * **その前提が壊れていた** — `id` が無いと、`href="#user-content-fn-1"` は
   * 実在する要素を指さない（本文の参照を押しても飛ぶ先が無い）。同じ理由で
   * 戻るリンクも着地先が無い。ここでは「壊れていることを回避する」のをやめ、
   * **`href` が指す `id` を持つ要素が実際に DOM 内に存在すること**を双方向
   * （参照 → 脚注、戻るリンク → 参照）で見る。あわせて GFM が脚注に付ける
   * 属性（`data-footnote-ref` / `data-footnote-backref` / `aria-describedby` /
   * `aria-label`）と `clobberPrefix`（`user-content-`）が保たれることも見る。
   *
   * ⚠️ **レビューで見つかった2点目（同じ「脚注のリンクが死ぬ」穴）**:
   * `id` を通しただけでは、`components.a` がどのリンクにも付けている
   * `target="_blank"` がそのまま残り、脚注の参照・戻るリンクを押すと
   * 新しいタブで SPA を読み直す形になっていた——本文が非同期に描かれる前
   * なので、飛ぶ先の要素がまだ無く、同じ画面の中の移動にならない。
   * `#` で始まる（同じ文書内を指す）リンクには `target` / `rel` を
   * 付けないことも、ここで固定する。
   *
   * （#2452 で追記）`<Markdown>` は既定で描画ごとの接頭辞（`useId()` 由来）を
   * id の前に付けるようになった。このテストは id の**形**（`user-content-` +
   * `fn-N` / `fnref-N`、`footnote-label`）を逐語で固定しているので、
   * `idPrefix=""`（接頭辞なし）で描いて、下の assert は1行も変えずに残している。
   * 既定（接頭辞あり）の側は、下の「1画面に2つ描いても…」で見る。
   */
  it('本文中の参照と末尾の脚注が、id で相互に辿れる（死んだリンクにならない）', async () => {
    const md = ['Here is a note[^1].', '', '[^1]: The note text.'].join('\n');
    const { container } = render(<Markdown idPrefix="">{md}</Markdown>);

    // 本文中の参照（上付きの「1」へのリンク）。
    const ref = container.querySelector('sup a');
    expect(ref).not.toBeNull();
    expect(ref?.getAttribute('href')).toBe('#user-content-fn-1');
    expect(ref?.textContent).toBe('1');

    // 参照自身が clobberPrefix 付きの id を持ち、GFM の脚注属性を保つこと。
    expect(ref?.getAttribute('id')).toBe('user-content-fnref-1');
    expect(ref?.getAttribute('data-footnote-ref')).toBe('true');
    expect(ref?.getAttribute('aria-describedby')).toBe('footnote-label');

    // 同じ文書内（`#` で始まる href）を指すので、新しいタブを開かないこと。
    // 新しいタブで開くと、そこでは本文がまだ非同期で描かれていないので
    // 飛ぶ先が無く、同じ画面の中の移動にならない。
    expect(ref?.getAttribute('target')).toBeNull();
    expect(ref?.getAttribute('rel')).toBeNull();

    // 押した先（href が指す id）が実在すること。無いと「死んだリンク」になる。
    const refTargetId = ref!.getAttribute('href')!.slice(1);
    const refTarget = container.querySelector(`#${refTargetId}`);
    expect(refTarget).not.toBeNull();
    expect(refTarget?.tagName).toBe('LI');

    // aria-describedby が指す footnote-label も実在すること
    // （見出し用の `heading()` も `id` を落とすと、ここが宙に浮く）。
    const label = container.querySelector('#footnote-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Footnotes');

    // 末尾の脚注の節（`section` は components で上書きしていないので
    // `data-footnotes` 属性がそのまま残る）。
    const section = container.querySelector('section[data-footnotes="true"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Footnotes');
    expect(section?.textContent).toContain('The note text.');
    expect(section).toBe(refTarget?.closest('section'));

    // 脚注から本文へ戻るリンク。
    const backref = section?.querySelector('a');
    expect(backref).not.toBeNull();
    expect(backref?.getAttribute('href')).toBe('#user-content-fnref-1');
    expect(backref?.textContent).toBe('↩');
    expect(backref?.getAttribute('data-footnote-backref')).toBe('');
    expect(backref?.getAttribute('aria-label')).toBe('Back to reference 1');

    // 戻るリンクも同じ文書内を指すので、新しいタブを開かないこと。
    expect(backref?.getAttribute('target')).toBeNull();
    expect(backref?.getAttribute('rel')).toBeNull();

    // 戻るリンクの押した先（本文の参照そのもの）が実在すること。
    const backrefTargetId = backref!.getAttribute('href')!.slice(1);
    const backrefTarget = container.querySelector(`#${backrefTargetId}`);
    expect(backrefTarget).not.toBeNull();
    expect(backrefTarget).toBe(ref);
  });

  /**
   * ⚠️ PR #1678 の作業者が範囲外として見つけた穴（本文コメント参照）。
   * `mdast-util-to-hast` の `lib/footer.js` は脚注節の見出しに既定で
   * `className: ['sr-only']` を付ける（画面には出さず、スクリーンリーダー
   * だけに読ませる見出し）。ところが `heading()` は `id` だけを通し
   * `className` を丸ごと落としていたので、この見出しは
   * 普通の見出し（`HEADINGS.h2` の見た目）として画面に出ていた。
   *
   * 直し方は `className` を丸ごと通すのではなく、受け取った `className` に
   * `sr-only` が含まれるときだけ `sr-only` を付ける（他のクラスは通さない）。
   *
   * （#2452 で追記）id を逐語で見るので、上のテストと同じく `idPrefix=""` で描く。
   */
  it('脚注の節の見出し（footnote-label）は sr-only で、見た目のクラスを持たない', async () => {
    const md = ['Here is a note[^1].', '', '[^1]: The note text.'].join('\n');
    render(<Markdown idPrefix="">{md}</Markdown>);

    const label = screen.getByText('Footnotes');
    expect(label.id).toBe('footnote-label');
    expect(label.tagName).toBe('H2');

    // sr-only だけを持ち、この部品が決める見た目のクラス（HEADINGS.h2）を
    // 持たないこと——両方持っていると「className を丸ごと通した」ことになる。
    expect(label.className).toBe('sr-only');
  });

  /**
   * #2452。1画面に `<Markdown>` が2つ（チャットの2通の応答・台帳の2行）あり、
   * どちらにも同じ脚注 `[^1]` があると、固定の id（`user-content-fn-1` など）が
   * 重複し、2つ目の参照を押すとブラウザは文書で最初の要素＝1つ目の脚注へ飛ぶ。
   * 戻るリンクと `aria-describedby` も1つ目を指す。既定の `<Markdown>`
   * （`idPrefix` を渡さない）で2つ描き、(1) 文書の中で id が重複しないこと、
   * (2) 各参照・戻るリンク・`aria-describedby` が、**文書全体から引いても**
   * 自分の側の要素に着くことを見る。文書全体（`document`）から引くのは、
   * ブラウザの `#` の解決がそうだからである（自分の `container` の中だけで
   * 引くと、重複していても通ってしまう）。
   */
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

    // (1) id の重複が無いこと。脚注が2つずつ描かれていることを先に確かめる
    // （描かれていなければ「重複が無い」は空振りで通る）。
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
      // (2) 参照 → 自分の脚注（文書全体で引いても自分の側に着く）。
      const ref = own.querySelector('sup a[data-footnote-ref]')!;
      const href = ref.getAttribute('href')!;
      expect(href.startsWith('#')).toBe(true);
      const target = document.getElementById(href.slice(1));
      expect(target).not.toBeNull();
      expect(target?.tagName).toBe('LI');
      expect(own.contains(target)).toBe(true);
      expect(target?.textContent).toContain(note);

      // 戻るリンク → 自分の参照。
      const backref = target!.querySelector('a[data-footnote-backref]')!;
      expect(backref).not.toBeNull();
      const back = document.getElementById(backref.getAttribute('href')!.slice(1));
      expect(back).toBe(ref);

      // aria-describedby → 自分の脚注の節の見出し。
      const label = document.getElementById(ref.getAttribute('aria-describedby')!);
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe('Footnotes');
      expect(own.contains(label)).toBe(true);

      // 接頭辞は CSS セレクタでエスケープせずに引ける形であること
      // （`useId()` の `:` や `«»` を落としていること）。
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
    // 句読点自体はリンクの外、地の文として残る。
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
    // 列が3つに割れていないこと — エスケープが効かず列区切りとして解釈
    // された場合、ここが3になって最初に壊れる。
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
