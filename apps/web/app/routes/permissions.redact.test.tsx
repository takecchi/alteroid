// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Permissions from './permissions';

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

describe('/permissions 画面 — rule・answer・aria-label は鍵を伏せる', () => {
  it('rule と answer に鍵があっても出さず、地の文は残る', async () => {
    const grant = {
      id: 'grant-a',
      rule: `Bash(deploy GH_TOKEN=${KEY} --now:*)`,
      allows: ['deploy now'],
      denies: ['deploy; rm -rf /'],
      approvalId: 'approval-a',
      answer: `許可します GH_TOKEN=${KEY} 以上`,
      grantedAt: '2026-09-01T00:00:00.000Z',
      route: { principalKind: 'account', accountId: 'acct-a' },
    };
    stubFetch((url) =>
      url.includes('/permission-grants') ? json({ grants: [grant] }) : undefined,
    );

    const { container } = render(
      <Providers>
        <MemoryRouter>
          <Permissions />
        </MemoryRouter>
      </Providers>,
    );
    await screen.findByText('許可', { selector: 'h2' });

    const rule = await screen.findByText(/Bash\(deploy/);
    expect(rule.textContent).toContain('--now:*)');
    expect(rule.textContent).not.toContain(KEY);

    // 「許可します」は画面の説明文にも出るので、answer の行（「以上」を含む）に絞る
    const answers = await screen.findAllByText(/許可します/);
    const answer = answers.find((element) => element.textContent?.includes('以上'));
    expect(answer).toBeDefined();
    expect(answer?.textContent).not.toContain(KEY);

    const button = screen.getByRole('button', { name: /を取り消す$/ });
    const label = button.getAttribute('aria-label') ?? '';
    expect(label).toContain('--now:*)');
    expect(label).not.toContain(KEY);

    expect(container.textContent).not.toContain(KEY);
  });
});
