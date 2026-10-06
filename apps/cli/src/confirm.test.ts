import { describe, expect, it } from 'vitest';

import { confirmInRepl, confirmIrreversible, type ConfirmIo } from './confirm.js';

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
    // 標準入力に `yes` が流れていても通さない（スクリプトの黙った実行を作らない）。
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
    '端末で %j のような yes の全文でない答えは、やめて「何も変更していません」と言う',
    async (answer) => {
      const { io, written } = fakeIo({ answer });

      await expect(confirmIrreversible('消します。', {}, io)).resolves.toBe(false);

      expect(written.join('')).toContain('取り消しました。何も変更していません。');
    },
  );
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
    expect(written.join('')).toContain('--yes');
  });
});
