import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { type ConfirmIo } from './confirm.js';
import { captureStderr, captureStdout, pretendTty } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
}));

const {
  freshnessMarker,
  memoryEditCommand,
  memoryListCommand,
  memoryRemoveCommand,
  memorySetCommand,
  memoryShowCommand,
} = await import('./memory.js');

interface Sent {
  url: string;
  method: string;
  body: string | undefined;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;

let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({
      url,
      method: init?.method ?? request.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid memory set', () => {
  it('ファイルの内容を PUT /memory/<slug> へ全文置換で送る', async () => {
    const read = captureStdout();
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'values.md');
    await writeFile(path, '# 価値観\n\n嘘をつかない。\n', 'utf8');
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 200, body: { document: { slug: 'values', content: 'x' } } });

    await memorySetCommand('values', { file: path });

    expect(sent.map((entry) => entry.method)).toEqual(['GET', 'PUT']);
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/memory/values');
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      content: '# 価値観\n\n嘘をつかない。\n',
    });
    expect(read()).toContain('次の会話からクローンの判断に入ります');
  });

  it('書き換えられなければ、書き換えたとは言わない（例外の文言で確かめる。#1641）', async () => {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });

    const error = await memorySetCommand('..', { file: path }).catch((e: unknown) => e);

    expect(String(error)).toContain('書き換えられませんでした');
    expect(String(error)).not.toContain('次の会話から');
  });
});

describe('alteroid memory set の空の本文（#3456）', () => {
  async function emptyFile(content: string): Promise<string> {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'empty.md');
    await writeFile(path, content, 'utf8');
    return path;
  }

  it.each([
    ['空', ''],
    ['空白だけ', ' \n\t\n'],
  ])(
    '既存の記憶があるとき、本文が%sなら、上書きせずに断る（--allow-empty を案内する）',
    async (_name, body) => {
      const read = captureStdout();
      replies.push({ status: 200, body: { document: { slug: 'x', content: '大事な記憶\n' } } });

      const error = await memorySetCommand('x', { file: await emptyFile(body), yes: true }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('本文が空');
      expect((error as Error).message).toContain('--allow-empty');
      expect(sent.filter((entry) => entry.method === 'PUT')).toEqual([]);
      expect(read()).not.toContain('書き換えました');
    },
  );

  it('新しく作るときも、本文が空なら断る（profile set と同じ）', async () => {
    captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(memorySetCommand('x', { file: await emptyFile('') })).rejects.toThrow(
      '--allow-empty',
    );
    expect(sent.filter((entry) => entry.method === 'PUT')).toEqual([]);
  });

  it('--allow-empty を付けたときだけ、空の本文で置き換える', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { document: { slug: 'x', content: '大事な記憶\n' } } });
    replies.push({ status: 200, body: { document: { slug: 'x', content: '' } } });

    await memorySetCommand('x', { file: await emptyFile(''), yes: true, allowEmpty: true });

    const puts = sent.filter((entry) => entry.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]?.body ?? '{}')).toEqual({ content: '' });
    expect(read()).toContain('書き換えました: x');
  });
});

describe('alteroid memory show の版と remove --if-match（#2919）', () => {
  it('show は版を stderr に1行出し、stdout は本文だけのまま（パイプを壊さない）', async () => {
    const read = captureStdout();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-shown' },
    });

    await memoryShowCommand('values');

    expect(read()).toBe('# 価値観\n');
    const errText = err.mock.calls.map((c) => String(c[0])).join('');
    expect(errText).toContain('v-shown');
    expect(errText).toContain('--if-match v-shown');
    expect(errText.trimEnd().split('\n')).toHaveLength(1);
  });

  it('show で読んだ後に別の書き手が書いたなら、remove --if-match <show の版> は消さずに失敗する（再現）', async () => {
    const read = captureStdout();
    replies.push({
      status: 409,
      body: {
        error: 'x',
        current: { document: { slug: 'values', content: '新' }, version: 'v-now' },
      },
    });

    const error = await memoryRemoveCommand('values', { ifMatch: 'v-shown', yes: true }).catch(
      (e: unknown) => e,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/memory/values?ifMatch=v-shown');
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('消しませんでした');
    expect(read()).toContain('消していません: values');
  });

  it('remove --if-match で版が合えば消せる', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });
    await memoryRemoveCommand('values', { ifMatch: 'v-shown', yes: true });
    expect(sent).toHaveLength(1);
    expect(read()).toContain('消しました: values');
  });
});

describe('alteroid memory remove', () => {
  it('読んだ版を ifMatch に付けて DELETE /memory/<slug> を打つ（#2881）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });

    await memoryRemoveCommand('values', { yes: true });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[1]?.method).toBe('DELETE');
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/memory/values?ifMatch=v-read');
    expect(read()).toContain('消しました: values');
  });

  it('古いデーモン（段階1。version を返さず、版なしの削除を通す）には版を付けずに打つ', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { document: { slug: 'values', content: 'x' } } });
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });

    await memoryRemoveCommand('values', { yes: true });

    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/memory/values');
    expect(read()).toContain('消しました: values');
  });

  it('428（版なしを断られた。版を返さない古いデーモンの先で版必須のデーモンに当たった）なら、消していないと言って失敗する（#2881）', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { document: { slug: 'values', content: 'x' } } });
    replies.push({
      status: 428,
      body: { error: '版が無いので消していません（消していません）', current: null },
    });

    const error = await memoryRemoveCommand('values', { yes: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('消していません');
    expect(String(error)).toContain('428');
    expect(String(error)).toContain('--if-match');
    expect(read()).not.toContain('消しました');
  });

  it('409（読んだ後に変わっていた）なら、消していないと言い、いまの版と次の手を案内して失敗する（#2881）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    replies.push({
      status: 409,
      body: {
        error: '記憶が読んだ後に変わっています（消していません）',
        current: {
          document: { slug: 'values', content: '# 価値観\n\nクローンが蒸留\n' },
          version: 'v-now',
        },
      },
    });

    const error = await memoryRemoveCommand('values', { yes: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('消しませんでした');
    const text = read();
    expect(text).toContain('消していません: values');
    expect(text).toContain('v-now');
    expect(text).toContain('alteroid memory show values');
    expect(text).toContain('alteroid memory remove values');
    expect(text).not.toContain('消しました');
  });

  it('409 で current が null（読んだ後に消されていた）なら、そう言う', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: 'x' }, version: 'v' },
    });
    replies.push({ status: 409, body: { error: 'x', current: null } });

    await memoryRemoveCommand('values', { yes: true }).catch(() => undefined);

    expect(read()).toContain('すでに消されています');
  });

  it('「無い」と「名前として不正」を混ぜない（どちらも例外を投げる。#1641）', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });
    const missing = await memoryRemoveCommand('missing', { yes: true }).catch((e: unknown) => e);
    expect(String(missing)).toContain('そんな記憶はありません');

    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });
    const invalid = await memoryRemoveCommand('..', { yes: true }).catch((e: unknown) => e);
    expect(String(invalid)).toContain('名前として成立しません');
    expect(String(invalid)).not.toContain('そんな記憶はありません');
    expect(sent.map((entry) => entry.method)).toEqual(['GET', 'GET']);
  });
});

describe('#1641 の再現（Issue 本文）', () => {
  it('memory set: PUT が 500 なら投げる', async () => {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 500, body: { error: '内部エラー' } });

    await expect(memorySetCommand('some-slug', { file: path })).rejects.toThrow('内部エラー');
  });

  it('memory set: PUT が 401 なら投げる（名前が不正、と案内しない）', async () => {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 401, body: {} });

    const error = await memorySetCommand('some-slug', { file: path }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('名前が不正');
  });

  it('memory remove: DELETE が 500 なら投げる（「そんな記憶はありません」に化けない）', async () => {
    replies.push({
      status: 200,
      body: { document: { slug: 'some-slug', content: 'x' }, version: 'v' },
    });
    replies.push({ status: 500, body: { error: '内部エラー' } });

    const error = await memoryRemoveCommand('some-slug', { yes: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('そんな記憶はありません');
    expect(String(error)).toContain('内部エラー');
  });
});

describe('alteroid memory list / show', () => {
  it('空なら「0 件」で終わらせず、次の一手を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { documents: [] } });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('記憶はまだ空です');
    expect(text).toContain('alteroid memory edit');
    expect(text).not.toContain('alteroid memory show');
  });

  it('一覧は slug と題を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        documents: [
          {
            slug: 'values',
            title: '価値観',
            kind: 'premise',
            descriptionFreshness: { kind: 'absent' },
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      },
    });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('values  — 価値観');
    expect(text.trimEnd().split('\n').at(-1)).toBe('本文を読むには: alteroid memory show <slug>');
  });

  it('区分と要旨・鮮度の印を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        documents: [
          {
            slug: 'runbook',
            title: '定点観測',
            kind: 'fact',
            description: '費用の推移',
            descriptionFreshness: {
              kind: 'stale',
              staleForMs: 60 * 60 * 1000,
              drift: { kind: 'measured', describedBytes: 500, currentBytes: 700, deltaBytes: 200 },
            },
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      },
    });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('[fact] runbook');
    expect(text).toContain(
      '要旨は本文より1時間古い（本文は+200バイト（+40%）変わった）: 費用の推移',
    );
  });

  it('無い記憶を読もうとしたら、そう言う（空の本文と区別する）', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(memoryShowCommand('missing')).rejects.toThrow('そんな記憶はありません: missing');
  });

  it('作成時刻は known なら ISO、unknown なら「不明」を出す（1つの一覧に両方並べる）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        documents: [
          {
            slug: 'values',
            title: '価値観',
            kind: 'premise',
            descriptionFreshness: { kind: 'absent' },
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
          {
            slug: 'runbook',
            title: '定点観測',
            kind: 'fact',
            descriptionFreshness: { kind: 'absent' },
            createdAt: { kind: 'unknown' },
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
        ],
      },
    });

    await memoryListCommand(new Date('2026-08-11T00:00:00.000Z').getTime());

    const text = read();
    expect(text).toContain(
      '作成: 2026-08-10T00:00:00.000Z（1日前） / 更新: 2026-08-15T00:00:00.000Z',
    );
    expect(text).toContain('作成: 不明 / 更新: 2026-08-12T00:00:00.000Z');
  });
});

describe('freshnessMarker（CLI 側の印。core と別実装だが同じ理由で直す、#821）', () => {
  it('stale の印は差の大きさで文字列が変わる（1時間差と30日差）', () => {
    const oneHour = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });
    const thirtyDays = freshnessMarker({
      kind: 'stale',
      staleForMs: 30 * 24 * 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });

    expect(oneHour).toContain('1時間');
    expect(thirtyDays).toContain('30日');
    expect(oneHour).not.toBe(thirtyDays);
  });

  it('unknown（記録なし）と fresh（正直なゼロ）は別の言葉で出る', () => {
    const unknown = freshnessMarker({ kind: 'unknown' });
    const fresh = freshnessMarker({ kind: 'fresh' });

    expect(unknown).not.toBe(fresh);
    expect(unknown).toContain('記録されていない');
    expect(unknown).not.toMatch(/\d+(秒|分|時間|日)/);
    expect(fresh).toContain('本文は動いていない');
  });

  it('absent は何も出さない', () => {
    expect(freshnessMarker({ kind: 'absent' })).toBe('');
  });

  it('at-least は measured（%つき）とも unrecorded とも別の言葉で出る。baselineAt は刷らない（#821 残課題）', () => {
    const atLeast = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: {
        kind: 'at-least',
        baselineBytes: 1000,
        baselineAt: '2026-08-20T12:00:00Z',
        currentBytes: 1200,
        deltaBytes: 200,
      },
    });
    const measured = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1200, deltaBytes: 200 },
    });
    const unrecorded = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });

    expect(atLeast).not.toBe(measured);
    expect(atLeast).not.toBe(unrecorded);
    expect(atLeast).toContain('以上変わった');
    expect(atLeast).not.toContain('%');
    expect(measured).toContain('%');
    expect(atLeast).not.toContain('2026-08-20T12:00:00Z');
  });
});

describe('alteroid memory の読み出しの失敗の理由', () => {
  it('list: 500 + { error } なら、状態コードと理由を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '一覧が読めない（memory のテスト用）' } });

    const error = await memoryListCommand().then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toContain('記憶の一覧を読めませんでした（HTTP 500）');
    expect(error?.message).toContain('一覧が読めない（memory のテスト用）');
    expect(read()).toBe('');
  });

  it('list: 401 / 403 は describeAuthFailure の文で例外にする（#3452）', async () => {
    const read = captureStdout();
    replies.push({ status: 401, body: {} });
    await expect(memoryListCommand()).rejects.toThrow('認証されませんでした');
    replies.push({ status: 403, body: {} });
    await expect(memoryListCommand()).rejects.toThrow('access grant');
    expect(read()).toBe('');
  });

  it('show: 404 は「無い」のまま', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(memoryShowCommand('nothing')).rejects.toThrow('そんな記憶はありません: nothing');
  });

  it('show: 500 を「そんな記憶はありません」と言わず、理由を載せて投げる', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '記憶が読めない（memory のテスト用）' } });

    const error = await memoryShowCommand('values').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('HTTP 500');
    expect(String(error)).toContain('記憶が読めない（memory のテスト用）');
    expect(read()).not.toContain('そんな記憶はありません');
  });

  it('edit: 読み出しが 500 なら、あるはずの記憶を無いものとして空のひな形でエディタを開かない', async () => {
    captureStdout();
    const savedEditor = process.env.EDITOR;
    process.env.EDITOR = `sh -c 'printf "空のひな形で上書き\\n" > "$1"' _`;
    replies.push({ status: 500, body: { error: '記憶が読めない（memory のテスト用）' } });

    try {
      const error = await memoryEditCommand('values').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('記憶が読めない（memory のテスト用）');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe('GET');
    } finally {
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
    }
  });

  it('edit: エディタが無い（127）とき、EDITOR / VISUAL と memory set を案内する（#2867）', async () => {
    captureStdout();
    const savedEditor = process.env.EDITOR;
    const savedVisual = process.env.VISUAL;
    delete process.env.VISUAL;
    process.env.EDITOR = 'alteroid-no-such-editor-2867';
    replies.push({ status: 404, body: { error: 'not found' } });
    try {
      const error = await memoryEditCommand('values').catch((e: unknown) => e);
      expect(String(error)).toContain('エディタ「alteroid-no-such-editor-2867」を起動できない');
      expect(String(error)).toContain('VISUAL か EDITOR');
      expect(String(error)).toContain('alteroid memory set <slug> --file <path>');
      expect(String(error)).not.toContain('異常終了しました');
    } finally {
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
      if (savedVisual !== undefined) process.env.VISUAL = savedVisual;
    }
  });

  it('edit: 無い記憶を作るとき、雛形のまま閉じたら書かずに「変更はありません」と言う', async () => {
    const out = captureStdout();
    const savedEditor = process.env.EDITOR;
    process.env.EDITOR = 'true';
    replies.push({ status: 404, body: { error: 'not found' } });

    try {
      await memoryEditCommand('fresh');
    } finally {
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
    }

    expect(out()).toContain('変更はありません');
    expect(sent.map((s) => s.method)).toEqual(['GET']);
  });

  describe('edit の前提の版（Issue #2743）', () => {
    let savedEditor: string | undefined;
    beforeEach(() => {
      savedEditor = process.env.EDITOR;
      process.env.EDITOR = `sh -c 'printf "人間の編集\\n" > "$1"' _`;
    });
    afterEach(() => {
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
    });

    it.each([
      ['全部消した', ''],
      ['空白だけにした', ' \n\t\n'],
    ])(
      '本文を%sまま閉じたら、PUT せずに set と同じ文言で断り、編集を残す（#3456）',
      async (_label, body) => {
        captureStdout();
        const err = captureStderr();
        const bodyFile = join(await makeTempDir('alteroid-memory-test-'), 'body.txt');
        await writeFile(bodyFile, body, 'utf8');
        process.env.EDITOR = `sh -c 'cat "${bodyFile}" > "$1"' _`;
        replies.push({
          status: 200,
          body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
        });

        const error = await memoryEditCommand('values').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('本文が空');
        expect((error as Error).message).toContain('--allow-empty');
        expect(sent.map((s) => s.method)).toEqual(['GET']);
        const mine = /残してあります: (\S+)/.exec(err())?.[1];
        expect(mine).toBeDefined();
        expect(await readFile(mine ?? '', 'utf8')).toBe(body);
        await rm(dirname(mine ?? ''), { recursive: true, force: true });
      },
    );

    describe('保存したあとにエディタが非0で終わる（#4050）', () => {
      let spacedTmp: string;
      const savedTmp = process.env.TMPDIR;
      beforeEach(async () => {
        // 空白入りの TMPDIR: 案内のコマンドを引用しないと、貼っても別のパスになる
        spacedTmp = join(await makeTempDir('alteroid-memory-exit-'), 'with space');
        await mkdir(spacedTmp);
        process.env.TMPDIR = spacedTmp;
        replies.push({
          status: 200,
          body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
        });
      });
      afterEach(() => {
        if (savedTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmp;
      });

      it('書き換えていたら、PUT せずに内容を残し、引用した打ち直しのコマンドを案内する', async () => {
        captureStdout();
        const err = captureStderr();
        process.env.EDITOR = `sh -c 'printf "人間の編集\\n" > "$1"; exit 3' _`;

        const error = await memoryEditCommand('values').catch((e: unknown) => e);

        expect(String((error as Error).message)).toContain('終了コード 3');
        expect(sent.map((s) => s.method)).toEqual(['GET']);
        const mine = /残してあります: (.+)\n/.exec(err())?.[1];
        expect(mine).toBeDefined();
        expect(await readFile(mine ?? '', 'utf8')).toBe('人間の編集\n');
        expect(err()).toContain(`alteroid memory set values --file '${mine ?? ''}'`);
        await rm(dirname(mine ?? ''), { recursive: true, force: true });
      });

      it('開く前と同じ内容なら、従来どおり一時ディレクトリを消して何も言わない', async () => {
        captureStdout();
        const err = captureStderr();
        process.env.EDITOR = `sh -c 'exit 3' _`;

        const error = await memoryEditCommand('values').catch((e: unknown) => e);

        expect(String((error as Error).message)).toContain('終了コード 3');
        expect(err()).not.toContain('残してあります');
        expect(await readdir(spacedTmp)).toEqual([]);
      });
    });

    it('GET で読んだ version を、PUT の ifMatch に載せる', async () => {
      captureStdout();
      replies.push({
        status: 200,
        body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
      });
      replies.push({ status: 200, body: {} });

      await memoryEditCommand('values');

      expect(sent[1]?.method).toBe('PUT');
      expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
        content: '人間の編集\n',
        ifMatch: 'v-read',
      });
    });

    it('無い記憶を作るときは ifMatch: null（読んだ時には無かった）', async () => {
      captureStdout();
      replies.push({ status: 404, body: { error: 'not found' } });
      replies.push({ status: 200, body: {} });

      await memoryEditCommand('values');

      expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({ content: '人間の編集\n', ifMatch: null });
    });

    it('409 のとき、人間が書いた内容を消さずに残し、パスと次の手を示して失敗する', async () => {
      const out = captureStdout();
      replies.push({
        status: 200,
        body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
      });
      replies.push({
        status: 409,
        body: {
          error: '変わっています',
          current: {
            document: { slug: 'values', content: '# 価値観\n\nクローンの判断\n' },
            version: 'v-now',
          },
        },
      });

      const error = await memoryEditCommand('values').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('書き換えませんでした');
      const text = out();
      const mine = /あなたの編集（残してあります）: (\S+)/.exec(text)?.[1];
      const theirs = /いまの記憶: (\S+)/.exec(text)?.[1];
      expect(mine).toBeDefined();
      expect(theirs).toBeDefined();
      expect(await readFile(mine ?? '', 'utf8')).toBe('人間の編集\n');
      expect(await readFile(theirs ?? '', 'utf8')).toContain('クローンの判断');
      expect(text).toContain('diff -u');
      expect(text).toContain('alteroid memory edit values');
      await rm(dirname(mine ?? ''), { recursive: true, force: true });
    });

    it('409 以外の保存の失敗（500）でも、書いた内容を残し、場所と set --file を案内して失敗する（#3453）', async () => {
      captureStdout();
      const err = captureStderr();
      replies.push({
        status: 200,
        body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
      });
      replies.push({ status: 500, body: { error: 'boom' } });

      const error = await memoryEditCommand('values').catch((e: unknown) => e);

      expect(String(error)).toContain('HTTP 500');
      const mine = /残してあります: (\S+)/.exec(err())?.[1];
      expect(mine).toBeDefined();
      expect(await readFile(mine ?? '', 'utf8')).toBe('人間の編集\n');
      expect(err()).toContain(`alteroid memory set values --file '${mine ?? ''}'`);
      await rm(dirname(mine ?? ''), { recursive: true, force: true });
    });
  });
});

describe('alteroid memory remove の確認（#3141）', () => {
  it('端末でなく --yes も無ければ、DELETE を打たずに断る（消えていない）', async () => {
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    const restore = pretendTty(false);
    try {
      await expect(memoryRemoveCommand('values')).rejects.toThrow('--yes');
    } finally {
      restore();
    }
    expect(sent.some((entry) => entry.method === 'DELETE')).toBe(false);
  });
});

describe('alteroid memory remove は、確認の前に在るかを確かめる（#3820）', () => {
  function fakeIo(over: { isTTY: boolean; answer?: string }) {
    const asked: string[] = [];
    const written: string[] = [];
    const io: ConfirmIo = {
      isTTY: over.isTTY,
      write: (text) => {
        written.push(text);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(over.answer ?? '');
      },
    };
    return { io, asked, written };
  }

  it('無い slug は、確認を出さずにすぐ失敗する。要求は GET だけ（再現）', async () => {
    captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });
    const { io, asked, written } = fakeIo({ isTTY: true, answer: 'yes' });

    await expect(memoryRemoveCommand('no-such-slug', {}, io)).rejects.toThrow(
      'そんな記憶はありません: no-such-slug',
    );

    expect(asked).toEqual([]);
    expect(written).toEqual([]);
    expect(sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      'GET /memory/no-such-slug',
    ]);
  });

  it('無い slug は、端末でなく --yes も無くても「そんな記憶はありません」で失敗する（--yes の案内に化けない）', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });
    const { io } = fakeIo({ isTTY: false });

    await expect(memoryRemoveCommand('no-such-slug', {}, io)).rejects.toThrow(
      'そんな記憶はありません',
    );
    expect(sent).toHaveLength(1);
  });

  it('在る slug は、従来どおり 確認 → DELETE。確認の前に読んだ版が ifMatch になる', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });
    const { io, asked, written } = fakeIo({ isTTY: true, answer: 'yes' });

    await memoryRemoveCommand('values', {}, io);

    expect(written.join('')).toContain('記憶 values を消します');
    expect(asked).toHaveLength(1);
    expect(sent.map((entry) => entry.method)).toEqual(['GET', 'DELETE']);
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/memory/values?ifMatch=v-read');
    expect(read()).toContain('消しました: values');
  });

  it('在る slug でも、確認に yes と答えなければ DELETE は打たない', async () => {
    captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: 'x' }, version: 'v-read' },
    });
    const { io } = fakeIo({ isTTY: true, answer: 'no' });

    await expect(memoryRemoveCommand('values', {}, io)).rejects.toThrow();

    expect(sent.map((entry) => entry.method)).toEqual(['GET']);
  });

  it('--if-match を明示したときは、事前の GET をせず、確認 → その版で DELETE（既存の挙動）', async () => {
    captureStdout();
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });
    const { io, asked } = fakeIo({ isTTY: true, answer: 'yes' });

    await memoryRemoveCommand('values', { ifMatch: 'v-shown' }, io);

    expect(asked).toHaveLength(1);
    expect(sent.map((entry) => entry.method)).toEqual(['DELETE']);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/memory/values?ifMatch=v-shown');
  });
});

describe('alteroid memory set の上書き確認（#3201）', () => {
  function fakeIo(over: { isTTY: boolean; answer?: string }) {
    const asked: string[] = [];
    const written: string[] = [];
    const io: ConfirmIo = {
      isTTY: over.isTTY,
      write: (text) => {
        written.push(text);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(over.answer ?? '');
      },
    };
    return { io, asked, written };
  }

  async function bodyFile(): Promise<string> {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'values.md');
    await writeFile(path, '新しい本文\n', 'utf8');
    return path;
  }

  const existing = { status: 200, body: { document: { slug: 'values', content: '古い本文' } } };
  const methods = () => sent.map((entry) => entry.method);

  it('新規作成（無い記憶）は確認せずに置く（非対話でも）', async () => {
    captureStdout();
    const file = await bodyFile();
    replies.push({ status: 404, body: { error: 'not found' } });
    const { io, asked } = fakeIo({ isTTY: false });

    await memorySetCommand('values', { file }, io);

    expect(asked).toEqual([]);
    expect(methods()).toEqual(['GET', 'PUT']);
  });

  it('既に在るとき、非対話で --yes が無ければ PUT せずに断る（何も変えない）', async () => {
    const file = await bodyFile();
    replies.push(existing);
    const { io } = fakeIo({ isTTY: false, answer: 'yes' });

    await expect(memorySetCommand('values', { file }, io)).rejects.toThrow('--yes');

    expect(methods()).toEqual(['GET']);
  });

  it('端末で yes と答えれば置き換える。確認の文は slug と、前の本文が残らないことを言う', async () => {
    captureStdout();
    const file = await bodyFile();
    replies.push(existing);
    const { io, written } = fakeIo({ isTTY: true, answer: 'yes' });

    await memorySetCommand('values', { file }, io);

    expect(written.join('')).toContain('記憶 values を置き換えます。前の本文は残りません');
    expect(methods()).toEqual(['GET', 'PUT']);
  });

  it('端末で yes 以外なら置かない', async () => {
    captureStdout();
    const file = await bodyFile();
    replies.push(existing);
    const { io } = fakeIo({ isTTY: true, answer: 'no' });

    await expect(memorySetCommand('values', { file }, io)).rejects.toThrow(
      '取り消しました。何も変更していません。',
    );

    expect(methods()).toEqual(['GET']);
  });

  it('--yes なら聞かずに置き換える（非対話でも）', async () => {
    captureStdout();
    const file = await bodyFile();
    replies.push(existing);
    const { io, asked } = fakeIo({ isTTY: false });

    await memorySetCommand('values', { file, yes: true }, io);

    expect(asked).toEqual([]);
    expect(methods()).toEqual(['GET', 'PUT']);
  });
});

describe('alteroid memory edit は slug を一時ファイルの前に検査する（#3728）', () => {
  let sandbox: string;
  let fakeTmp: string;
  let opened: string;
  const saved = { tmp: process.env.TMPDIR, editor: process.env.EDITOR, visual: process.env.VISUAL };

  beforeEach(async () => {
    sandbox = await makeTempDir('alteroid-memory-slug-');
    fakeTmp = join(sandbox, 'tmp');
    opened = join(sandbox, 'editor-opened');
    await mkdir(fakeTmp);
    process.env.TMPDIR = fakeTmp;
    delete process.env.VISUAL;
    process.env.ALTEROID_TEST_OPENED = opened;
    process.env.EDITOR = `sh -c 'printf x > "$ALTEROID_TEST_OPENED"; printf "人間の編集\\n" > "$1"' _`;
    captureStdout();
  });
  afterEach(() => {
    for (const [key, value] of [
      ['TMPDIR', saved.tmp],
      ['EDITOR', saved.editor],
      ['VISUAL', saved.visual],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.ALTEROID_TEST_OPENED;
  });

  it('`../` で一時ディレクトリの外へ出る slug は、外のファイルを書き換えず、通信もエディタも起こさない', async () => {
    const outside = join(sandbox, 'outside.md');
    await writeFile(outside, '使い手が書いたもの\n', 'utf8');
    replies.push({ status: 404, body: { error: 'not found' } });

    const error = await memoryEditCommand('../../outside').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(await readFile(outside, 'utf8')).toBe('使い手が書いたもの\n');
    expect(await readdir(fakeTmp)).toEqual([]);
    expect(sent).toEqual([]);
    await expect(readFile(opened, 'utf8')).rejects.toThrow();
  });

  it.each(['my note', 'a;b', '$(id)', 'Upper', 'a/b', '.hidden', '', 'x'.repeat(129)])(
    '規則に合わない slug %j は、一時ファイルも GET も PUT もエディタも無しで、使える形を言って断る',
    async (slug) => {
      const error = await memoryEditCommand(slug).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('英小文字・数字・. _ - のみ');
      expect(await readdir(fakeTmp)).toEqual([]);
      expect(sent).toEqual([]);
      await expect(readFile(opened, 'utf8')).rejects.toThrow();
    },
  );

  it('一時ファイルのパスに空白が入っても（TMPDIR）、エディタは1つのファイルとして開く', async () => {
    const spaced = join(sandbox, 'tmp with space');
    await mkdir(spaced);
    process.env.TMPDIR = spaced;
    replies.push({ status: 404, body: { error: 'not found' } });

    await memoryEditCommand('values');

    expect(sent.map((s) => s.method)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(sent[1]?.body ?? '{}')).toMatchObject({ content: '人間の編集\n' });
  });

  it('一時ファイルのパスに空白が入っても（TMPDIR）、409 の案内のコマンドはパスを引用する（#4074）', async () => {
    const spaced = join(sandbox, 'tmp with space');
    await mkdir(spaced);
    process.env.TMPDIR = spaced;
    const out = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    replies.push({
      status: 409,
      body: {
        error: '変わっています',
        current: {
          document: { slug: 'values', content: '# 価値観\n\nクローンの判断\n' },
          version: 'v-now',
        },
      },
    });

    await expect(memoryEditCommand('values')).rejects.toThrow('書き換えませんでした');

    const text = out();
    const mine = /あなたの編集（残してあります）: (.+)/.exec(text)?.[1];
    const theirs = /いまの記憶: (.+)/.exec(text)?.[1];
    expect(mine).toContain('tmp with space');
    expect(theirs).toContain('tmp with space');
    expect(text).toContain(`diff -u '${theirs}' '${mine}'`);
    expect(text).toContain(`alteroid memory set values --file '${mine}'`);
  });
});
