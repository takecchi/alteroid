import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// clone.ts で日誌へ `with: 'self'` の1行を書く箇所を、塊ごとに `#journalSelf(role, text)` へ寄せていく（#6333 で最初の塊）。
// 寄せる変更が壊しうるのは、各箇所の `role` と `text` の式だけである（helper の中身は `#journal({ type: 'exchange', with: 'self', role, text })` の1行）。
// そこで、書き込み箇所すべてについて「囲むメソッド・role・text の式」を取り出し、その一覧を固定する。
// 寄せる前（`this.#journal({ type: 'exchange', with: 'self', role, text })`）と寄せた後（`this.#journalSelf(role, text)`）は、同じ1行として取り出される。
//
// 式の空白は1つに畳んでから比べる: 寄せると prettier が式の折り返しと字下げを変えるため。
// そのぶん、文字列の中の連続した空白・改行の違いは、この試験では見えない（文言そのものは実行時の試験が持つ）。

const CLONE_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clone.ts');

const DECLARATION_RE =
  /^ {0,2}(?:(?:export|default|public|private|protected|static|async|readonly)\s+)*(?:function\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*[(<]/;
const NOT_A_DECLARATION = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'await',
  'throw',
]);

function enclosingDeclaration(text: string, index: number): string {
  const lines = text.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const m = DECLARATION_RE.exec(line);
    if (m && !NOT_A_DECLARATION.has(m[1]!) && !line.trimEnd().endsWith(';')) return m[1]!;
  }
  return '<top>';
}

/**
 * `from` の開き括弧（`{` / `(`）から対応する閉じまでを読み、閉じの位置と、深さ 1 の `,` の位置を返す。
 * 文字列（'…' / "…"）・テンプレートの地の文・コメント（`//` と `/* *\/`）は数えない。テンプレートの `${…}` の中は式として数える。
 */
function readGroup(text: string, from: number): { close: number; commas: number[] } {
  const stack: string[] = [];
  const commas: number[] = [];
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    const top = stack.at(-1);
    if (top === '`') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i += 1;
      } else if (ch === '$' && text[i + 1] === '{') {
        stack.push('${');
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '`') stack.push('`');
    else if (ch === '{' || ch === '(' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ')' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return { close: i, commas };
    } else if (ch === ',' && stack.length === 1) commas.push(i);
    i += 1;
  }
  return { close: -1, commas };
}

/** 括弧の中身を、深さ 1 の `,` で分ける。 */
function splitGroup(text: string, open: number): string[] {
  const { close, commas } = readGroup(text, open);
  const bounds = [open, ...commas, close];
  const parts: string[] = [];
  for (let k = 0; k + 1 < bounds.length; k += 1) {
    parts.push(text.slice(bounds[k]! + 1, bounds[k + 1]!));
  }
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

// 空白を1つに畳み、行コメント（`// …` の行末まで）を落とす: 寄せると prettier が折り返しを変え、コメントの置き場所も式の外へ動きうるため
const squash = (expression: string): string =>
  expression
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();

interface SelfSite {
  readonly start: number;
  readonly line: string;
}

/** `with: 'self'` の exchange の書き込み箇所を、出てくる順に「囲むメソッド role text」の1行で返す。 */
function selfSites(text: string): string[] {
  const sites: SelfSite[] = [];
  const literalRe = /\bthis\.#journal\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const fields = new Map<string, string>();
    for (const raw of splitGroup(text, open)) {
      const part = squash(raw);
      const field = /^([A-Za-z_$][\w$]*)\s*:/.exec(part);
      if (field === null) fields.set(part, part);
      else fields.set(field[1]!, part.slice(field[0].length).trim());
    }
    if (fields.get('type') !== "'exchange'" || fields.get('with') !== "'self'") continue;
    // 欄が4つを超える行（`conversationId` などを持つ）は寄せない。区別のため印を付けて一覧に残す
    const extra = [...fields.keys()].filter(
      (key) => !['type', 'with', 'role', 'text'].includes(key),
    );
    const mark = extra.length === 0 ? '' : ` [+${extra.join(',')}]`;
    sites.push({
      start: m.index,
      line: `${enclosingDeclaration(text, m.index)} ${squash(fields.get('role') ?? '?')} ${squash(fields.get('text') ?? '?')}${mark}`,
    });
  }
  const helperRe = /\bthis\.#journalSelf\(/g;
  while ((m = helperRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const [role, textExpression] = splitGroup(text, open);
    sites.push({
      start: m.index,
      line: `${enclosingDeclaration(text, m.index)} ${squash(role ?? '?')} ${squash(textExpression ?? '?')}`,
    });
  }
  return sites.sort((a, b) => a.start - b.start).map((site) => site.line);
}

describe('clone.ts の、日誌へ with: self の1行を書く箇所の role と text の式を固定する（#journalSelf へ寄せる前後で変わらないことの歯）', () => {
  it('書き込み箇所の一覧（囲むメソッド・role・text の式）が変わらない', () => {
    expect(selfSites(readFileSync(CLONE_TS, 'utf8'))).toMatchSnapshot();
  });

  it('走査が箇所を見つけられない状態（走査の故障）を通さない', () => {
    // 寄せ終わっても `#journalSelf(` の呼び出しとして数えられるので、0 にはならない
    expect(selfSites(readFileSync(CLONE_TS, 'utf8')).length).toBeGreaterThan(50);
  });
});
