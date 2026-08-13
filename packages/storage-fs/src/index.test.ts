import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createFsStores, initWorkspace } from './index.js';

let root: string;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'alteroid-test-'));
  stores = createFsStores(root);
});

describe('initWorkspace', () => {
  it('人格データディレクトリを生成する（受け入れ基準1）', async () => {
    const result = await initWorkspace(root);

    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        'memory',
        'journal',
        'jobs',
        'archive',
        'state',
        'auth',
        'README.md',
      ]),
    );
    expect(result.created.some((p) => p.endsWith('about-me.md'))).toBe(true);
  });

  it('二度目は既存ファイルを上書きしない（人間の編集を消さない）', async () => {
    await initWorkspace(root);
    await stores.persona.write('about-me', '# 私\n\n手で書いた内容\n');

    const second = await initWorkspace(root);

    expect(second.created).toEqual([]);
    expect((await stores.persona.read('about-me'))?.content).toContain('手で書いた内容');
  });
});

describe('FsPersonaStore', () => {
  it('書いて読める', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
  });

  it('人間がファイルを手で書き換えると次の読み出しに反映される（受け入れ基準3）', async () => {
    await stores.persona.write('values', '# 価値観\n\nもとの内容\n');

    // クローンを介さずエディタで直接書き換える、を模す
    await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n人間が書き換えた\n', 'utf8');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    expect(await stores.persona.concat()).toContain('人間が書き換えた');
  });

  it('append は末尾に足す', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
  });

  it('同時に追記しても取りこぼさない（蒸留は並行して同じ文書に書く）', async () => {
    await stores.persona.write('log', '# ログ\n');

    await Promise.all([
      stores.persona.append('log', '- AAA'),
      stores.persona.append('log', '- BBB'),
      stores.persona.append('log', '- CCC'),
    ]);

    const content = (await stores.persona.read('log'))?.content ?? '';
    expect(content).toContain('AAA');
    expect(content).toContain('BBB');
    expect(content).toContain('CCC');
  });

  it('書き込みは一時ファイル経由（人間に壊れた途中経過を読ませない）', async () => {
    await stores.persona.write('values', '# 価値観\n');

    // .tmp が残っていない = rename で置き換わっている
    expect((await readdir(join(root, 'memory'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await stores.persona.list()).toHaveLength(1);
  });

  it('存在しない記憶は null', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
  });

  it('経路をまたぐスラッグを拒む', async () => {
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('concat は全文書を連結する', async () => {
    await stores.persona.write('a', '# A\n\nあ\n');
    await stores.persona.write('b', '# B\n\nい\n');

    const all = await stores.persona.concat();

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });
});

describe('FsJournalStore', () => {
  it('追記して新しい順に読める', async () => {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '最初',
    });
    await stores.journal.append({
      type: 'decision',
      decision: '自分で答えた',
      grounds: 'about-me.md にそう書いてある',
    });

    const entries = await stores.journal.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe('decision');
    expect(entries[1]?.type).toBe('exchange');
  });

  it('type と limit で絞れる', async () => {
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'a' });
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'outbound', text: 'b' });
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
    expect(await stores.journal.list({ limit: 2 })).toHaveLength(2);
  });

  it('JSONL として人間が読める形で残る', async () => {
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    const files = await readdir(join(root, 'journal'));
    const raw = await readFile(join(root, 'journal', files[0] as string), 'utf8');

    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(JSON.parse(raw.trim())).toMatchObject({ type: 'decision', decision: 'd' });
  });

  it('since より古い日のファイルは読まない（日報・要約が毎回全部を読まないため）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const journalDir = join(root, 'journal');
    // 過去の日誌を手で置く。読まれてしまうなら壊れた行で気づける。
    await writeFile(join(journalDir, '2020-01-01.jsonl'), 'これは JSON ではない\n', 'utf8');
    const old = join(journalDir, '2020-01-02.jsonl');
    await writeFile(
      old,
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-02T00:00:00.000Z',
        decision: '昔の分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const entries = await stores.journal.list({ since });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['今日の分']);

    // since を外せば古い分まで見える（打ち切りは読み飛ばしであって欠落ではない）
    expect(await stores.journal.list()).toHaveLength(2);
  });

  it('同時追記でも行が壊れない', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: `t${i}` }),
      ),
    );

    expect(await stores.journal.list()).toHaveLength(20);
  });
});

describe('FsJobStore', () => {
  it('承認待ちを積んで回答できる', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-1');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      answeredAt: new Date().toISOString(),
      answer: 'よい',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
  });

  it('同じ id は上書きされる', async () => {
    const base = { id: 'j-1', createdAt: '2026-01-01T00:00:00.000Z', question: 'q' };
    await stores.jobs.putApproval(base);
    await stores.jobs.putApproval({ ...base, question: 'q2' });

    expect(await stores.jobs.listApprovals()).toHaveLength(1);
  });
});

describe('FsTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = await stores.archive.archive('session-1', '{"a":1}\n');

    expect(await stores.archive.list()).toContain(id);
    expect(await stores.archive.read(id)).toBe('{"a":1}\n');
  });

  it('ディレクトリ外は読ませない', async () => {
    expect(await stores.archive.read('../../etc/passwd')).toBeNull();
  });
});

describe('FsSessionRegistry', () => {
  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });
});

/**
 * ログインとアクセス許可。**fs と pg で同じ振る舞いになること**を両方で問う
 * （器が違うだけで上の層が見るものは同じ、が M4 の要件）。
 */
describe('AuthStore', () => {
  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
  };

  it('アカウントを保存して読み戻せる', async () => {
    await stores.auth.putAccount(account);

    expect(await stores.auth.getAccount('account-1')).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
    expect(await stores.auth.getAccount('居ない')).toBeNull();
  });

  it('許可の2値を書き換えられる（alteroid access grant の実体）', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putAccount({
      ...account,
      grantedAt: '2026-01-02T00:00:00.000Z',
      grantedBy: 'operator',
    });

    const stored = await stores.auth.getAccount('account-1');
    expect(stored?.grantedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(stored?.grantedBy).toBe('operator');
    // 上書きであって増殖ではない
    expect(await stores.auth.listAccounts()).toHaveLength(1);
  });

  it('検証済みメールからアカウントを引ける（相乗りの検査に使う）', async () => {
    await stores.auth.putAccount(account);

    expect((await stores.auth.findAccountByEmail('owner@example.test'))?.id).toBe('account-1');
    expect(await stores.auth.findAccountByEmail('別人@example.test')).toBeNull();
  });

  it('identity は (provider, subject) で一意（同じ人の入り直しで増えない）', async () => {
    await stores.auth.putAccount(account);
    const identity = {
      provider: 'google',
      subject: 'sub-1',
      accountId: 'account-1',
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await stores.auth.putIdentity(identity);
    await stores.auth.putIdentity({ ...identity, lastLoginAt: '2026-01-05T00:00:00.000Z' });

    const identities = await stores.auth.listIdentities('account-1');
    expect(identities).toHaveLength(1);
    expect(identities[0]?.lastLoginAt).toBe('2026-01-05T00:00:00.000Z');
    expect((await stores.auth.findIdentity('google', 'sub-1'))?.accountId).toBe('account-1');
    expect(await stores.auth.findIdentity('google', '別の sub')).toBeNull();
  });

  it('アクセストークンは sha256 で引ける（素の値は持たない）', async () => {
    await stores.auth.putAccount(account);
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(token);

    expect(await stores.auth.findAccessTokenBySha256('a'.repeat(64))).toEqual(token);
    expect(await stores.auth.findAccessTokenBySha256('b'.repeat(64))).toBeNull();
    expect(await stores.auth.listAccessTokens('account-1')).toEqual([token]);
  });

  it('ログイン要求を保存して読み戻せる（ブラウザ往復の突き合わせ）', async () => {
    const request = {
      id: 'login-1',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'c'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending' as const,
      accountId: null,
      error: null,
    };
    await stores.auth.putLoginRequest(request);
    expect(await stores.auth.getLoginRequest('login-1')).toEqual(request);

    await stores.auth.putLoginRequest({ ...request, status: 'consumed' as const });
    expect((await stores.auth.getLoginRequest('login-1'))?.status).toBe('consumed');
    expect(await stores.auth.getLoginRequest('居ない')).toBeNull();
  });
  it('ログイン要求の引き取りは1回だけ成功する（並行でも二重発行させない）', async () => {
    const request = {
      id: 'login-2',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'd'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated' as const,
      accountId: 'account-1',
      error: null,
    };
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest(request);

    // 読んでから書く形だと、ここで全部が authenticated を掴んでしまう。
    let issued = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        stores.auth.claimLoginRequest('login-2', (request) => ({
          id: `token-race-${++issued}`,
          accountId: request.accountId ?? '',
          sha256: String(issued).repeat(64).slice(0, 64),
          label: request.label,
          createdAt: '2026-01-02T00:00:00.000Z',
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        })),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-2'))?.status).toBe('consumed');
    // 保存されたトークンも1本だけ（応答が1件でも器に2本あれば通ってしまう）。
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
    // 一度 consumed になったら、あとから何度呼んでも取れない。
    expect(await stores.auth.claimLoginRequest('login-2', () => neverIssued())).toBeNull();
  });

  it('pending のログイン要求は引き取れない（ブラウザ側が終わる前に発行しない）', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-3',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'e'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    expect(await stores.auth.claimLoginRequest('login-3', () => neverIssued())).toBeNull();
    expect((await stores.auth.getLoginRequest('login-3'))?.status).toBe('pending');
    expect(await stores.auth.claimLoginRequest('居ない', () => neverIssued())).toBeNull();
  });
  it('別々のアカウントへ同時に grant しても、持ち主は1人しかできない', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantExclusive('account-1', at, 'operator'),
      stores.auth.grantExclusive('account-2', at, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(1);
    // 器に2人残っていたら、応答が1件でも両方が通ってしまう。
    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(1);
  });

  it('トークンの保存が落ちたら、ログイン要求は authenticated のまま残る', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest({
      id: 'login-4',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'f'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated',
      accountId: 'account-1',
      error: null,
    });

    // 消費だけ先に確定してしまうと、トークンは返らないのに二度と引き取れなくなる。
    await expect(
      stores.auth.claimLoginRequest('login-4', () => {
        throw new Error('トークンを作れなかった');
      }),
    ).rejects.toThrow();
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('authenticated');

    // 直れば、同じ要求をそのまま引き取れる。
    const claimed = await stores.auth.claimLoginRequest('login-4', (request) => ({
      id: 'token-4',
      accountId: request.accountId ?? '',
      sha256: 'b'.repeat(64),
      label: request.label,
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    }));
    expect(claimed?.token.id).toBe('token-4');
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('consumed');
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
  });
});

/** 引き取れないはずの経路で呼ばれたら、テストとして落とす。 */
function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}
