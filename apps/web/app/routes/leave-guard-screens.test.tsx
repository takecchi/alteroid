// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Providers, storeTestBaseUrl, TestDataRouter } from '~/test-support';

import EnvVars from './env-vars';
import Inbox from './inbox';
import Integrations from './integrations';
import Memory from './memory';
import Practices from './practices';
import Tokens from './tokens';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

type Router = Parameters<NonNullable<Parameters<typeof TestDataRouter>[0]['onRouter']>>[0];

function renderScreen(Screen: ComponentType): { router: () => Router } {
  let captured: Router | undefined;
  render(
    <Providers>
      <TestDataRouter onRouter={(router) => (captured = router)}>
        <Screen />
      </TestDataRouter>
    </Providers>,
  );
  return { router: () => captured as Router };
}

function unloadEvent(): Event {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

async function leave(router: Router): Promise<void> {
  await act(async () => {
    void router.navigate('/elsewhere');
  });
}

function write(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const SCREENS: { name: string; Screen: ComponentType; ready: RegExp; fill: () => void }[] = [
  {
    name: '連携の発行',
    Screen: Integrations,
    ready: /名前（見分けるための呼び名）/,
    fill: () => write(/名前（見分けるための呼び名）/, 'CI'),
  },
  {
    name: '受信箱の絞り込み',
    Screen: Inbox,
    ready: /理由（日誌に残る・必須）/,
    fill: () => write(/理由（日誌に残る・必須）/, '古い'),
  },
  {
    name: '認証トークンの追加（値だけでも）',
    Screen: Tokens,
    ready: /値（claude setup-token/,
    fill: () => write(/値（claude setup-token/, 'sk-secret'),
  },
  {
    name: '環境変数の追加',
    Screen: EnvVars,
    ready: /名前（英大文字/,
    fill: () => write(/名前（英大文字/, 'TZ'),
  },
];

describe('書きかけのある画面は、移動・タブを閉じる前に確認する', () => {
  for (const { name, Screen, ready, fill } of SCREENS) {
    it(`${name}: 書きかけが無ければ確認しない`, async () => {
      const { router } = renderScreen(Screen);
      await screen.findByLabelText(ready);
      expect(unloadEvent().defaultPrevented).toBe(false);
      await leave(router());
      await waitFor(() => expect(router().state.location.pathname).toBe('/elsewhere'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it(`${name}: 書きかけがあれば確認が出て、「破棄して離れる」で移る`, async () => {
      const { router } = renderScreen(Screen);
      await screen.findByLabelText(ready);
      fill();
      expect(unloadEvent().defaultPrevented).toBe(true);
      await leave(router());
      expect(await screen.findByRole('alertdialog')).toBeTruthy();
      expect(screen.getByText('保存していない変更があります')).toBeTruthy();
      expect(router().state.location.pathname).toBe('/');
      fireEvent.click(screen.getByRole('button', { name: '破棄して離れる' }));
      await waitFor(() => expect(router().state.location.pathname).toBe('/elsewhere'));
    });
  }

  it('書きかけを空に戻したら、確認しない', async () => {
    const { router } = renderScreen(EnvVars);
    await screen.findByLabelText(/名前（英大文字/);
    write(/名前（英大文字/, 'TZ');
    write(/名前（英大文字/, '');
    expect(unloadEvent().defaultPrevented).toBe(false);
    await leave(router());
    await waitFor(() => expect(router().state.location.pathname).toBe('/elsewhere'));
  });

  it('受信箱: 種類の選択だけでも書きかけ', async () => {
    const { router } = renderScreen(Inbox);
    await screen.findByLabelText(/理由（日誌に残る・必須）/);
    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    await leave(router());
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('env-vars: 渡す先・シークレットの引き継ぎ設定だけでは書きかけにしない', async () => {
    const { router } = renderScreen(EnvVars);
    await screen.findByLabelText(/名前（英大文字/);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(unloadEvent().defaultPrevented).toBe(false);
    await leave(router());
    await waitFor(() => expect(router().state.location.pathname).toBe('/elsewhere'));
  });

  for (const { name, Screen } of [
    { name: '記憶', Screen: Memory },
    { name: 'やり方', Screen: Practices },
  ]) {
    it(`${name}: 開く前の名前が残っていればタブを閉じる前に確認し、空なら確認しない`, async () => {
      renderScreen(Screen);
      const box = await screen.findByLabelText(/名前（半角の英小文字/);
      expect(unloadEvent().defaultPrevented).toBe(false);
      fireEvent.change(box, { target: { value: 'work-style' } });
      expect(unloadEvent().defaultPrevented).toBe(true);
      fireEvent.change(box, { target: { value: '' } });
      expect(unloadEvent().defaultPrevented).toBe(false);
    });
  }
});
