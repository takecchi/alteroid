import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// clone.ts のソースを走査して「書き換えの前後で変わらないこと」を固定する試験の共通の道具。
// 日誌の1行の固定（`clone-journal-self-sites-pin.test.ts`）と、振り分けの case の中身の固定（`clone-dispatch-cases-pin.test.ts`）が使う。
// 1つの試験に写さず、ここに置く: 文字列・テンプレート・コメントの読み飛ばし方が2つの試験でずれると、片方だけが見逃すため。

export const CLONE_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clone.ts');

export function readCloneSource(): string {
  return readFileSync(CLONE_TS, 'utf8');
}

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

/** `index` を囲む宣言（メソッド・関数）の名前。行頭から2字下げまでの宣言を、上へ遡って探す。 */
export function enclosingDeclaration(text: string, index: number): string {
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
export function readGroup(text: string, from: number): { close: number; commas: number[] } {
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
export function splitGroup(text: string, open: number): string[] {
  const { close, commas } = readGroup(text, open);
  const bounds = [open, ...commas, close];
  const parts: string[] = [];
  for (let k = 0; k + 1 < bounds.length; k += 1) {
    parts.push(text.slice(bounds[k]! + 1, bounds[k + 1]!));
  }
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 式の外側（コードの部分）の空白を1つに畳み、コメントを落とす。文字列（'…' / "…"）とテンプレートの地の文は、1文字も変えずに残す。
 * テンプレートの `${…}` の中はコードとして畳む。
 * 畳む理由: 書き換えると prettier が折り返しと字下げを変え、コメントの置き場所も動きうるため。文字列を畳まない理由: 書き換えの途中で文言の中の空白・改行を誤って変えたら見えるようにするため。
 */
export function squash(expression: string): string {
  let out = '';
  // `` ` `` はテンプレートの地の文の中、`${` はその中の式の中を表す
  const stack: string[] = [];
  let pendingSpace = false;
  const emit = (chunk: string): void => {
    // `${` の直後の空白も落とす（閉じの前と同じ理由）
    if (pendingSpace && out !== '' && !out.endsWith('${')) out += ' ';
    pendingSpace = false;
    out += chunk;
  };
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i]!;
    if (stack.at(-1) === '`') {
      if (ch === '\\') {
        out += expression.slice(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        out += ch;
        stack.pop();
        i += 1;
      } else if (ch === '$' && expression[i + 1] === '{') {
        out += '${';
        stack.push('${');
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i += 1;
      continue;
    }
    if (ch === '/' && expression[i + 1] === '/') {
      const newline = expression.indexOf('\n', i);
      i = newline === -1 ? expression.length : newline;
      pendingSpace = true;
      continue;
    }
    if (ch === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      i = end === -1 ? expression.length : end + 2;
      pendingSpace = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < expression.length && expression[j] !== ch) j += expression[j] === '\\' ? 2 : 1;
      emit(expression.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      emit(ch);
      stack.push('`');
      i += 1;
      continue;
    }
    if (ch === '}' && stack.at(-1) === '${') {
      // `${…}` の閉じの前の空白は落とす（prettier が `${ x }` の形に折ることがあるため）
      pendingSpace = false;
      out += ch;
      stack.pop();
      i += 1;
      continue;
    }
    emit(ch);
    i += 1;
  }
  return out.trim();
}
