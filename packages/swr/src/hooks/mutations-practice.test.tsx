// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDeletePractice, useSavePractice } from './mutations';
import { usePracticeVersions } from './queries';
import { json, Providers, storeTestBaseUrl, stubFetch } from '../test-support';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const wrapper = ({ children }: { children: ReactNode }) => <Providers>{children}</Providers>;

function setup() {
  const stub = stubFetch((url) => {
    const path = new URL(url).pathname;
    if (path === '/practices/a/versions') return json({ versions: [] });
    if (path === '/practices/a') {
      return json({
        practice: { slug: 'a', kind: '実装', title: 'A', content: '本文\n' },
        version: 'v1',
      });
    }
    if (path === '/practices') return json({ practices: [] });
    return undefined;
  });
  const versionGets = () =>
    stub.calls.filter((url) => new URL(url).pathname === '/practices/a/versions').length;
  return { versionGets };
}

function mount() {
  return renderHook(
    () => ({
      versions: usePracticeVersions('a'),
      save: useSavePractice(),
      remove: useDeletePractice(),
    }),
    { wrapper },
  );
}

describe('やり方の履歴の取り直し（#4054）', () => {
  it('保存すると、開いている履歴も取り直す', async () => {
    const { versionGets } = setup();
    const view = mount();
    await waitFor(() => expect(view.result.current.versions.data).toBeDefined());
    expect(versionGets()).toBe(1);

    await act(() => view.result.current.save('a', '実装', 'A', '本文'));

    await waitFor(() => expect(versionGets()).toBe(2));
  });

  it('削除すると、開いている履歴も取り直す', async () => {
    const { versionGets } = setup();
    const view = mount();
    await waitFor(() => expect(view.result.current.versions.data).toBeDefined());
    expect(versionGets()).toBe(1);

    await act(() => view.result.current.remove('a'));

    await waitFor(() => expect(versionGets()).toBe(2));
  });
});
