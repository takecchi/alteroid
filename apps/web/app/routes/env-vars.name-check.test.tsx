// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import EnvVars from './env-vars';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const NAME_RULE = '名前は英大文字・数字・_ だけで書き、先頭は英大文字にする';

function stubServer(putResponse: () => Response) {
  const puts: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push(await request.json());
      return putResponse();
    }
    return json({ credentials: [] });
  }) as typeof fetch;
  return puts;
}

async function fillForm(name: string, value = 'v') {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByText('置かれた環境変数がまだ1件も無い。');
  fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('値'), { target: { value } });
}

describe('環境変数の登録 — 名前の検査（#5860）', () => {
  it('英大文字・数字・_ に合わない名前は、送らずに欄の下へ理由を出す', async () => {
    const puts = stubServer(() => json({ credentials: [], restartRequired: [], runners: [] }));
    await fillForm('bad name');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const input = screen.getByPlaceholderText('TZ');
    const note = await screen.findByText(NAME_RULE);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(note.id);
    expect(note.id).not.toBe('');
    expect(puts).toEqual([]);
    expect(screen.queryByText(/鍵/)).toBeNull();
  });

  it('先頭が数字・_ の名前も送らずに断る（daemon は先頭を英大文字に限る）', async () => {
    const puts = stubServer(() => json({ credentials: [], restartRequired: [], runners: [] }));
    await fillForm('1ABC');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    await screen.findByText(NAME_RULE);
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: '_ABC' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    await screen.findByText(NAME_RULE);
    expect(puts).toEqual([]);
  });

  it('128 文字を超える名前は送らずに断る', async () => {
    const puts = stubServer(() => json({ credentials: [], restartRequired: [], runners: [] }));
    await fillForm('A'.repeat(129));
    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    await screen.findByText('名前は 128 文字までにする（いま 129 文字）');
    expect(puts).toEqual([]);
  });

  it('名前を打ち直すと理由が消え、直した名前は送れる（小文字は大文字に直して受ける）', async () => {
    const puts = stubServer(() => json({ credentials: [], restartRequired: [], runners: [] }));
    await fillForm('bad name');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    await screen.findByText(NAME_RULE);

    const input = screen.getByPlaceholderText('TZ');
    fireEvent.change(input, { target: { value: 'good_name' } });
    expect(screen.queryByText(NAME_RULE)).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
    expect((input as HTMLInputElement).value).toBe('GOOD_NAME');

    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    await waitFor(() => expect(puts).toHaveLength(1));
  });
});

describe('環境変数の登録 — サーバの 400 を画面の用語で出す（#5860）', () => {
  const REJECTED = '鍵の入力の形が不正（置いていない）';

  async function submitAndRead(error: string) {
    stubServer(() => json({ error }, 400));
    await fillForm('OK_NAME');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    return (await screen.findByRole('alert')).textContent ?? '';
  }

  it('名前の欄が違うと言われたら、名前の規則で出す（内部の位置も「鍵」も出さない）', async () => {
    const text = await submitAndRead(`${REJECTED}: credentials.0.name`);
    expect(text).toContain(NAME_RULE);
    expect(text).not.toContain('credentials');
    expect(text).not.toContain('鍵');
  });

  it('値の欄が違うと言われたら、値の欄として出す', async () => {
    const text = await submitAndRead(`${REJECTED}: credentials.0.value`);
    expect(text).toContain('値');
    expect(text).not.toContain('credentials');
    expect(text).not.toContain('鍵');
  });

  it('渡す先の欄が違うと言われたら、渡す先として出す', async () => {
    const text = await submitAndRead(`${REJECTED}: credentials.0.scope`);
    expect(text).toContain('渡す先');
    expect(text).not.toContain('credentials');
  });

  it('欄を読めない 400 は、名前・値・渡す先を見直すよう出す', async () => {
    const text = await submitAndRead(REJECTED);
    expect(text).toContain('どの欄かは読み取れなかった');
    expect(text).toContain('名前・値・渡す先');
    expect(text).not.toContain('鍵');
  });
});
