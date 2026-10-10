import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./daemon.js', () => ({
  status: vi.fn(),
  ensureRunning: vi.fn(),
  baseUrl: (info: { port: number }) => `http://127.0.0.1:${info.port}`,
}));

vi.mock('./credentials.js', async (importActual) => ({
  CredentialsUnreadableError: (await importActual<typeof import('./credentials.js')>())
    .CredentialsUnreadableError,
  readCredential: vi.fn(() => Promise.resolve(null)),
}));

const { describeAuthFailure, forbiddenKindOf, resolveTarget, isRunnerContainer, RUNNER_ID_ENV } =
  await import('./target.js');
const daemon = await import('./daemon.js');
const credentials = await import('./credentials.js');

// 文言を定数として import せず直接書く: `forbiddenKindOf` と同じ変数を参照すると、デーモンの文言が変わったときに歯まで一緒に変わり、ずれを検出できなくなるため
const NOT_OPERATOR_BODY = { error: '実行環境の持ち主だけが操作できる' };
const NOT_GRANTED_BODY = { error: 'このアカウントには alteroid を使う許可が無い' };

describe('forbiddenKindOf', () => {
  it('持ち主用の本文を not_operator と判別する', () => {
    expect(forbiddenKindOf(NOT_OPERATOR_BODY)).toBe('not_operator');
  });

  it('未 grant 用の本文を not_granted と判別する', () => {
    expect(forbiddenKindOf(NOT_GRANTED_BODY)).toBe('not_granted');
  });

  it('どちらとも判別できない本文を unknown とする（空オブジェクト）', () => {
    expect(forbiddenKindOf({})).toBe('unknown');
  });

  // 旧デーモンの `requireOwner` の本文は、もう専用の種別を持たない（#2948）: 案内の分岐を作らず unknown のまま。
  it('旧デーモンの未宣言 owner の本文は unknown（専用の案内を持たない。#2948）', () => {
    expect(
      forbiddenKindOf({ error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' }),
    ).toBe('unknown');
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

describe('describeAuthFailure（403 の案内）', () => {
  const target = { baseUrl: 'http://127.0.0.1:4517', headers: {}, remote: false, note: null };

  it('403 は access grant を案内する（access owner は案内しない。#2948）', () => {
    const message = describeAuthFailure(403, target);
    expect(message).toContain('alteroid access list');
    expect(message).toContain('alteroid access grant <アカウント id>');
    expect(message).not.toContain('access owner');
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
