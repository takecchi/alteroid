/**
 * AI の応答・日報・マネージャーの報告を Markdown として描く共有部品。
 *
 * 人間の依頼: 「AIの返答ってMarkdown返却多いからWebUIも表示をMarkdownにした
 * ほうがこっちとしては見やすい」（alteroid の Web UI について）。
 *
 * **`dangerouslySetInnerHTML` は使わない。** Markdown 文字列は
 * `mdast-util-from-markdown`（Markdown → mdast）→ `markdown-mdast.ts` の
 * `mdastToReact`（mdast → React 要素）で完結し、HTML 文字列を経由しない
 * （`mdast-util-to-hast` も hast も使わない。理由は `markdown-mdast.ts` の冒頭）。だからサニタイズを足し忘れるという失敗の形そのものが無い。
 *
 * **`rehype-raw` は入れない。** 本文中に書かれた `<script>` や
 * `onerror` 付きタグは、**要素として解釈されず、そのままテキストとして
 * 表示される**。mdast の `html` ノード（生 HTML）は、`mdastToReact` が
 * 要素にせず文字列にして描く（以前使っていた react-markdown が
 * `allowDangerousHtml: true` で `raw` ノードにし、`lib/index.js` の `transform` で
 * 文字列にしていたのと同じ結果）。`rehype-raw` はその `raw` ノードを
 * 実際の hast 要素へ解釈し直す道具で、足した瞬間にこの性質が消え、本文が
 * そのまま実行可能な HTML になる注入経路が生まれる。**足したくなったら、まず
 * `markdown.test.tsx` の「生 HTML が要素にならない」テストを見ること** —
 * あのテストは今回の変更のために存在し、`rehype-raw` を足すと最初に落ちる。
 *
 * **react-markdown（と unified / vfile / hast-util-to-jsx-runtime /
 * property-information）は本番の依存に入れない。** 描く DOM は変えずに、
 * Web UI の JS の合計（`check:web-bundle-size` の予算。遅延読み込みでは
 * 合計は減らない）から約42KB を外すため、hast → React の変換だけを下の
 * 小さな自前の関数（`toReact`）にした。**等価性の担保は
 * `markdown-equivalence.test.tsx`** — react-markdown を devDependency に残し、
 * 旧実装と同じ入力の広いコーパスで `renderToStaticMarkup` の完全一致を見て
 * いる。**そのテストが落ちたら、描かれる DOM が変わっている。**
 *
 * `newlineToBreak`（`remark-breaks` の中身）を掛ける理由: 素の Markdown は
 * 単独の改行を畳む（半角の行末スペース2つや空行との改行しか区別しない）。
 * この画面はこれまで `whitespace-pre-wrap` で改行をそのまま見せていたので、
 * これが無いと「今まで見えていた行区切りが消える」という劣化になる。
 *
 * GFM（表・取り消し線・タスクリスト・フッターノート・オートリンク）は
 * `micromark-extension-gfm` の `gfm()` と `mdast-util-gfm` の
 * `gfmFromMarkdown()` を `fromMarkdown` へ直接渡して足す。**`remark-gfm`
 * パッケージそのものはここでは使わない** — 理由は `toReact` の直前に書いた。
 *
 * **一覧の1行（`truncate` / `line-clamp`）は Markdown 化の対象ではない。**
 * そこに出ているのは畳んだ索引であって本文の面ではなく、押せば全文の面へ
 * 降りられる。`line-clamp` の内側へブロック要素（`<Markdown>` のルートは
 * `div`）を入れると畳み方そのものが効かなくなるうえ、`components/page.tsx`
 * が「`line-clamp` で切ると、収まっているように見えたまま読めない部分ができる」
 * として避ける理由を既に書いている。**対象は、詳細で全文を出す面だけである。**
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { newlineToBreak } from 'mdast-util-newline-to-break';
import { gfm } from 'micromark-extension-gfm';
import { type ComponentProps, type ReactNode, useId } from 'react';

import { type Components, mdastToReact } from './markdown-mdast';

/**
 * **`remark-gfm` パッケージそのものは使わない。** `remark-gfm` は
 * `mdast-util-gfm` から `gfmFromMarkdown`（解析）と `gfmToMarkdown`
 * （mdast → Markdown 文字列への書き戻し）の**両方を無条件に呼ぶ**。この画面は
 * 「Markdown 文字列 → mdast → hast → React 要素」の一方向にしか使わないので、
 * 書き戻し側（`mdast-util-to-markdown` 本体・`markdown-table`）は結果を誰も
 * 読まないのに、呼び出しが生きたコードなので tree-shaking では削れず、実測で
 * クライアント JS に ~13KB 乗っていた（`mdast-util-to-markdown` 11,435B +
 * `markdown-table` 1,570B、2026-09-27 観測）。**だから解析側の
 * `gfmFromMarkdown()` だけを呼ぶ。** `remark-gfm` が内部で呼ぶのと**同じ**
 * 関数で、解析結果（mdast）は変わらない。独自のパーサ実装は無い。
 * どちらもオプションは取らない（`remark-gfm` 自身も無指定で呼ぶ）。
 *
 * Markdown 文字列を React 要素にする。`components` は既定で下の
 * `markdownComponents`（等価性テストが「差し替え無し」でも比べるので引数に
 * している）。`remarkRehypeOptions` の既定（`allowDangerousHtml: true`）も
 * react-markdown と同じ。
 *
 * `idPrefix` は脚注の id の先頭に付ける（`mdastToReact` の注釈）。既定の空
 * 文字列なら旧実装と同じ id になる。画面に描くのは `Markdown`（下）で、そちらは
 * 描画ごとに一意の接頭辞を渡す。
 */
export function toReact(
  markdown: string,
  components: Components = markdownComponents,
  idPrefix = '',
): ReactNode {
  const mdast = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  newlineToBreak(mdast);
  return mdastToReact(mdast, components, idPrefix);
}

/**
 * コードが行内（inline）か、フェンスされたコードブロックかを見分ける。
 *
 * `code` コンポーネントに `inline` は渡されない（hast にその情報が無いため。
 * react-markdown v9 以降と同じ形にしてある）。**言語付き**のフェンス（```ts` など）は
 * `language-xxx` という className が付くので判別できるが、**言語無しの
 * フェンス**（`docs/architecture.md` の罫線図がまさにこれ）には className が
 * 付かない。CommonMark の仕様上、行内コードスパンの中には改行を書けない
 * （行末は空白に畳まれる）ので、**中身に改行が1つでもあればコードブロック**
 * として扱う。1行だけの言語無しフェンスはこの判定をすり抜けるが、実害は
 * 「行内コード用の小さな見た目になる」だけで、内容自体は変わらない
 * （逐語性は保たれる）。
 */
function isBlockCode(className: string | undefined, text: string): boolean {
  return /language-/.test(className ?? '') || text.includes('\n');
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

/*
 * **どの見出しも `CardHeader` の h2（`text-sm font-semibold`）より小さくする。**
 * この Markdown は常にどこかの Card の中身として使われ、Card の見出しは
 * 既に h2 を使っている。本文中に同じ大きさ・同じタグの見出しが出ると、
 * 画面としては「見出しが2段同じ強さで並ぶ」ように見えて読み違えやすい。
 *
 * **タグ自体（h1〜h6）は変えていない。** 文書構造（スクリーンリーダーの
 * 見出しアウトライン）としては本文の h1 は h1 のまま出る — Card の h2 の
 * 直後に h1 が来る非構造化な順序にはなるが、これは AI・人間が自由に書いた
 * 本文の見出しレベルを画面側で付け替えないための割り切りである。
 */
const HEADINGS = {
  h1: 'mt-3 mb-1.5 text-[13px] font-semibold first:mt-0',
  h2: 'mt-3 mb-1.5 text-[13px] font-semibold first:mt-0',
  h3: 'mt-2.5 mb-1 text-xs font-semibold first:mt-0',
  h4: 'mt-2 mb-1 text-xs font-semibold text-muted-foreground first:mt-0',
  h5: 'mt-2 mb-1 text-[11px] font-semibold text-muted-foreground first:mt-0',
  h6: 'mt-2 mb-1 text-[11px] font-semibold text-muted-foreground uppercase first:mt-0',
} as const;

type HeadingTag = keyof typeof HEADINGS;

/**
 * `id` は常に通す。GFM の脚注節は見出し（既定 `h2`）に
 * `id="footnote-label"` を付け、本文の参照・戻るリンクの
 * `aria-describedby="footnote-label"` がそれを指す
 * （`mdast-util-to-hast` の `lib/footer.js` の `footnoteLabelTagName` /
 * `footnoteLabelProperties`）。`id` を落とすと、その参照先が無くなる。
 *
 * **`className` は丸ごとは渡さない** — 見出しの見た目はこの部品が決めるもので
 * あって Markdown 側の任意のクラスに揺らがせない。**ただし `sr-only` だけは
 * 例外で通す** — `mdast-util-to-hast` の同じ `lib/footer.js` が脚注節の
 * 見出しに既定で `className: ['sr-only']` を付けており（画面には出さず
 * スクリーンリーダーだけに読ませる意図）、これを無視すると本来隠すはずの
 * 見出しが通常の見出し（`HEADINGS[tag]` の見た目）として画面に出てしまう。
 * 受け取った `className` に `sr-only` というトークンが含まれるときだけ、
 * この部品の見た目のクラスの代わりに `sr-only` 単体を付ける——他のクラスは
 * 通さない。`sr-only` は Tailwind の組み込みユーティリティで、この repo でも
 * 既に `shadcn/sheet.tsx` / `drawer.tsx` で使っている。
 */
function heading(tag: HeadingTag) {
  return function Heading({
    id,
    className,
    children,
  }: {
    id?: string;
    className?: string;
    children?: ReactNode;
  }) {
    const Tag = tag;
    const isScreenReaderOnly = (className ?? '').split(/\s+/).includes('sr-only');
    return (
      <Tag id={id} className={isScreenReaderOnly ? 'sr-only' : HEADINGS[tag]}>
        {children}
      </Tag>
    );
  };
}

export const markdownComponents: Components = {
  p: ({ children }) => <p className="mt-2 leading-relaxed first:mt-0">{children}</p>,
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-0.5 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mt-2 list-decimal space-y-0.5 pl-5 first:mt-0">{children}</ol>
  ),
  // GFM の脚注の定義（`<li id="user-content-fn-N">`）。**`id` だけを通す** —
  // 本文の参照リンク（`components.a`、下）の `href` はここの `id` を指す。
  // 落とすと参照を押しても飛ぶ先が無い「死んだリンク」になる
  // （`mdast-util-to-hast` の `lib/footer.js` の `footer()`）。
  li: ({ id, children }: ComponentProps<'li'>) => (
    <li id={id} className="leading-relaxed">
      {children}
    </li>
  ),
  a: ({
    href,
    children,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-label': ariaLabel,
    'data-footnote-ref': dataFootnoteRef,
    'data-footnote-backref': dataFootnoteBackref,
  }: ComponentProps<'a'> & {
    // `data-*` は @types/react の型に汎用の index signature が無いため、
    // 明示的に広げないと destructure できない（`id` / `aria-describedby` /
    // `aria-label` は標準の HTML/ARIA 属性としてすでに `ComponentProps<'a'>`
    // に在るので、ここでは広げていない）。
    'data-footnote-ref'?: boolean;
    'data-footnote-backref'?: string;
  }) => (
    // 外部リンク扱いで開く。本文は AI・人間が書いた自由文であって、この
    // アプリ内の経路を指す相対リンクを前提にしていない。
    // **任意の hast 属性を丸ごと素通ししない。** hast 由来の props をそのまま
    // `<a>` へ広げると、Markdown 本文が持ちうる任意の `className` / `style` で
    // この部品の見た目・安全性（下の外部リンク扱い・`rel`）を上書きされる
    // 経路になる（以前は react-markdown が渡す `node` も広げてしまう形だった）。
    // **だから許可した名前だけを明示して渡す** — `id` と、GFM が脚注の
    // `<a>` に付ける4つ（`data-footnote-ref` / `aria-describedby`＝本文の
    // 参照、`data-footnote-backref` / `aria-label`＝脚注からの戻るリンク）
    // だけをこの形で足す。`clobberPrefix`（`user-content-`）は
    // `mdast-util-to-hast` の既定値を `markdown-mdast.ts` に固定してあり、外していない。
    //
    // **`#` で始まる href（同じ文書内を指すリンク）には `target` / `rel` を
    // 付けない。** GFM の脚注の参照（`#user-content-fn-N`）・戻るリンク
    // （`#user-content-fnref-N`）はどちらもこの形。`target="_blank"` を
    // 付けたままだと、押すたびに SPA を新しいタブで読み直すことになり、
    // その新しいタブでは本文がまだ非同期に描かれる前で飛ぶ先の要素が無い
    // ——「id を通しただけ」では直らない、同じ「脚注のリンクが死ぬ」穴の
    // 別の形（2026-09-26 レビュー指摘）。**判定は `href` の先頭が `#` かだけ
    // で行い、URL を解釈して「同じ origin か」を見る形にはしない**
    // （below の `defaultUrlTransform` 由来の危険な URL 無効化——`href` は
    // 既にそこを通った後の値なので、ここで URL 解釈を増やすと安全性の判断
    // 経路が2つに増える）。外部リンクの扱い（`_blank` / `noreferrer
    // noopener`）はそれ以外のすべての href で変えていない。
    <a
      href={href}
      id={id}
      aria-describedby={ariaDescribedBy}
      aria-label={ariaLabel}
      data-footnote-ref={dataFootnoteRef}
      data-footnote-backref={dataFootnoteBackref}
      target={href?.startsWith('#') ? undefined : '_blank'}
      rel={href?.startsWith('#') ? undefined : 'noreferrer noopener'}
      // 押せる範囲（タッチ端末だけ）: 文中のリンクは行の高さ（約21px）しか無く押しにくい。
      // 見た目の行の高さ・段落の間隔は動かさず、疑似要素で上下へ 12px ずつ当たり判定だけ広げる（約44px）。
      className="break-words text-primary hover:underline pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 pointer-coarse:after:content-['']"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l-2 border-border pl-3 text-muted-foreground italic first:mt-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  img: ({ src, alt }) => (
    <img src={src ?? ''} alt={alt ?? ''} className="my-2 max-w-full rounded border border-border" />
  ),
  // GFM の表。**横スクロールさせる div で包む** — 表は折り返せないので、
  // 包まないと幅の広い表がカードごと画面外まで広げる。
  //
  // **画面幅が `lg`（1024px）未満のとき、セル（`td`）に最小幅を持たせる**（#2805）。
  // 広い画面では今までどおり内容に応じた列幅のまま（最小幅を常に付けると、デスクトップで
  // 備考列が 366px から 132px へ詰まった — 実測）。コンテナクエリ（inline-size の包含を伴う指定）は
  // 使わない: 包含を付けると、幅を持たない親（flex の子など）の中で
  // 包みが幅 0 になりうる。`table-layout: auto` は、表が
  // 入りきらないとき内容の長い列を 1 文字幅まで詰めて他の列（長い URL など折り返せない
  // 列）へ幅を回す（390px で備考の日本語が 1 行 1〜2 文字・17 行になった）。最小幅が
  // あれば、詰める代わりに表そのものが包みの幅を超え、この div の横スクロールが
  // 働く。**表（`table`・`th`・`td`）の中だけの指定** — 表の無い本文・コード・
  // リストの見た目は変わらない。**端の手がかり**は、はみ出した列が右端で見切れること
  // と、細いスクロールバー（`scrollbar-width: thin`）で出す。
  table: ({ children }) => (
    <div className="mt-2 min-w-0 overflow-x-auto [scrollbar-width:thin] first:mt-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border last:border-b-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="max-lg:min-w-28 px-2 py-1 align-top">{children}</td>,
  // コードブロック（`pre`）。**折り返さず横スクロール** — `docs/architecture.md`
  // の罫線図のような、折り返すと崩れる図をそのまま保つ。`overflow-x-auto` で
  // 包み、`whitespace-pre` で `styles.css` の既定（生ログ向けの `pre-wrap`）を
  // 上書きする（Tailwind の utilities 層は base 層より後なので、指定すれば
  // 必ず勝つ）。
  pre: ({ children }) => (
    <pre className="mt-2 min-w-0 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[0.85em] whitespace-pre first:mt-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const text = textOf(children);
    if (isBlockCode(className, text)) {
      // `pre` 側が横スクロール・背景・枠を持つので、ここは素のまま。
      return <code className="font-mono text-[0.85em]">{children}</code>;
    }
    // 行内コード・長い URL などは領域内に収める（折り返す）。
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">
        {children}
      </code>
    );
  },
};

/**
 * `<Markdown>{text}</Markdown>` の形で使う。
 *
 * **既存の色トークンだけを使う**（`text-foreground` は基底の文字色に既に乗っている
 * ので明示していない。`text-muted-foreground` / `border-border` / `bg-muted` /
 * `text-primary` は `styles.css` に実在するものだけを使っている）。
 *
 * **脚注の id は描画ごとに一意にする**（#2452）。1画面に `<Markdown>` が
 * 複数ある（チャットの各応答・台帳の各行）と、固定の id
 * （`user-content-fn-1` / `user-content-fnref-1` / `footnote-label`）が重複し、
 * 2つ目の参照・戻るリンク・`aria-describedby` が1つ目の脚注を指していた
 * （ブラウザは文書で最初の要素へ飛ぶ）。だから React の `useId()` から
 * 接頭辞を作り、id と、それを指す `href` / `aria-describedby` の両方に同じ
 * ものを付ける。`useId()` の値（`_r_0_` / `«r0»` / `:r0:` など版で形が違う）は
 * 英数字・`_`・`-` 以外を落として使う — CSS セレクタ（`#id`）でエスケープ
 * せずに引ける形にしておくため。`idPrefix` を渡せばそれを使う（空文字列で
 * 旧実装と同じ id になる。1画面に1つしか描かないと分かっているときだけ使うこと）。
 */
export function Markdown({ children, idPrefix }: { children: string; idPrefix?: string }) {
  const reactId = useId();
  const prefix = idPrefix ?? 'md' + reactId.replace(/[^A-Za-z0-9_-]/g, '') + '-';
  return (
    <div className="min-w-0 text-sm break-words">
      {toReact(children, markdownComponents, prefix)}
    </div>
  );
}
