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

  it('Backspace はキャレットの前を、Delete は後ろを消す（Ink 7 は \\x7f を backspace、ESC [3~ を delete で届ける）', () => {
    expect(editText(bufferOf('ab'), '', key({ backspace: true })).buffer.value).toBe('a');
    expect(editText(bufferOf('abc', 1), '', key({ delete: true })).buffer).toEqual({
      value: 'ac',
      cursor: 1,
    });
    expect(editText(bufferOf('ab'), '', key({ delete: true })).changed).toBe(false);
  });

  it('Home / End と Ctrl+A / Ctrl+E は論理行（改行で区切った行）の先頭・末尾へ', () => {
    const b = bufferOf('abc\ndef', 5);
    expect(editText(b, '', key({ home: true })).buffer.cursor).toBe(4);
    expect(editText(b, 'a', key({ ctrl: true })).buffer.cursor).toBe(4);
    expect(editText(b, '', key({ end: true })).buffer.cursor).toBe(7);
    expect(editText(b, 'e', key({ ctrl: true })).buffer.cursor).toBe(7);
    expect(editText(bufferOf('abc\ndef', 1), '', key({ end: true })).buffer.cursor).toBe(3);
    expect(editText(bufferOf('abc', 0), '', key({ home: true })).changed).toBe(false);
  });

  it('Ctrl+W は直前の語（空白区切り）を消す。空白だけの手前は飛ばし、行頭では改行を 1 つ消す', () => {
    expect(editText(bufferOf('foo bar'), 'w', key({ ctrl: true })).buffer).toEqual({
      value: 'foo ',
      cursor: 4,
    });
    expect(editText(bufferOf('foo bar  '), 'w', key({ ctrl: true })).buffer.value).toBe('foo ');
    expect(editText(bufferOf('日本語の文 を直す'), 'w', key({ ctrl: true })).buffer.value).toBe(
      '日本語の文 ',
    );
    expect(editText(bufferOf('a\nb', 2), 'w', key({ ctrl: true })).buffer).toEqual({
      value: 'ab',
      cursor: 1,
    });
    expect(editText(bufferOf('a b\nc d', 3), 'w', key({ ctrl: true })).buffer.value).toBe(
      'a \nc d',
    );
    expect(editText(emptyBuffer(), 'w', key({ ctrl: true })).changed).toBe(false);
  });

  it('Ctrl+K はキャレットから行末まで消す。行末なら続く改行を 1 つ消す', () => {
    expect(editText(bufferOf('abc def\nxyz', 4), 'k', key({ ctrl: true })).buffer).toEqual({
      value: 'abc \nxyz',
      cursor: 4,
    });
    expect(editText(bufferOf('abc\nxyz', 3), 'k', key({ ctrl: true })).buffer).toEqual({
      value: 'abcxyz',
      cursor: 3,
    });
    expect(editText(bufferOf('abc'), 'k', key({ ctrl: true })).changed).toBe(false);
  });

  it('Ctrl+U は全部捨てる。ほかの Ctrl（A/E/W/K 以外）はそのまま素通し（changed:false）', () => {
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
