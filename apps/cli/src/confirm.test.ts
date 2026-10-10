import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  ConfirmDeclinedError,
  confirmInRepl,
  confirmIrreversible,
  confirmProceed,
  defaultIo,
  type ConfirmIo,
} from './confirm.js';

function fakeIo(over: Partial<ConfirmIo> & { answer?: string } = {}): {
  io: ConfirmIo;
  written: string[];
  asked: string[];
} {
  const written: string[] = [];
  const asked: string[] = [];
  const io: ConfirmIo = {
    isTTY: over.isTTY ?? true,
    write: (text) => {
      written.push(text);
    },
    ask: async (question) => {
      asked.push(question);
      return over.answer ?? '';
    },
  };
  return { io, written, asked };
}

describe('confirmIrreversible（#3141。形は alteroid reset の確認に揃える）', () => {
  it('--yes なら聞かずに進む（端末でなくても）', async () => {
    const { io, asked, written } = fakeIo({ isTTY: false });

    await expect(confirmIrreversible('消します。', { yes: true }, io)).resolves.toBe(true);

    expect(asked).toEqual([]);
    expect(written).toEqual([]);
  });

  it('端末でなく --yes も無ければ、聞かずに投げる（実行させない。何を・どう省くかを言う）', async () => {
    const { io, asked } = fakeIo({ isTTY: false, answer: 'yes' });

    const error = await confirmIrreversible('記憶 values を消します。', {}, io).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('記憶 values を消します。');
    expect(message).toContain('--yes');
    expect(message).toContain('何も変更していません');
    expect(asked).toEqual([]);
  });

  it('端末で yes（大文字小文字・前後の空白は問わない）なら進む。内容と「取り消せません」を先に見せる', async () => {
    const { io, asked, written } = fakeIo({ answer: '  YES ' });

    await expect(confirmIrreversible('記憶 values を消します。', {}, io)).resolves.toBe(true);

    expect(written.join('')).toContain('記憶 values を消します。');
    expect(written.join('')).toContain('取り消せません。');
    expect(asked).toEqual(['続けるなら yes と入力してください: ']);
  });

  it.each(['y', 'Y', 'ye', 'no', ''])(
    '端末で %j のような yes の全文でない答えは、やめて、決まった例外（ConfirmDeclinedError）を投げる（#3450）',
    async (answer) => {
      const { io, written } = fakeIo({ answer });

      const error = await confirmIrreversible('消します。', {}, io).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConfirmDeclinedError);
      expect((error as Error).message).toBe('取り消しました。何も変更していません。');
      expect(written.join('')).not.toContain('取り消しました');
    },
  );

  // 端末の形（terminal: true）の readline にだけ Ctrl+D の文字（\x04）が届く。実物の reject を通すための偽の端末
  function ctrlDIo(): { io: ConfirmIo; pressCtrlD: () => void } {
    const input = Object.assign(new Readable({ read() {} }), {
      isTTY: true,
      setRawMode: () => input,
    });
    const output = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { isTTY: true });
    const real = defaultIo(input, output);
    return {
      io: { isTTY: true, write: () => {}, ask: real.ask },
      pressCtrlD: () => input.push('\x04'),
    };
  }

  it('答えの前に Ctrl+D が押されたとき（readline の実物が reject する）は、取り消しの文で終わる', async () => {
    const { io, pressCtrlD } = ctrlDIo();
    const pending = confirmIrreversible('消します。', {}, io).catch((e: unknown) => e);
    pressCtrlD();

    const error = await pending;

    expect(error).toBeInstanceOf(ConfirmDeclinedError);
    expect((error as Error).message).toBe('取り消しました。何も変更していません。');
  });

  it('confirmProceed も同じ（Ctrl+D なら取り消しの文で終わる）', async () => {
    const { io, pressCtrlD } = ctrlDIo();
    const pending = confirmProceed('入れます。', {}, io).catch((e: unknown) => e);
    pressCtrlD();

    expect(await pending).toBeInstanceOf(ConfirmDeclinedError);
  });
});

describe('confirmInRepl（REPL の readline で聞く。#3141）', () => {
  it('yes なら進む', async () => {
    const written: string[] = [];
    await expect(
      confirmInRepl(
        'マネージャー m を止めます。',
        async () => 'yes',
        (text) => {
          written.push(text);
        },
        true,
      ),
    ).resolves.toBe(true);
    expect(written.join('')).toContain('取り消せません。');
  });

  it('yes 以外ならやめて、何も変更していないと言う', async () => {
    const written: string[] = [];
    await expect(
      confirmInRepl(
        '消します。',
        async () => 'y',
        (text) => {
          written.push(text);
        },
        true,
      ),
    ).resolves.toBe(false);
    expect(written.join('')).toContain('取り消しました。何も変更していません。');
  });

  it('質問の口が閉じていた（Ctrl-D 等で投げる）ときもやめる', async () => {
    const written: string[] = [];
    await expect(
      confirmInRepl(
        '消します。',
        () => Promise.reject(new Error('closed')),
        (text) => {
          written.push(text);
        },
        true,
      ),
    ).resolves.toBe(false);
    expect(written.join('')).toContain('何も変更していません');
  });

  it('標準入力が端末でない（パイプ）ときは、聞かずに断る。流れてきた yes でも通さない', async () => {
    const written: string[] = [];
    let asked = 0;
    await expect(
      confirmInRepl(
        '消します。',
        async () => {
          asked += 1;
          return 'yes';
        },
        (text) => {
          written.push(text);
        },
        false,
      ),
    ).resolves.toBe(false);
    expect(asked).toBe(0);
    expect(written.join('')).toContain('何も変更していません');
    // 単発のコマンドは無いので、存在しない `--yes` を案内しない
    expect(written.join('')).not.toContain('--yes');
    expect(written.join('')).toContain('端末で alteroid chat を開いて');
  });
});
