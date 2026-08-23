/**
 * AI の応答・日報・マネージャーの報告を Markdown として描く共有部品。
 *
 * 人間の依頼: 「AIの返答ってMarkdown返却多いからWebUIも表示をMarkdownにした
 * ほうがこっちとしては見やすい」（alteroid の Web UI について）。
 *
 * **`dangerouslySetInnerHTML` は使わない。** react-markdown は
 * remark（Markdown → mdast）→ remark-rehype（mdast → hast）→
 * hast-util-to-jsx-runtime（hast → React 要素）で完結し、HTML 文字列を
 * 経由しない。だからサニタイズを足し忘れるという失敗の形そのものが無い。
 *
 * **`rehype-raw` は入れない。** 本文中に書かれた `<script>` や
 * `onerror` 付きタグは、react-markdown の既定では**要素として解釈されず、
 * そのままテキストとして表示される**（`react-markdown/lib/index.js` の
 * `transform`: `raw` ノードを `skipHtml` でなければ `{type: 'text', ...}` に
 * 差し替える）。`rehype-raw` はその `raw` ノードを実際の hast 要素へ
 * 解釈し直す道具で、足した瞬間にこの性質が消え、本文がそのまま実行可能な
 * HTML になる注入経路が生まれる。**足したくなったら、まず
 * `markdown.test.tsx` の「生 HTML が要素にならない」テストを見ること** —
 * あのテストは今回の変更のために存在し、`rehype-raw` を足すと最初に落ちる。
 *
 * `remark-breaks` を入れる理由: 素の Markdown は単独の改行を畳む（半角の
 * 行末スペース2つや空行との改行しか区別しない）。この画面はこれまで
 * `whitespace-pre-wrap` で改行をそのまま見せていたので、`remark-breaks` が
 * 無いと「今まで見えていた行区切りが消える」という劣化になる。
 *
 * `remark-gfm` は表・取り消し線・タスクリストなど GFM 拡張のため。
 *
 * **一覧の1行（`truncate` / `line-clamp`）は Markdown 化の対象ではない。**
 * そこに出ているのは畳んだ索引であって本文の面ではなく、押せば全文の面へ
 * 降りられる。`line-clamp` の内側へブロック要素（`<Markdown>` のルートは
 * `div`）を入れると畳み方そのものが効かなくなるうえ、`components/page.tsx`
 * が「`line-clamp` で切ると、収まっているように見えたまま読めない部分ができる」
 * として避ける理由を既に書いている。**対象は、詳細で全文を出す面だけである。**
 */
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * コードが行内（inline）か、フェンスされたコードブロックかを見分ける。
 *
 * react-markdown v9 以降、`code` コンポーネントに `inline` は渡されない
 * （hast にその情報が無いため）。**言語付き**のフェンス（```ts` など）は
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
  h4: 'mt-2 mb-1 text-xs font-semibold text-muted first:mt-0',
  h5: 'mt-2 mb-1 text-[11px] font-semibold text-muted first:mt-0',
  h6: 'mt-2 mb-1 text-[11px] font-semibold text-muted uppercase first:mt-0',
} as const;

type HeadingTag = keyof typeof HEADINGS;

function heading(tag: HeadingTag) {
  return function Heading({ children }: { children?: ReactNode }) {
    const Tag = tag;
    return <Tag className={HEADINGS[tag]}>{children}</Tag>;
  };
}

const components: Components = {
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
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    // 外部リンク扱いで開く。本文は AI・人間が書いた自由文であって、この
    // アプリ内の経路を指す相対リンクを前提にしていない。
    // **`...props` を素通ししない。** react-markdown は hast の `node`
    // （`ExtraProps`）を毎回この形へ渡すので、そのまま `<a>` へ広げると
    // DOM が知らない `node` prop を渡すことになる（React の警告）。
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-words text-accent hover:underline"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted line-through">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l-2 border-border pl-3 text-muted italic first:mt-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  img: ({ src, alt }) => (
    <img src={src ?? ''} alt={alt ?? ''} className="my-2 max-w-full rounded border border-border" />
  ),
  // GFM の表。**横スクロールさせる div で包む** — 表は折り返せないので、
  // 包まないと幅の広い表がカードごと画面外まで広げる。
  table: ({ children }) => (
    <div className="mt-2 min-w-0 overflow-x-auto first:mt-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border last:border-b-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1 align-top">{children}</td>,
  // コードブロック（`pre`）。**折り返さず横スクロール** — `docs/architecture.md`
  // の罫線図のような、折り返すと崩れる図をそのまま保つ。`overflow-x-auto` で
  // 包み、`whitespace-pre` で `app.css` の既定（生ログ向けの `pre-wrap`）を
  // 上書きする（Tailwind の utilities 層は base 層より後なので、指定すれば
  // 必ず勝つ）。
  pre: ({ children }) => (
    <pre className="mt-2 min-w-0 overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[0.85em] whitespace-pre first:mt-0">
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
      <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] break-words">
        {children}
      </code>
    );
  },
};

/**
 * `<Markdown>{text}</Markdown>` の形で使う。
 *
 * **既存の色トークンだけを使う**（`text-fg` は基底の文字色に既に乗っている
 * ので明示していない。`text-muted` / `border-border` / `bg-surface-2` /
 * `text-accent` は `app.css` に実在するものだけを使っている）。
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
