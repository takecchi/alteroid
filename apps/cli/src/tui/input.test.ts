import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';

import {
  decodeKeySequence,
  editText,
  isSpaceKey,
  normalizeChord,
  resolveEnter,
  sanitizeInsertText,
} from './input.js';
import { bufferOf, emptyBuffer } from './text-buffer.js';

const key = (patch: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  ...patch,
});

describe('editText', () => {
  it('文字を挿入する。全角スペースは全角のまま入る', () => {
    const r = editText(emptyBuffer(), 'あ　い', key());
    expect(r).toEqual({ buffer: { value: 'あ　い', cursor: 3 }, changed: true });
  });

  it('Backspace と macOS の delete はキャレットの前を消す', () => {
    expect(editText(bufferOf('ab'), '', key({ backspace: true })).buffer.value).toBe('a');
    expect(editText(bufferOf('ab'), '', key({ delete: true })).buffer.value).toBe('a');
  });

  it('Ctrl+U は全部捨てる。他の Ctrl はそのまま素通し（changed:false）', () => {
    expect(editText(bufferOf('abc'), 'u', key({ ctrl: true })).buffer.value).toBe('');
    expect(editText(bufferOf('abc'), 'x', key({ ctrl: true })).changed).toBe(false);
  });

  it('画面が担当するキー（Enter・Tab・Esc・PgUp/PgDn）には触らない', () => {
    for (const patch of [{ return: true }, { tab: true }, { escape: true }, { pageUp: true }]) {
      expect(editText(bufferOf('abc'), '', key(patch)).changed).toBe(false);
    }
  });

  it('矢印でキャレットが動く（↑↓ は wrapWidth があれば表示行で動く）', () => {
    expect(editText(bufferOf('ab'), '', key({ leftArrow: true })).buffer.cursor).toBe(1);
    expect(
      editText(bufferOf('あいうえお'), '', key({ upArrow: true }), { wrapWidth: 6 }).buffer.cursor,
    ).toBe(2);
  });

  it('貼り付けの制御文字を落とし、CRLF を LF にし、タブを空白にする', () => {
    expect(sanitizeInsertText('a\r\nb\tc\u0007d\u007f')).toBe('a\nb cd');
    expect(editText(emptyBuffer(), 'x\ry', key()).buffer.value).toBe('x\ny');
  });
});

describe('resolveEnter', () => {
  it('素の Enter は送信（前後の空白は落とす）', () => {
    expect(resolveEnter(bufferOf('  hi  '), key({ return: true }))).toEqual({
      kind: 'submit',
      text: 'hi',
    });
  });

  it('Shift / Meta + Enter は改行', () => {
    const r = resolveEnter(bufferOf('a'), key({ return: true, shift: true }));
    expect(r).toEqual({ kind: 'newline', buffer: { value: 'a\n', cursor: 2 } });
  });

  it('キャレット直前の \\ は改行に置き換わる（Shift+Enter を送れない端末向け）', () => {
    const r = resolveEnter(bufferOf('a\\'), key({ return: true }));
    expect(r).toEqual({ kind: 'newline', buffer: { value: 'a\n', cursor: 2 } });
  });
});

describe('modifyOtherKeys / CSI-u の復号', () => {
  it('Shift+Enter（`[27;2;13~` と `[13;2u`）は Shift 付きの Return になる', () => {
    expect(decodeKeySequence('[27;2;13~')).toMatchObject({ kind: 'return', shift: true });
    expect(decodeKeySequence('\x1b[13;2u')).toMatchObject({ kind: 'return', shift: true });
  });

  it('普通の文字列は復号しない', () => {
    expect(decodeKeySequence('hello')).toBeUndefined();
    expect(decodeKeySequence('[1;2A')).toBeUndefined();
  });

  it('normalizeChord は修飾付き Enter を return+shift の組へ直す', () => {
    const { input, key: k } = normalizeChord('[27;2;13~', key());
    expect(input).toBe('');
    expect(k).toMatchObject({ return: true, shift: true });
    expect(resolveEnter(bufferOf('a'), k).kind).toBe('newline');
  });
});

describe('isSpaceKey（日本語 IME のオンでは Space が全角で届く）', () => {
  it('半角・全角のどちらも Space', () => {
    expect(isSpaceKey(' ')).toBe(true);
    expect(isSpaceKey('　')).toBe(true);
    expect(isSpaceKey('a')).toBe(false);
  });
});
