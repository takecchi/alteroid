/**
 * mdast（`mdast-util-from-markdown` の出力）→ React 要素への直接の変換。
 *
 * **`mdast-util-to-hast` を使わない。** 以前は mdast → hast → React の2段で、
 * hast の汎用の器（位置情報・`data.hName` などの拡張口・`structuredClone`・
 * `unist-util-visit`・プロパティ名の変換表）を全部抱えていた。この画面の
 * 入力は `fromMarkdown` + GFM + `newlineToBreak` だけで、出てくる mdast の
 * ノードの種類は閉じている（下の `one` が全部）。だから `mdast-util-to-hast`
 * v13.2.1 の `lib/state.js` / `lib/footer.js` / `lib/revert.js` / `lib/handlers/*.js`
 * を**そのノードの種類ぶんだけ**逐語で読んで移した。**描く DOM を変えないこと
 * が唯一の仕様**で、担保は `markdown-equivalence.test.tsx`（react-markdown
 * 旧実装との `renderToStaticMarkup` の完全一致）である。
 *
 * 途中の表現（`Out`）は、文字列＝hast の `text`、`{ raw }`＝hast の `raw`
 * （生 HTML。**要素にせず文字列として描く**が、`text` とは扱いが違う箇所
 * があるので区別を残す — 改行の直後の先頭空白の除去と、脚注・リストの
 * 組み立てが `text` だけを見る）、`El`＝hast の `element` である。プロパティ名は
 * 最初から React の名前（`aria-label` など）で持つ。
 *
 * 移していないもの（この入力では起きない）: `data.hName` / `hProperties` /
 * `hChildren`、`passThrough`、`unknownHandler`、`clobberPrefix` などの
 * オプション（既定値で固定）、`position`、`yaml` / `toml` ノード、
 * `revert.js`（定義の無い参照を元の書き方へ戻す処理。micromark は定義の無い
 * 参照を参照ノードにしないので届かない — 数万件のランダム入力の差分試験と
 * 等価性コーパスのどれでも一度も呼ばれなかった）。
 */
import type { fromMarkdown } from 'mdast-util-from-markdown';
import type { ComponentProps, ElementType, JSX, ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

type Root = ReturnType<typeof fromMarkdown>;
type MNode = Root | Root['children'][number];
type Parent = Extract<MNode, { children: unknown[] }>;

type Raw = { raw: string };
type El = { t: string; p: Record<string, unknown>; c: Out[] };
type Out = string | Raw | El;

/**
 * タグ名 → 差し替える部品。無いタグは素の要素（`section` / `sup` /
 * `input` / `br` など）のまま描く。
 */
export type Components = {
  [Tag in keyof JSX.IntrinsicElements]?: (props: ComponentProps<Tag>) => ReactNode;
};

const el = (t: string, p: Record<string, unknown>, c: Out[] = []): El => ({ t, p, c });
const isEl = (n: Out | undefined): n is El => typeof n === 'object' && 't' in n;

/**
 * 危険なプロトコルの URL を空にする。react-markdown の `defaultUrlTransform`
 * （`react-markdown/lib/index.js`）を逐語で移したもの。`javascript:` や
 * `data:` は許可するプロトコル以外として空になる。
 */
const safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i;

function defaultUrlTransform(value: string): string {
  const colon = value.indexOf(':');
  const questionMark = value.indexOf('?');
  const numberSign = value.indexOf('#');
  const slash = value.indexOf('/');

  if (
    // プロトコルが無い（相対）。
    colon === -1 ||
    // 最初の `:` が `?` `#` `/` より後なら、プロトコルではない。
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    // 許可するプロトコル。
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }

  return '';
}

const isAlnum = (c: string) => /^[\dA-Za-z]$/.test(c);

/**
 * URL を `%` エンコードして正規化する。`micromark-util-sanitize-uri` の
 * `normalizeUri` の逐語（`asciiAlphanumeric` は正規表現へ置き換えた。
 * 範囲外の位置は `charAt` が空文字を返すので偽になる）。
 */
function normalizeUri(value: string): string {
  const result: string[] = [];
  let index = -1;
  let start = 0;
  let skip = 0;

  while (++index < value.length) {
    const code = value.charCodeAt(index);
    let replace = '';

    if (code === 37 && isAlnum(value.charAt(index + 1)) && isAlnum(value.charAt(index + 2))) {
      skip = 2;
    } else if (code < 128) {
      if (!/[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(code))) {
        replace = String.fromCharCode(code);
      }
    } else if (code > 55_295 && code < 57_344) {
      const next = value.charCodeAt(index + 1);
      if (code < 56_320 && next > 56_319 && next < 57_344) {
        replace = String.fromCharCode(code, next);
        skip = 1;
      } else {
        replace = '�';
      }
    } else {
      replace = String.fromCharCode(code);
    }

    if (replace) {
      result.push(value.slice(start, index), encodeURIComponent(replace));
      start = index + skip + 1;
    }

    if (skip) {
      index += skip;
      skip = 0;
    }
  }

  return result.join('') + value.slice(start);
}

/** `normalizeUri` のあと `defaultUrlTransform` を通す（href / src の値）。 */
const safeUrl = (url: string) => defaultUrlTransform(normalizeUri(url));

const isSpace = (code: number) => code === 9 || code === 32;

/** 先頭の半角スペースとタブを落とす。`state.js` の `trimMarkdownSpaceStart`。 */
function trimStart(value: string): string {
  let index = 0;
  while (isSpace(value.charCodeAt(index))) index++;
  return value.slice(index);
}

/**
 * 各行の前後の半角スペースとタブを落とす。`trim-lines` の逐語と同じ結果
 * （先頭行の頭と最終行の末尾は落とさない）。
 */
function trimLines(value: string): string {
  const parts = value.split(/(\r?\n|\r)/);
  const lines = (parts.length + 1) / 2;
  return parts
    .map((part, i) => {
      if (i % 2) return part;
      const line = i / 2;
      let from = 0;
      let to = part.length;
      if (line > 0) while (isSpace(part.charCodeAt(from))) from++;
      if (line < lines - 1) while (to > from && isSpace(part.charCodeAt(to - 1))) to--;
      return part.slice(from, to);
    })
    .join('');
}

/** ノード列の間に改行を挟む（`state.wrap`）。`loose` は前後にも。 */
function wrap(nodes: Out[], loose?: boolean): Out[] {
  const result: Out[] = [];
  if (loose) result.push('\n');
  nodes.forEach((node, i) => {
    if (i) result.push('\n');
    result.push(node);
  });
  if (loose && nodes.length > 0) result.push('\n');
  return result;
}

function listItemLoose(node: Parent): boolean {
  const spread = (node as { spread?: boolean | null }).spread;
  return spread === null || spread === undefined ? node.children.length > 1 : spread;
}

function listLoose(node: Parent): boolean {
  let loose = false;
  if (node.type === 'list') {
    loose = node.spread || false;
    for (let i = 0; !loose && i < node.children.length; i++) {
      loose = listItemLoose(node.children[i]!);
    }
  }
  return loose;
}

function convert(tree: Root): Out[] {
  const definitions = new Map<string, MNode & { type: 'definition' }>();
  const footnotes = new Map<string, MNode & { type: 'footnoteDefinition' }>();
  const footnoteOrder: string[] = [];
  const footnoteCounts = new Map<string, number>();

  // `definition` / `footnoteDefinition` は先に見つけた（文書順の）ものが勝つ。
  (function collect(node: MNode) {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const id = String(node.identifier).toUpperCase();
      if (node.type === 'definition') {
        if (!definitions.has(id)) definitions.set(id, node);
      } else if (!footnotes.has(id)) footnotes.set(id, node);
    }
    if ('children' in node) (node.children as MNode[]).forEach(collect);
  })(tree);

  function all(parent: Parent): Out[] {
    const values: Out[] = [];
    const nodes = parent.children as MNode[];
    nodes.forEach((child, i) => {
      let result = one(child, parent);
      if (result === undefined) return;
      // 改行（`<br>`）の直後の先頭の空白は落とす。生 HTML（`raw`）と配列は対象外。
      if (i && nodes[i - 1]!.type === 'break' && !Array.isArray(result)) {
        if (typeof result === 'string') {
          result = trimStart(result);
        } else if (isEl(result)) {
          const head = result.c[0];
          if (typeof head === 'string') result.c[0] = trimStart(head);
        }
      }
      if (Array.isArray(result)) values.push(...result);
      else values.push(result);
    });
    return values;
  }

  function one(node: MNode, parent: Parent): Out | Out[] | undefined {
    switch (node.type) {
      case 'paragraph':
        return el('p', {}, all(node));
      case 'heading':
        return el('h' + node.depth, {}, all(node));
      case 'blockquote':
        return el('blockquote', {}, wrap(all(node), true));
      case 'thematicBreak':
        return el('hr', {});
      case 'emphasis':
        return el('em', {}, all(node));
      case 'strong':
        return el('strong', {}, all(node));
      case 'delete':
        return el('del', {}, all(node));
      case 'text':
        return trimLines(String(node.value));
      case 'html':
        // `allowDangerousHtml: true` — 要素にせず、最後に文字列として描く。
        return { raw: node.value };
      case 'break':
        return [el('br', {}), '\n'];
      case 'inlineCode':
        return el('code', {}, [node.value.replace(/\r?\n|\r/g, ' ')]);
      case 'code': {
        const p: Record<string, unknown> = {};
        if (node.lang) p.className = 'language-' + node.lang.split(/\s+/)[0];
        return el('pre', {}, [el('code', p, [node.value ? node.value + '\n' : ''])]);
      }
      case 'link': {
        const p: Record<string, unknown> = { href: safeUrl(node.url) };
        if (node.title !== null && node.title !== undefined) p.title = node.title;
        return el('a', p, all(node));
      }
      case 'image': {
        const p: Record<string, unknown> = { src: safeUrl(node.url) };
        if (node.alt !== null && node.alt !== undefined) p.alt = node.alt;
        if (node.title !== null && node.title !== undefined) p.title = node.title;
        return el('img', p);
      }
      case 'linkReference': {
        // 定義が無い参照は、そもそも micromark が参照にしない（`[x][none]` は
        // テキストのまま）ので、ここには来ない。to-hast の `revert` は移していない。
        const def = definitions.get(String(node.identifier).toUpperCase());
        if (!def) return undefined;
        const p: Record<string, unknown> = { href: safeUrl(def.url || '') };
        if (def.title !== null && def.title !== undefined) p.title = def.title;
        return el('a', p, all(node));
      }
      case 'imageReference': {
        const def = definitions.get(String(node.identifier).toUpperCase());
        if (!def) return undefined;
        const p: Record<string, unknown> = { src: safeUrl(def.url || ''), alt: node.alt };
        if (def.title !== null && def.title !== undefined) p.title = def.title;
        // 値が null / undefined の属性は描かない（旧実装の hast → React と同じ）。
        if (p.alt === null || p.alt === undefined) delete p.alt;
        return el('img', p);
      }
      case 'list': {
        const p: Record<string, unknown> = {};
        const results = all(node);
        if (typeof node.start === 'number' && node.start !== 1) p.start = node.start;
        if (results.some((r) => isEl(r) && r.t === 'li' && r.p.className === 'task-list-item')) {
          p.className = 'contains-task-list';
        }
        return el(node.ordered ? 'ol' : 'ul', p, wrap(results, true));
      }
      case 'listItem': {
        const results = all(node);
        // 親は常に `list`（`listItem` だけが単独で来ることは無い）。
        const loose = listLoose(parent);
        const p: Record<string, unknown> = {};
        const children: Out[] = [];
        if (typeof node.checked === 'boolean') {
          const head = results[0];
          let paragraph: El;
          if (isEl(head) && head.t === 'p') {
            paragraph = head;
          } else {
            paragraph = el('p', {});
            results.unshift(paragraph);
          }
          if (paragraph.c.length > 0) paragraph.c.unshift(' ');
          const checkbox = { type: 'checkbox', checked: node.checked, disabled: true };
          paragraph.c.unshift(el('input', checkbox));
          p.className = 'task-list-item';
        }
        results.forEach((child, i) => {
          const isP = isEl(child) && child.t === 'p';
          if (loose || i !== 0 || !isP) children.push('\n');
          if (isP && !loose) children.push(...(child as El).c);
          else children.push(child);
        });
        const tail = results[results.length - 1];
        if (tail !== undefined && (loose || !isEl(tail) || tail.t !== 'p')) children.push('\n');
        return el('li', p, children);
      }
      case 'table': {
        const align = node.align;
        const rows = node.children.map((row, rowIndex) => {
          const tag = rowIndex === 0 ? 'th' : 'td';
          // 行の列数は表の揃えの数（`table-row.js`）。足りないセルは空で補う。
          const length = align ? align.length : row.children.length;
          const cells = Array.from({ length }, (_, i) => {
            const cell = row.children[i];
            const alignValue = align ? align[i] : undefined;
            // 表のセルの揃えは `align` 属性ではなく `style` で出す。
            const p = alignValue ? { style: { textAlign: alignValue } } : {};
            return el(tag, p, cell ? all(cell) : []);
          });
          // 表の構造要素の直下には空白の文字列を置かない（React の警告になる）。
          return el('tr', {}, cells);
        });
        const first = rows.shift();
        const content: Out[] = [];
        if (first) content.push(el('thead', {}, [first]));
        if (rows.length > 0) content.push(el('tbody', {}, rows));
        return el('table', {}, content);
      }
      case 'footnoteReference': {
        const id = String(node.identifier).toUpperCase();
        const safeId = normalizeUri(id.toLowerCase());
        const index = footnoteOrder.indexOf(id);
        let counter: number;
        let reuse = footnoteCounts.get(id);
        if (reuse === undefined) {
          reuse = 0;
          footnoteOrder.push(id);
          counter = footnoteOrder.length;
        } else {
          counter = index + 1;
        }
        reuse += 1;
        footnoteCounts.set(id, reuse);
        return el('sup', {}, [
          el(
            'a',
            {
              href: '#user-content-fn-' + safeId,
              id: 'user-content-fnref-' + safeId + (reuse > 1 ? '-' + reuse : ''),
              'data-footnote-ref': true,
              'aria-describedby': 'footnote-label',
            },
            [String(counter)],
          ),
        ]);
      }
      default:
        // `definition` / `footnoteDefinition` は描かない（脚注は末尾の節へ集める）。
        return undefined;
    }
  }

  const out = wrap(all(tree));

  // 脚注の節。参照された順（途中で増えうる）に、定義を描く。
  const items: Out[] = [];
  for (let referenceIndex = 0; referenceIndex < footnoteOrder.length; referenceIndex++) {
    const definition = footnotes.get(footnoteOrder[referenceIndex]!);
    if (!definition) continue;
    const content = all(definition);
    const id = String(definition.identifier).toUpperCase();
    const safeId = normalizeUri(id.toLowerCase());
    const back: Out[] = [];
    const counts = footnoteCounts.get(id);
    for (let re = 1; counts !== undefined && re <= counts; re++) {
      if (back.length > 0) back.push(' ');
      back.push(
        el(
          'a',
          {
            href: '#user-content-fnref-' + safeId + (re > 1 ? '-' + re : ''),
            'data-footnote-backref': '',
            'aria-label': 'Back to reference ' + (referenceIndex + 1) + (re > 1 ? '-' + re : ''),
            className: 'data-footnote-backref',
          },
          ['↩', ...(re > 1 ? [el('sup', {}, [String(re)])] : [])],
        ),
      );
    }
    const tail = content[content.length - 1];
    if (isEl(tail) && tail.t === 'p') {
      const last = tail.c[tail.c.length - 1];
      if (typeof last === 'string') tail.c[tail.c.length - 1] = last + ' ';
      else tail.c.push(' ');
      tail.c.push(...back);
    } else {
      content.push(...back);
    }
    items.push(el('li', { id: 'user-content-fn-' + safeId }, wrap(content, true)));
  }
  if (items.length > 0) {
    out.push(
      '\n',
      el('section', { 'data-footnotes': true, className: 'footnotes' }, [
        el('h2', { className: 'sr-only', id: 'footnote-label' }, ['Footnotes']),
        '\n',
        el('ol', {}, wrap(items, true)),
        '\n',
      ]),
    );
  }
  return out;
}

function withChildren(props: Record<string, unknown>, children: ReactNode[]) {
  if (children.length > 0) {
    const value = children.length > 1 ? children : children[0];
    if (value) props.children = value;
  }
}

function create(type: ElementType, props: Record<string, unknown>, key?: string) {
  const fn = Array.isArray(props.children) ? jsxs : jsx;
  return key ? fn(type, props, key) : fn(type, props);
}

function toChildren(nodes: Out[], components: Components): ReactNode[] {
  const counts = new Map<string, number>();
  return nodes.map((child) => {
    if (typeof child === 'string') return child;
    // 生 HTML。要素にせず、そのままテキストとして見せる。
    if (!isEl(child)) return child.raw;
    // 同じタグ名の兄弟に連番を振ってキーにする（キーの警告を出さない）。
    const count = counts.get(child.t) ?? 0;
    counts.set(child.t, count + 1);
    const props = { ...child.p };
    withChildren(props, toChildren(child.c, components));
    const type: ElementType = Object.hasOwn(components, child.t)
      ? (components[child.t as keyof Components] as ElementType)
      : (child.t as ElementType);
    return create(type, props, `${child.t}-${count}`);
  });
}

/** Markdown の構文木を React 要素にする。`components` はタグ名ごとの差し替え。 */
export function mdastToReact(tree: Root, components: Components): ReactNode {
  const props: Record<string, unknown> = {};
  withChildren(props, toChildren(convert(tree), components));
  return create(Fragment, props);
}
