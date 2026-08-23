import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid init` / `alteroid daemon start・stop・status` — index.ts に直書き
 * されていて、他のサブコマンドと違い exported な `*Command` 関数を持たなかった
 * 3つ（#333）。テストできる形にするため `initCommand` / `daemonStartCommand` /
 * `daemonStopCommand` / `daemonStatusCommand` として切り出した（挙動は1文字も
 * 変えていない）。
 *
 * **`index.ts` を import すると `program.parseAsync(process.argv)` まで走る
 * おそれがある。** `invokedDirectly()` の歯（apps/runner・apps/daemon と同じ
 * 形）でそれを防いでいるので、ここでの import はコマンドの登録だけで安全に
 * 済む（実際、この4テストが動くこと自体が、その歯が効いていることの確認でも
 * ある — 効いていなければ commander が vitest の argv を解釈しようとして
 * どこかで例外か `process.exit` が起きる）。
 */
vi.mock('@alteroid/storage-fs', () => ({
  initWorkspace: vi.fn(),
}));

vi.mock('./daemon.js', () => ({
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
  storageOf: vi.fn(),
}));

vi.mock('./paths.js', () => ({
  alteroidRoot: () => '/home/test/.alteroid',
  stateDir: () => '/home/test/.alteroid/state',
}));

const { initWorkspace } = await import('@alteroid/storage-fs');
const daemon = await import('./daemon.js');
const { initCommand, daemonStartCommand, daemonStopCommand, daemonStatusCommand } =
  await import('./index.js');

afterEach(() => {
  vi.restoreAllMocks();
  // `daemon.js` / `@alteroid/storage-fs` は `vi.mock` のモジュールモックで
  // `vi.fn()` を返しているだけなので、`restoreAllMocks`（`vi.spyOn` の巻き戻し）
  // では呼び出し履歴が消えない。次のテストへ call 数が漏れないよう明示して消す。
  vi.clearAllMocks();
});

describe('alteroid init', () => {
  it('新しく作ったファイルを1つずつ「作成:」で並べ、次にやることまで言う', async () => {
    vi.mocked(initWorkspace).mockResolvedValue({
      paths: { root: '/home/test/.alteroid' } as never,
      created: ['/home/test/.alteroid', '/home/test/.alteroid/memory'],
    });
    const read = captureStdout();

    await initCommand();

    const text = read();
    expect(text).toContain('/home/test/.alteroid を初期化しました');
    expect(text).toContain('  作成: /home/test/.alteroid\n');
    expect(text).toContain('  作成: /home/test/.alteroid/memory\n');
    expect(text).not.toContain('既に初期化済み');
    expect(text).toContain('次: alteroid chat');
  });

  it('作られたファイルが0件なら「既に初期化済み」と言い、作成行は1行も出さない', async () => {
    vi.mocked(initWorkspace).mockResolvedValue({
      paths: { root: '/home/test/.alteroid' } as never,
      created: [],
    });
    const read = captureStdout();

    await initCommand();

    const text = read();
    expect(text).toContain('既に初期化済み。既存のファイルには触れていません');
    expect(text).not.toContain('作成:');
  });
});

describe('alteroid daemon start', () => {
  it('起こしたデーモンの pid と port を言う', async () => {
    vi.mocked(daemon.start).mockResolvedValue({
      pid: 4242,
      port: 4517,
      startedAt: '2026-08-24T00:00:00.000Z',
      token: 't',
    });
    const read = captureStdout();

    await daemonStartCommand();

    expect(read()).toBe('alteroidd を起動しました (pid 4242, port 4517)\n');
  });
});

describe('alteroid daemon stop', () => {
  it.each([
    ['stopped', 'alteroidd を停止しました\n'],
    ['not-running', 'alteroidd は動いていません\n'],
    [
      'stale',
      'alteroidd は応答しません。古い状態ファイルを片付けました。\n' +
        'プロセスが残っている場合は手で確認して終了してください。\n',
    ],
    ['unresponsive', 'alteroidd が停止要求に応じません。ログを確認してください。\n'],
  ] as const)('%s のときは決まった文言を1つだけ出す', async (outcome, expected) => {
    vi.mocked(daemon.stop).mockResolvedValue(outcome);
    const read = captureStdout();

    await daemonStopCommand();

    expect(read()).toBe(expected);
  });
});

describe('alteroid daemon status', () => {
  it('稼働中なら pid・port・起動時刻・記憶の場所（デーモンに聞いた値）を出す', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      running: true,
      info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    vi.mocked(daemon.storageOf).mockResolvedValue('postgres://example');
    const read = captureStdout();

    await daemonStatusCommand();

    const text = read();
    expect(text).toContain('稼働中: pid 99, http://127.0.0.1:4517');
    expect(text).toContain('起動: 2026-08-24T00:00:00.000Z');
    // ローカルのパスではなく、デーモンに聞いた値を出す（クラウド構成の取り違え防止）。
    expect(text).toContain('記憶: postgres://example');
    expect(text).not.toContain('/home/test/.alteroid');
  });

  it('停止中なら「停止中」と言い、記憶の場所はローカルの alteroidRoot() に落ちる', async () => {
    vi.mocked(daemon.status).mockResolvedValue({ running: false, info: null });
    const read = captureStdout();

    await daemonStatusCommand();

    const text = read();
    expect(text).toContain('停止中');
    expect(text).toContain('記憶: /home/test/.alteroid');
    expect(daemon.storageOf).not.toHaveBeenCalled();
  });
});
