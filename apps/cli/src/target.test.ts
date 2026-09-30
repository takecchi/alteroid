import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveTarget` / `isRunnerContainer` の歯(#2093)のために、`daemon.js` と
 * `credentials.js` を差し替える。**`daemon.js` の3関数だけ** —— `index.test.ts`
 * と同じ形（`start` / `stop` は呼ばれない経路なのでここでは省くが、`vi.fn()` に
 * しておけば未使用でも型は壊れない）。
 */
vi.mock('./daemon.js', () => ({
  status: vi.fn(),
  ensureRunning: vi.fn(),
  baseUrl: (info: { port: number }) => `http://127.0.0.1:${info.port}`,
}));

vi.mock('./credentials.js', async (importActual) => ({
  // `target.ts` は `instanceof CredentialsUnreadableError` で読めなかった回を分ける（#2447）。
  CredentialsUnreadableError: (await importActual<typeof import('./credentials.js')>())
    .CredentialsUnreadableError,
  readCredential: vi.fn(() => Promise.resolve(null)),
}));

const { describeAuthFailure, forbiddenKindOf, resolveTarget, isRunnerContainer, RUNNER_ID_ENV } =
  await import('./target.js');
const daemon = await import('./daemon.js');
const credentials = await import('./credentials.js');

/**
 * `forbiddenKindOf` — 403 の本文から、どちらの理由で拒否されたかを判別する。
 *
 * **この3つの逐語は `apps/daemon/src/app.ts` の複製である。import はしない**
 * （`target.ts` の `NOT_OPERATOR_ERROR` / `NOT_GRANTED_ERROR` /
 * `NOT_DECLARED_OWNER_ERROR` の doc と同じ理由）。ここでも import せずに直接
 * 書く——`forbiddenKindOf` が内部で使っている定数と同じ変数を歯の側でも参照
 * すると、デーモンの文言が変わったときに歯まで一緒に変わって自己整合し、
 * ずれを検出できなくなる。
 */
const NOT_OPERATOR_BODY = { error: '実行環境の持ち主だけが操作できる' };
const NOT_GRANTED_BODY = { error: 'このアカウントには alteroid を使う許可が無い' };
const NOT_DECLARED_OWNER_BODY = {
  error: '実行環境の持ち主として宣言されたアカウントだけが操作できる',
};

describe('forbiddenKindOf', () => {
  it('持ち主用の本文を not_operator と判別する', () => {
    expect(forbiddenKindOf(NOT_OPERATOR_BODY)).toBe('not_operator');
  });

  it('未 grant 用の本文を not_granted と判別する', () => {
    expect(forbiddenKindOf(NOT_GRANTED_BODY)).toBe('not_granted');
  });

  it('未宣言 owner 用の本文を not_declared_owner と判別する（issue #1198。requireOwner）', () => {
    expect(forbiddenKindOf(NOT_DECLARED_OWNER_BODY)).toBe('not_declared_owner');
  });

  // **⭐ ここが設計の芯——3行目の歯である。** 判別できない本文で当てずっぽうに
  // どちらかへ倒すと、必ず嘘の案内を出す状況が生まれる。`unknown` を返すこと
  // そのものが守るべき性質なので、必ず測る。
  it('どちらとも判別できない本文を unknown とする（空オブジェクト）', () => {
    expect(forbiddenKindOf({})).toBe('unknown');
  });

  it('どちらとも判別できない本文を unknown とする（別の理由の error）', () => {
    expect(forbiddenKindOf({ error: 'なにか別の理由' })).toBe('unknown');
  });

  it('本文が無い・オブジェクトでないときも unknown', () => {
    expect(forbiddenKindOf(undefined)).toBe('unknown');
    expect(forbiddenKindOf(null)).toBe('unknown');
    expect(forbiddenKindOf('forbidden')).toBe('unknown');
  });
});

describe('describeAuthFailure（403・kind による案内の分岐）', () => {
  const target = { baseUrl: 'http://127.0.0.1:4517', headers: {}, remote: false, note: null };

  it('kind を省略すると（既定 unknown）、従来どおり access grant を案内する', () => {
    const message = describeAuthFailure(403, target);
    expect(message).toContain('alteroid access grant <アカウント id>');
    expect(message).not.toContain('access owner');
  });

  it('not_granted も access grant を案内する（省略時と同じ文言）', () => {
    const message = describeAuthFailure(403, target, 'not_granted');
    expect(message).toContain('alteroid access grant <アカウント id>');
  });

  it('not_declared_owner は access owner を案内する（issue #1198。access grant は勧めない）', () => {
    const message = describeAuthFailure(403, target, 'not_declared_owner');
    expect(message).toContain('alteroid access list');
    expect(message).toContain('alteroid access owner <アカウント id>');
    expect(message).not.toContain('access grant <アカウント id>');
  });
});

describe('isRunnerContainer', () => {
  it('ALTEROID_RUNNER_ID が非空なら true', () => {
    expect(isRunnerContainer({ [RUNNER_ID_ENV]: 'runner-primary' })).toBe(true);
  });

  it('ALTEROID_RUNNER_ID が無ければ false', () => {
    expect(isRunnerContainer({})).toBe(false);
  });

  it('ALTEROID_RUNNER_ID が空文字・空白だけなら false（#2093 の穴と同じ形にしない）', () => {
    expect(isRunnerContainer({ [RUNNER_ID_ENV]: '' })).toBe(false);
    expect(isRunnerContainer({ [RUNNER_ID_ENV]: '   ' })).toBe(false);
  });
});

/**
 * `resolveTarget` — #2093。runner の器の中では、手元のデーモンを暗黙には
 * 起こさない。`env` を明示的に渡すことでテストする（`resolveTarget` 自身の
 * doc に書いたとおり、省略時は `process.env` を読むだけで挙動は変わらない）。
 */
describe('resolveTarget（#2093。runner の器の中での暗黙起動を止める）', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const runnerEnv = { [RUNNER_ID_ENV]: 'runner-primary' };
  const hostEnv = {};

  it('runner の中 × デーモン absent → ensureRunning を呼ばず、ALTEROID_URL を含む案内で例外', async () => {
    vi.mocked(daemon.status).mockResolvedValue({ presence: 'absent', info: null });

    await expect(resolveTarget(runnerEnv)).rejects.toThrow(/ALTEROID_URL/);

    expect(daemon.ensureRunning).not.toHaveBeenCalled();
  });

  it('runner の中 × デーモン unknown → 同様に起こさず例外（absent と同じ扱い）', async () => {
    vi.mocked(daemon.status).mockResolvedValue({ presence: 'unknown', info: null });

    await expect(resolveTarget(runnerEnv)).rejects.toThrow(/ALTEROID_URL/);

    expect(daemon.ensureRunning).not.toHaveBeenCalled();
  });

  it('runner の中 × デーモン present → 起こさずにそのまま繋ぐ', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'present',
      info: { pid: 123, port: 4517, startedAt: '2026-09-29T00:00:00.000Z', token: 'tok-1' },
    });

    const target = await resolveTarget(runnerEnv);

    expect(target).toEqual({
      baseUrl: 'http://127.0.0.1:4517',
      headers: { authorization: 'Bearer tok-1' },
      remote: false,
      note: null,
    });
    expect(daemon.ensureRunning).not.toHaveBeenCalled();
  });

  it('runner の外（ALTEROID_RUNNER_ID が無い）× absent → 従来どおり ensureRunning を呼ぶ', async () => {
    vi.mocked(daemon.ensureRunning).mockResolvedValue({
      pid: 456,
      port: 4518,
      startedAt: '2026-09-29T00:00:00.000Z',
      token: 'tok-2',
    });

    const target = await resolveTarget(hostEnv);

    expect(target).toEqual({
      baseUrl: 'http://127.0.0.1:4518',
      headers: { authorization: 'Bearer tok-2' },
      remote: false,
      note: null,
    });
    expect(daemon.ensureRunning).toHaveBeenCalledTimes(1);
    // `status` は `ensureRunning` の内側（本物の daemon.ts）の仕事であって、
    // `resolveTarget` 自身が呼んではいけない——ここは丸ごとモックなので、
    // 直接呼ばれていないことだけを確かめる。
    expect(daemon.status).not.toHaveBeenCalled();
  });

  it('runner の外（ALTEROID_RUNNER_ID が空文字）でも同様に ensureRunning を呼ぶ', async () => {
    vi.mocked(daemon.ensureRunning).mockResolvedValue({
      pid: 789,
      port: 4519,
      startedAt: '2026-09-29T00:00:00.000Z',
      token: 'tok-3',
    });

    await resolveTarget({ [RUNNER_ID_ENV]: '' });

    expect(daemon.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('ALTEROID_URL があれば、runner の中でも従来どおり remote（daemon には一切触らない）', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(null);

    const target = await resolveTarget({ ...runnerEnv, ALTEROID_URL: 'https://prod.example.com' });

    expect(target.remote).toBe(true);
    expect(target.baseUrl).toBe('https://prod.example.com');
    expect(target.note).toContain('ログインしていません');
    expect(daemon.ensureRunning).not.toHaveBeenCalled();
    expect(daemon.status).not.toHaveBeenCalled();
  });
});
