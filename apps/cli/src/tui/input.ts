// 出所: takecchi/codiva（MIT）`src/ui/input.ts` と `src/core/key-sequence.ts`
import type { Key } from 'ink';

import {
  backspace,
  clearBuffer,
  deleteForward,
  deleteToLineEnd,
  deleteWordBack,
  insert,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveRowDown,
  moveRowUp,
  newline,
  type TextBuffer,
} from './text-buffer.js';

export interface EditResult {
  buffer: TextBuffer;
  changed: boolean;
}

const result = (prev: TextBuffer, next: TextBuffer): EditResult => ({
  buffer: next,
  changed: next !== prev,
});

// 他の制御文字（C0 / DEL）を入れない: 貼り付けなどの複数文字のチャンクは生テキストで届き、混ざりうるため
export function sanitizeInsertText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n' || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}

export function editText(
  buffer: TextBuffer,
  input: string,
  key: Key,
  opts: { wrapWidth?: number } = {},
): EditResult {
  if (key.ctrl && (input === 'u' || input === 'U')) return result(buffer, clearBuffer(buffer));
  if (key.ctrl && !key.meta) {
    switch (input.toLowerCase()) {
      case 'a':
        return result(buffer, moveLineStart(buffer));
      case 'e':
        return result(buffer, moveLineEnd(buffer));
      case 'w':
        return result(buffer, deleteWordBack(buffer));
      case 'k':
        return result(buffer, deleteToLineEnd(buffer));
    }
  }
  if (key.backspace) return result(buffer, backspace(buffer));
  if (key.delete) return result(buffer, deleteForward(buffer));
  if (key.home) return result(buffer, moveLineStart(buffer));
  if (key.end) return result(buffer, moveLineEnd(buffer));
  if (key.leftArrow) return result(buffer, moveLeft(buffer));
  if (key.rightArrow) return result(buffer, moveRight(buffer));
  if (key.upArrow) return result(buffer, moveRowUp(buffer, opts.wrapWidth));
  if (key.downArrow) return result(buffer, moveRowDown(buffer, opts.wrapWidth));
  if (key.return || key.escape || key.tab || key.ctrl || key.meta || key.pageUp || key.pageDown) {
    return { buffer, changed: false };
  }
  if (input.length > 0) return result(buffer, insert(buffer, sanitizeInsertText(input)));
  return { buffer, changed: false };
}

export type EnterAction =
  { kind: 'newline'; buffer: TextBuffer } | { kind: 'submit'; text: string };

// キャレット直前が `\` ならそれを改行へ置き換える: Shift+Enter を区別できない端末向けの確実な代替のため
export function resolveEnter(buffer: TextBuffer, key: Key): EnterAction {
  if (key.shift || key.meta) return { kind: 'newline', buffer: newline(buffer) };
  if (buffer.cursor > 0 && buffer.value[buffer.cursor - 1] === '\\') {
    return { kind: 'newline', buffer: newline(backspace(buffer)) };
  }
  return { kind: 'submit', text: buffer.value.trim() };
}

export interface DecodedKey {
  kind: 'return' | 'tab' | 'escape' | 'backspace' | 'text';
  text: string;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}

const MODIFY_OTHER_KEYS = /^\[27;(\d+);(\d+)~$/;
const CSI_U = /^\[(\d+)(?:;(\d+))?u$/;

function fromCode(code: number, modifier: number): DecodedKey {
  const mask = Math.max(0, modifier - 1);
  const base = { shift: (mask & 1) !== 0, meta: (mask & 2) !== 0, ctrl: (mask & 4) !== 0 };
  if (code === 13 || code === 10) return { kind: 'return', text: '', ...base };
  if (code === 9) return { kind: 'tab', text: '', ...base };
  if (code === 27) return { kind: 'escape', text: '', ...base };
  if (code === 8 || code === 127) return { kind: 'backspace', text: '', ...base };
  return { kind: 'text', text: code >= 32 ? String.fromCodePoint(code) : '', ...base };
}

export function decodeKeySequence(input: string): DecodedKey | undefined {
  const s = input.startsWith('\x1b') ? input.slice(1) : input;
  const other = MODIFY_OTHER_KEYS.exec(s);
  if (other) return fromCode(Number(other[2]), Number(other[1]));
  const csiU = CSI_U.exec(s);
  if (csiU) return fromCode(Number(csiU[1]), csiU[2] === undefined ? 1 : Number(csiU[2]));
  return undefined;
}

export function normalizeChord(input: string, key: Key): { input: string; key: Key } {
  const chord = decodeKeySequence(input);
  if (!chord) return { input, key };
  return {
    input: chord.kind === 'text' ? chord.text : '',
    key: {
      ...key,
      shift: chord.shift,
      ctrl: chord.ctrl,
      meta: chord.meta,
      return: chord.kind === 'return',
      tab: chord.kind === 'tab',
      escape: chord.kind === 'escape',
      backspace: chord.kind === 'backspace',
    },
  };
}

const IDEOGRAPHIC_SPACE = '　';

// 全角スペースも Space と判定する: 日本語 IME がオンのあいだ、素の Space は全角スペース（U+3000）で届くため
// 入力欄の挿入にはこの正規化を通さない: 打った全角スペースは全角のまま入るのが正しいため
export function isSpaceKey(input: string): boolean {
  return input === ' ' || input === IDEOGRAPHIC_SPACE;
}
