// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeCredential } from '@alteroid/logic';
import { Markdown } from '@alteroid/ui';

import { Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { matchDaemonAttachmentUrl } from './daemon-images';

let originalFetch: typeof fetch;
let originalCreate: typeof URL.createObjectURL | undefined;
let originalRevoke: typeof URL.revokeObjectURL | undefined;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  localStorage.clear();
  storeTestBaseUrl();
  storeCredential(TEST_BASE_URL, {
    token: 'test-token',
    account: { id: 'acc', displayName: null, email: null },
    grantedAtClaim: true,
    createdAt: '2026-01-01T00:00:00Z',
  });
  createObjectURL = vi.fn(() => 'blob:daemon-image');
  revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = originalRevoke as typeof URL.revokeObjectURL;
});

describe('matchDaemonAttachmentUrl（資格を送ってよい URL の線）', () => {
  const base = 'https://daemon.example';

  it('接続中のデーモンと同じ origin の /attachments/<id> だけが id になる', () => {
    expect(matchDaemonAttachmentUrl(`${base}/attachments/abc-1_X`, base)).toBe('abc-1_X');
    expect(matchDaemonAttachmentUrl(`${base}/attachments/abc-1_X`, `${base}/`)).toBe('abc-1_X');
  });

  it('base に path があるときは、その下の /attachments/<id> だけ', () => {
    expect(matchDaemonAttachmentUrl(`${base}/api/attachments/a1`, `${base}/api`)).toBe('a1');
    expect(matchDaemonAttachmentUrl(`${base}/attachments/a1`, `${base}/api`)).toBeUndefined();
  });

  it('別の origin（host・port・scheme）は対象にしない', () => {
    for (const src of [
      'https://evil.example/attachments/a1',
      'https://daemon.example.evil.example/attachments/a1',
      'https://daemon.example:8443/attachments/a1',
      'http://daemon.example/attachments/a1',
      'https://user:pw@daemon.example/attachments/a1',
      'https://daemon.example@evil.example/attachments/a1',
    ]) {
      expect(matchDaemonAttachmentUrl(src, base), src).toBeUndefined();
    }
  });

  it('/attachments/<id> と attachments/<id> の相対パスは、base（path 無し・有り）の下のものとして id になる', () => {
    for (const src of ['/attachments/a1', 'attachments/a1']) {
      expect(matchDaemonAttachmentUrl(src, base), src).toBe('a1');
      expect(matchDaemonAttachmentUrl(src, `${base}/api`), src).toBe('a1');
      expect(matchDaemonAttachmentUrl(src, '/api'), src).toBe('a1');
    }
  });

  it('それ以外の相対パスと、相対でも余計な部分があるものは対象にしない', () => {
    for (const src of [
      '/home/x/chart.png',
      './x.png',
      '../attachments/a1',
      '/attachments/limits',
      '/attachments/a1?x=1',
      '/attachments/a1#x',
      '/attachments/a1/extra',
      '/attachments//evil.example/a1',
      '/attachments/%2e%2e',
      '/attachments/',
    ]) {
      expect(matchDaemonAttachmentUrl(src, base), src).toBeUndefined();
      expect(matchDaemonAttachmentUrl(src, `${base}/api`), src).toBeUndefined();
    }
  });

  it('絶対 URL の別の path・余計な部分のある URL は対象にしない', () => {
    for (const src of [
      '//daemon.example/attachments/a1',
      `${base}/attachments/`,
      `${base}/attachments/a1/extra`,
      `${base}/attachments/%2e%2e`,
      `${base}/attachments/a1?x=1`,
      `${base}/attachments/a1#x`,
      `${base}/other/a1`,
      'blob:https://daemon.example/a1',
      'data:image/png;base64,AAAA',
    ]) {
      expect(matchDaemonAttachmentUrl(src, base), src).toBeUndefined();
    }
  });
});

describe('Markdown の画像（デーモンの添付）', () => {
  it('一致する origin の添付は Bearer 付きで取られ、blob: で出る。remoteImages={false} でも同じ', async () => {
    const stub = stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    render(
      <Providers>
        <Markdown remoteImages={false}>{`![図](${TEST_BASE_URL}/attachments/att-1)`}</Markdown>
      </Providers>,
    );

    const image = await screen.findByRole('img', { name: '図' });
    expect(image.getAttribute('src')).toBe('blob:daemon-image');
    expect(stub.entries).toHaveLength(1);
    expect(stub.entries[0]?.url).toBe(`${TEST_BASE_URL}/attachments/att-1`);
    expect(stub.entries[0]?.authorization).toBe('Bearer test-token');
  });

  it('相対パスの /attachments/<id> は、接続中のデーモンへ Bearer 付きで取りに行く', async () => {
    const stub = stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    render(
      <Providers>
        <Markdown remoteImages={false}>{'![図](/attachments/att-9)'}</Markdown>
      </Providers>,
    );

    expect((await screen.findByRole('img', { name: '図' })).getAttribute('src')).toBe(
      'blob:daemon-image',
    );
    expect(stub.entries.map((entry) => entry.url)).toEqual([`${TEST_BASE_URL}/attachments/att-9`]);
    expect(stub.entries[0]?.authorization).toBe('Bearer test-token');
  });

  it('別の origin の URL・デーモンの添付でない相対パスには fetch が飛ばない（資格を送らない）', () => {
    const stub = stubFetch(() => new Response(new Uint8Array([1])));
    render(
      <Providers>
        <Markdown>{'![x](https://evil.example/attachments/att-1)'}</Markdown>
        <Markdown remoteImages={false}>{'![y](https://evil.example/attachments/att-2)'}</Markdown>
        <Markdown>{'![z](/home/x/chart.png)'}</Markdown>
      </Providers>,
    );

    expect(stub.calls).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '画像: y' })).toBeTruthy();
  });

  it('取れなかったとき（404）は「画像: 説明」の文字とリンクに落ちる', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    render(
      <Providers>
        <Markdown>{`![図](${TEST_BASE_URL}/attachments/gone)`}</Markdown>
      </Providers>,
    );

    const link = await screen.findByRole('link', { name: '画像: 図' });
    expect(link.getAttribute('href')).toBe(`${TEST_BASE_URL}/attachments/gone`);
    expect(screen.queryByRole('button')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('ネットワークの失敗でも文字とリンクに落ちる', async () => {
    stubFetch(() => undefined);
    render(
      <Providers>
        <Markdown>{`![図](${TEST_BASE_URL}/attachments/x)`}</Markdown>
      </Providers>,
    );

    expect(await screen.findByRole('link', { name: '画像: 図' })).toBeTruthy();
  });

  it('unmount で blob: を revoke する', async () => {
    stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const view = render(
      <Providers>
        <Markdown>{`![図](${TEST_BASE_URL}/attachments/att-1)`}</Markdown>
      </Providers>,
    );
    await screen.findByRole('img', { name: '図' });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    view.unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:daemon-image');
  });

  it('src が変わると前の blob: を revoke して取り直す', async () => {
    stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const view = render(
      <Providers>
        <Markdown>{`![図](${TEST_BASE_URL}/attachments/att-1)`}</Markdown>
      </Providers>,
    );
    await screen.findByRole('img', { name: '図' });

    view.rerender(
      <Providers>
        <Markdown>{`![図](${TEST_BASE_URL}/attachments/att-2)`}</Markdown>
      </Providers>,
    );

    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:daemon-image');
  });
});
