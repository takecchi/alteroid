/**
 * rehype-raw を入れない・dangerouslySetInnerHTML を使わない: 生 HTML を要素にせず文字列で描く性質が消え、本文がそのまま実行可能な HTML になる注入経路が生まれるため。
 * react-markdown を本番の依存に入れない: Web UI の JS の合計（check:web-bundle-size）から約42KB を外すため。等価性は markdown-equivalence.test.tsx が見る。
 * newlineToBreak を掛ける: 素の Markdown は単独の改行を畳み、whitespace-pre-wrap で見えていた行区切りが消えるため。
 * 一覧の1行（truncate / line-clamp）を Markdown 化しない: line-clamp の内側へブロック要素を入れると畳み方が効かなくなるため。
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { newlineToBreak } from 'mdast-util-newline-to-break';
import { gfm } from 'micromark-extension-gfm';
import { type ComponentProps, type ReactNode, useEffect, useId, useState } from 'react';

import { useDisplayText } from '@/lib/display-text';

import { type Components, type MdastOptions, mdastToReact } from './markdown-mdast';
import { type DaemonImages, useDaemonImages } from '@/lib/daemon-images';
import { ImageFallback, ZoomableImage } from './zoomable-image';

// remark-gfm を使わず gfmFromMarkdown() だけを呼ぶ: remark-gfm は書き戻し側（gfmToMarkdown）も無条件に呼び、tree-shaking で削れず ~13KB 乗るため
export function toReact(
  markdown: string,
  components: Components = markdownComponents,
  idPrefix = '',
  options: MdastOptions = {},
): ReactNode {
  const mdast = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  newlineToBreak(mdast);
  return mdastToReact(mdast, components, idPrefix, options);
}

// 中身に改行が在ればコードブロックとする: 言語無しのフェンスには className が付かず、行内コードスパンには改行を書けないため
function isBlockCode(className: string | undefined, text: string): boolean {
  return /language-/.test(className ?? '') || text.includes('\n');
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

// どの見出しも CardHeader の h2 より小さくする: Card の中身として使われ、同じ大きさ・同じタグの見出しが並ぶと読み違えるため。タグ自体は変えない
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
 * id を常に通す: 脚注節の見出しの id を本文の aria-describedby が指し、落とすと参照先が無くなるため。
 * className を丸ごとは渡さず sr-only だけ通す: 見出しの見た目はこの部品が決め、脚注節の見出しの sr-only を無視すると隠すはずの見出しが画面に出るため。
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

const HEADING_TAGS: readonly HeadingTag[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

export function offsetHeadings(components: Components, offset?: number): Components {
  if (offset === undefined || !Number.isFinite(offset)) return components;
  const steps = Math.trunc(offset);
  if (steps <= 0) return components;
  const shifted: Components = { ...components };
  HEADING_TAGS.forEach((tag, index) => {
    const target = HEADING_TAGS[Math.min(index + steps, HEADING_TAGS.length - 1)] ?? tag;
    shifted[tag] = components[target];
  });
  return shifted;
}

const IMAGE_CLASS = 'my-2 max-w-full rounded border border-border';

function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const daemonImages = useDaemonImages();
  // 取り出す対象かの判定は `match` だけが持つ: ここで URL を解釈し直すと、資格を送ってよいかの判断経路が2つに増えるため
  const id = daemonImages?.match(src);
  if (daemonImages === undefined || id === undefined) {
    return <ZoomableImage src={src} alt={alt} className={IMAGE_CLASS} />;
  }
  // key に id を入れる: src が変わったとき state を引き継がず、読み込み中から始め直すため（effect の中で戻さない）
  return <DaemonImage key={id} images={daemonImages} id={id} src={src} alt={alt} />;
}

function DaemonImage({
  images,
  id,
  src,
  alt,
}: {
  images: DaemonImages;
  id: string;
  src: string;
  alt: string;
}) {
  // どの接続先・どの id で取った結果かを持つ（#4381）: 接続先が替わった直後の描き直しで、片付けで revoke される前の接続先の blob: を描かないため
  const [fetched, setFetched] = useState<
    { images: DaemonImages; id: string; result: { url: string } | 'failed' } | undefined
  >();
  useEffect(() => {
    const controller = new AbortController();
    let created: string | undefined;
    images.fetch(id, controller.signal).then(
      (blob) => {
        // 外れた後に届いた分は作らない: 作ると revoke する機会が無く、blob が残るため
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setFetched({ images, id, result: { url: created } });
      },
      () => {
        if (!controller.signal.aborted) setFetched({ images, id, result: 'failed' });
      },
    );
    return () => {
      controller.abort();
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [images, id]);
  const state =
    fetched !== undefined && fetched.images === images && fetched.id === id
      ? fetched.result
      : undefined;
  if (state === 'failed') return <ImageFallback src={src} alt={alt} />;
  if (state === undefined) {
    return (
      <span className="my-2 block size-24 animate-pulse rounded-md bg-muted" role="status">
        <span className="sr-only">{alt === '' ? '画像' : alt} を読み込み中</span>
      </span>
    );
  }
  return <ZoomableImage src={state.url} alt={alt} className={IMAGE_CLASS} />;
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
  // id だけを通す: 本文の参照リンクの href がここの id を指し、落とすと死んだリンクになるため
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
    // data-* を明示的に広げる: @types/react の型に汎用の index signature が無く、広げないと destructure できないため
    'data-footnote-ref'?: boolean;
    'data-footnote-backref'?: string;
  }) => (
    // hast 由来の props を丸ごと広げず許可した名前だけを渡す: 本文が持ちうる任意の className / style でこの部品の見た目・安全性を上書きされるため
    // # で始まる href には target / rel を付けない: 付けると脚注のリンクを押すたびに SPA を新しいタブで読み直し、飛ぶ先の要素が無く死ぬため
    // 判定は href の先頭が # かだけにする: URL を解釈して origin を見ると、defaultUrlTransform と合わせて安全性の判断経路が2つに増えるため
    <a
      href={href}
      id={id}
      aria-describedby={ariaDescribedBy}
      aria-label={ariaLabel}
      data-footnote-ref={dataFootnoteRef}
      data-footnote-backref={dataFootnoteBackref}
      target={href?.startsWith('#') ? undefined : '_blank'}
      rel={href?.startsWith('#') ? undefined : 'noreferrer noopener'}
      // 疑似要素で当たり判定だけ広げる: 行の高さ・段落の間隔を動かさずに、タッチ端末で押しにくい文中のリンクを約44pxにするため
      className="break-words text-primary hover:underline pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3"
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
  img: ({ src, alt }) =>
    src === undefined || src === '' ? (
      <img src="" alt={alt ?? ''} className="my-2 max-w-full rounded border border-border" />
    ) : (
      <MarkdownImage src={src} alt={alt ?? ''} />
    ),
  // 横スクロールさせる div で包む: 表は折り返せず、包まないと幅の広い表がカードごと画面外まで広げるため
  // セルの最小幅を lg 未満だけにする: 常に付けるとデスクトップで備考列が詰まるため。コンテナクエリは使わない: 幅を持たない親の中で包みが幅 0 になりうるため
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
  // pre を折り返さず横スクロールにする: 折り返すと崩れる罫線図を保つため。whitespace-pre で styles.css の pre-wrap を上書きする
  pre: ({ children }) => (
    <pre className="mt-2 min-w-0 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[0.85em] whitespace-pre first:mt-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const text = textOf(children);
    if (isBlockCode(className, text)) {
      return <code className="font-mono text-[0.85em]">{children}</code>;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">
        {children}
      </code>
    );
  },
};

/**
 * 脚注の id を描画ごとに一意にする: 1画面に複数描くと固定の id が重複し、2つ目以降の参照が1つ目の脚注を指すため。
 * `useId()` の値は英数字・`_`・`-` 以外を落とす: CSS セレクタ（`#id`）でエスケープせずに引ける形にするため。
 */
export function Markdown({
  children,
  idPrefix,
  headingOffset,
  remoteImages,
}: {
  children: string;
  idPrefix?: string;
  headingOffset?: number;
  remoteImages?: boolean;
}) {
  const reactId = useId();
  const { body } = useDisplayText();
  const daemonImages = useDaemonImages();
  const prefix = idPrefix ?? 'md' + reactId.replace(/[^A-Za-z0-9_-]/g, '') + '-';
  return (
    <div className="min-w-0 text-sm break-words">
      {toReact(children, offsetHeadings(markdownComponents, headingOffset), prefix, {
        display: body,
        remoteImages,
        keepImage:
          daemonImages === undefined ? undefined : (src) => daemonImages.match(src) !== undefined,
      })}
    </div>
  );
}
