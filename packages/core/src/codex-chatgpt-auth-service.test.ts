import { describe, expect, it } from 'vitest';

import { createCodexChatgptAuthService } from './codex-chatgpt-auth-service.js';
import type { CodexDeviceLogin, CodexDeviceLoginOutcome } from './codex-device-login.js';
import { fingerprintOf } from './credentials.js';
import { RunnerCodexAuthUnsupportedError, type RunnerClient } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';
import { createMemoryStores } from './testing.js';

const LOGIN_VALUE = '{"tokens":{"refresh_token":"rt-login-fake"}}';
const REFRESHED_A = '{"tokens":{"refresh_token":"rt-A-fake"}}';
const REFRESHED_B = '{"tokens":{"refresh_token":"rt-B-fake"}}';

/** runner の偽物。降りてきたものと、書き戻しとして渡すものを持つ。 */
class FakeRunner {
  readonly pushes: ({ value: string; revision: string } | null)[] = [];
  writeBack: { value: string; baseRevision: string; fingerprint: string } | null = null;
  unsupported = false;
  constructor(readonly runnerId: string) {}
  async setCodexAuth(push: { value: string; revision: string } | null): Promise<void> {
    if (this.unsupported) throw new RunnerCodexAuthUnsupportedError(this.runnerId);
    this.pushes.push(push);
  }
  async takeCodexAuthWriteBack(fingerprint: string) {
    return this.writeBack?.fingerprint === fingerprint ? this.writeBack : null;
  }
  get client(): RunnerClient {
    return this as unknown as RunnerClient;
  }
  last(): { value: string; revision: string } | null | undefined {
    return this.pushes.at(-1);
  }
}

function fakeDeviceLogin(): {
  start: () => Promise<CodexDeviceLogin>;
  finish: (outcome: CodexDeviceLoginOutcome) => void;
  started: number;
} {
  let resolve!: (outcome: CodexDeviceLoginOutcome) => void;
  const state = {
    started: 0,
    start: async (): Promise<CodexDeviceLogin> => {
      state.started += 1;
      const outcome = new Promise<CodexDeviceLoginOutcome>((r) => {
        resolve = r;
      });
      return {
        started: { loginId: 'l1', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.example/d' },
        outcome,
        cancel: () => resolve({ kind: 'canceled' }),
      };
    },
    finish: (outcome: CodexDeviceLoginOutcome) => resolve(outcome),
  };
  return state;
}

function setup(runnerIds: string[] = ['r1', 'r2']) {
  const stores = createMemoryStores();
  const runners = runnerIds.map((id) => new FakeRunner(id));
  const journal: JournalEntryInput[] = [];
  const device = fakeDeviceLogin();
  let revision = 0;
  const service = createCodexChatgptAuthService({
    store: stores.codexAuth,
    runners: { list: async () => runners.map((r) => r.client) },
    journal: async (entry) => {
      journal.push(entry);
    },
    startDeviceLogin: device.start,
    now: () => new Date('2026-10-07T10:00:00.000Z'),
    newRevision: () => `rev-${String((revision += 1))}`,
    newId: () => 'login-view-1',
  });
  return { stores, runners, journal, device, service };
}

async function loggedIn(h: ReturnType<typeof setup>): Promise<void> {
  await h.service.startLogin();
  h.device.finish({
    kind: 'succeeded',
    authJson: LOGIN_VALUE,
    email: 'me@example.com',
    planType: 'plus',
  });
  await h.service.settled();
}

describe('Codex の ChatGPT ログインの正本（#3939）', () => {
  it('ログインを始めると確認用 URL とコードが返り、完了で正本に置かれて runner へ降りる。値は状態にも日誌にも出ない', async () => {
    const h = setup();
    const view = await h.service.startLogin();
    expect(view).toMatchObject({
      state: 'pending',
      verificationUrl: 'https://auth.example/d',
      userCode: 'ABCD-EFGH',
    });
    // 進行中は同じものを返す（同時に1本）。
    expect((await h.service.startLogin()).id).toBe(view.id);
    expect(h.device.started).toBe(1);

    h.device.finish({ kind: 'succeeded', authJson: LOGIN_VALUE, email: 'me@example.com', planType: 'plus' });
    await h.service.settled();

    expect(h.service.login(view.id)?.state).toBe('succeeded');
    const status = await h.service.status();
    expect(status).toEqual({
      loggedIn: true,
      email: 'me@example.com',
      planType: 'plus',
      updatedAt: '2026-10-07T10:00:00.000Z',
      fingerprint: fingerprintOf(LOGIN_VALUE),
      failure: null,
    });
    expect(JSON.stringify(status)).not.toContain('rt-login-fake');
    expect((await h.stores.codexAuth.get())?.value).toBe(LOGIN_VALUE);
    for (const runner of h.runners) {
      expect(runner.last()).toEqual({ value: LOGIN_VALUE, revision: 'rev-1' });
    }
    expect(JSON.stringify(h.journal)).not.toContain('rt-login-fake');
    expect(JSON.stringify(h.journal)).toContain('ログインした');
  });

  it('5台が同じ版から書き戻しても、先の1台だけが通り、古い版からの書き戻しは新しい値を潰さない', async () => {
    const h = setup(['r1', 'r2', 'r3', 'r4', 'r5']);
    await loggedIn(h);
    const [a, b] = h.runners as [FakeRunner, FakeRunner];
    a.writeBack = { value: REFRESHED_A, baseRevision: 'rev-1', fingerprint: fingerprintOf(REFRESHED_A) };
    b.writeBack = { value: REFRESHED_B, baseRevision: 'rev-1', fingerprint: fingerprintOf(REFRESHED_B) };

    await Promise.all([
      h.service.onRunnerNotice(
        { type: 'codex_auth', runnerId: 'r1', kind: 'changed', baseRevision: 'rev-1', fingerprint: fingerprintOf(REFRESHED_A) },
        'r1',
        a.client,
      ),
      h.service.onRunnerNotice(
        { type: 'codex_auth', runnerId: 'r2', kind: 'changed', baseRevision: 'rev-1', fingerprint: fingerprintOf(REFRESHED_B) },
        'r2',
        b.client,
      ),
    ]);

    const stored = await h.stores.codexAuth.get();
    expect(stored?.value).toBe(REFRESHED_A);
    expect(stored?.revision).toBe('rev-2');
    // 全台に新しい版が降り、負けた r2 にも正本（A）が降り直している。
    for (const runner of h.runners) {
      expect(runner.last()).toEqual({ value: REFRESHED_A, revision: 'rev-2' });
    }
    expect(JSON.stringify(h.journal)).toContain('古い版からの書き戻しを捨てた');
    expect(JSON.stringify(h.journal)).not.toContain('rt-A-fake');
    expect(JSON.stringify(h.journal)).not.toContain('rt-B-fake');
  });

  it('切れた・失効したら日誌と状態に出し、同じ失敗は積み続けない。再ログインで消える', async () => {
    const h = setup();
    await loggedIn(h);
    const notice = {
      type: 'codex_auth' as const,
      runnerId: 'r1',
      kind: 'failed' as const,
      baseRevision: 'rev-1',
      reason: 'refresh token was revoked',
    };
    await h.service.onRunnerNotice(notice, 'r1', h.runners[0]?.client ?? null);
    await h.service.onRunnerNotice(notice, 'r2', h.runners[1]?.client ?? null);
    const status = await h.service.status();
    expect(status.failure).toEqual({ at: '2026-10-07T10:00:00.000Z', reason: 'refresh token was revoked' });
    const failures = h.journal.filter((e) => JSON.stringify(e).includes('再ログインが要る'));
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).toContain('alteroid codex login');

    await loggedIn(h);
    expect((await h.service.status()).failure).toBeNull();
  });

  it('古い版で起きた失敗は、新しい正本を失効扱いにしない', async () => {
    const h = setup();
    await loggedIn(h);
    await h.service.onRunnerNotice(
      { type: 'codex_auth', runnerId: 'r1', kind: 'failed', baseRevision: 'rev-0', reason: 'x' },
      'r1',
      null,
    );
    expect((await h.service.status()).failure).toBeNull();
  });

  it('ログアウトで正本から消え、全 runner から外れる。ログアウト後の書き戻しは捨てる', async () => {
    const h = setup();
    await loggedIn(h);
    expect(await h.service.logout()).toEqual({ removed: true });
    expect(await h.stores.codexAuth.get()).toBeNull();
    for (const runner of h.runners) expect(runner.last()).toBeNull();
    const a = h.runners[0] as FakeRunner;
    a.writeBack = { value: REFRESHED_A, baseRevision: 'rev-1', fingerprint: fingerprintOf(REFRESHED_A) };
    await h.service.onRunnerNotice(
      { type: 'codex_auth', runnerId: 'r1', kind: 'changed', baseRevision: 'rev-1', fingerprint: fingerprintOf(REFRESHED_A) },
      'r1',
      a.client,
    );
    expect(await h.stores.codexAuth.get()).toBeNull();
  });

  it('ログインしていなければ、名乗った runner へ「無い」を降ろすだけで、古い runner のことも日誌に書かない', async () => {
    const h = setup(['old']);
    const old = h.runners[0] as FakeRunner;
    old.unsupported = true;
    await h.service.syncRunner(old.client);
    expect(h.journal).toEqual([]);
    expect((await h.service.status()).loggedIn).toBe(false);
  });

  it('ログイン済みで古い runner（口が無い）へ降ろせないときは、1度だけ日誌に書く', async () => {
    const h = setup(['old']);
    await loggedIn(h);
    const old = h.runners[0] as FakeRunner;
    old.unsupported = true;
    await h.service.syncRunner(old.client);
    await h.service.syncRunner(old.client);
    const notes = h.journal.filter((e) => JSON.stringify(e).includes('降ろせなかった'));
    expect(notes).toHaveLength(1);
  });

  it('取り消すと canceled になり、正本は変わらない', async () => {
    const h = setup();
    const view = await h.service.startLogin();
    expect((await h.service.cancelLogin(view.id))?.state).toBe('canceled');
    expect(await h.stores.codexAuth.get()).toBeNull();
    expect(await h.service.cancelLogin('unknown')).toBeUndefined();
  });
});
