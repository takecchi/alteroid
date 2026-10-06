import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Issue #1851（`daemon start --force`）— `--force` を付けたときだけ通る道。
  startWithRecovery: vi.fn(),
}));

vi.mock('./paths.js', () => ({
  alteroidRoot: () => '/home/test/.alteroid',
  stateDir: () => '/home/test/.alteroid/state',
}));

const { initWorkspace } = await import('@alteroid/storage-fs');
const daemon = await import('./daemon.js');
const { initCommand, daemonStartCommand, daemonStopCommand, daemonStatusCommand, program } =
  await import('./index.js');
const { SETTINGS_UNREADABLE_FIX_COMMAND } = await import('./token.js');

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

  // ⭐ Issue #1851 — `--force` を付けていない既定の経路は1文字も変えていない。
  // `daemon.start()` だけを呼び、回復専用の `daemon.startWithRecovery()` には
  // 一切触れないことを固定する。
  it('⭐ --force を付けていなければ daemon.start() だけを呼ぶ（startWithRecovery には触れない）', async () => {
    vi.mocked(daemon.start).mockResolvedValue({
      pid: 1,
      port: 2,
      startedAt: '2026-08-24T00:00:00.000Z',
      token: 't',
    });
    captureStdout();

    await daemonStartCommand({});
    await daemonStartCommand(); // 引数省略でも同じ（既定値 {}）

    expect(daemon.start).toHaveBeenCalledTimes(2);
    expect(daemon.startWithRecovery).not.toHaveBeenCalled();
  });

  describe('--force あり（daemon.startWithRecovery() の結果を文言に変換する）', () => {
    it('already-present なら「既に動いています」と言い、退避も再起動もしていないと言う', async () => {
      vi.mocked(daemon.startWithRecovery).mockResolvedValue({
        kind: 'already-present',
        info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
      });
      const read = captureStdout();

      await daemonStartCommand({ force: true });

      const text = read();
      expect(text).toContain('既に動いています');
      expect(text).toContain('pid 99');
      expect(text).not.toContain('退避しました');
      expect(daemon.start).not.toHaveBeenCalled();
    });

    it('started（absent からの通常起動）なら、これまでと同じ起動文言を出す', async () => {
      vi.mocked(daemon.startWithRecovery).mockResolvedValue({
        kind: 'started',
        info: { pid: 55, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
      });
      const read = captureStdout();

      await daemonStartCommand({ force: true });

      expect(read()).toBe('alteroidd を起動しました (pid 55, port 4517)\n');
    });

    it('recovered なら、退避先のパス・前のデーモンの生死・二重起動の危険を順に言ってから起動を報告する', async () => {
      vi.mocked(daemon.startWithRecovery).mockResolvedValue({
        kind: 'recovered',
        info: { pid: 77, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
        quarantinedTo: '/home/test/.alteroid/state/daemon.json.stale-2026-09-28T01-00-00-000Z',
        previousPid: 4242,
        previousPidAlive: true,
      });
      const read = captureStdout();

      await daemonStartCommand({ force: true });

      const text = read();
      expect(text).toContain(
        '退避しました: /home/test/.alteroid/state/daemon.json.stale-2026-09-28T01-00-00-000Z',
      );
      expect(text).toContain('pid 4242');
      expect(text).toContain('まだ生きているように見えます');
      expect(text).toContain('二重起動');
      expect(text).toContain('alteroidd を起動しました (pid 77, port 4517)');
    });

    it('recovered かつ前の pid が既に居ない（previousPidAlive: false）なら、そう正直に言う', async () => {
      vi.mocked(daemon.startWithRecovery).mockResolvedValue({
        kind: 'recovered',
        info: { pid: 77, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
        quarantinedTo: '/home/test/.alteroid/state/daemon.json.stale-x',
        previousPid: 4242,
        previousPidAlive: false,
      });
      const read = captureStdout();

      await daemonStartCommand({ force: true });

      const text = read();
      expect(text).toContain('既に居ないようです');
      expect(text).not.toContain('まだ生きているように見えます');
    });

    it('recovered かつ前の pid の生死が判定できない（previousPidAlive: null）なら、確認できなかったと言う', async () => {
      vi.mocked(daemon.startWithRecovery).mockResolvedValue({
        kind: 'recovered',
        info: { pid: 77, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
        quarantinedTo: '/home/test/.alteroid/state/daemon.json.stale-x',
        previousPid: 4242,
        previousPidAlive: null,
      });
      const read = captureStdout();

      await daemonStartCommand({ force: true });

      const text = read();
      expect(text).toContain('確認できませんでした');
      expect(text).not.toContain('まだ生きているように見えます');
      expect(text).not.toContain('既に居ないようです');
    });
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
    // Issue #1818 — 「確かめられなかった」を「停止した」「片付けた」のように
    // 言い切らない。状態ファイルは残したことまで正直に言う。
    [
      'unknown',
      'alteroidd の生死を確認できませんでした（応答が無いかタイムアウトしました）。\n' +
        '状態ファイルは残したままにしました。ネットワークや負荷を確認してから、' +
        '`alteroid daemon status` で様子を見てください。\n',
    ],
  ] as const)('%s のときは決まった文言を1つだけ出す', async (outcome, expected) => {
    vi.mocked(daemon.stop).mockResolvedValue(outcome);
    const read = captureStdout();

    await daemonStopCommand();

    expect(read()).toBe(expected);
  });

  // Issue #3140 — 止まらなかった・確かめられなかったを、成功（0）と見分けられるようにする。
  describe('終了コード', () => {
    let saved: typeof process.exitCode;
    beforeEach(() => {
      saved = process.exitCode;
      process.exitCode = undefined;
    });
    afterEach(() => {
      process.exitCode = saved;
    });

    it.each([
      ['stopped', undefined],
      ['not-running', undefined],
      ['stale', undefined],
      ['unresponsive', 1],
      ['unknown', 1],
    ] as const)('%s のときの終了コードは %s', async (outcome, expected) => {
      vi.mocked(daemon.stop).mockResolvedValue(outcome);
      captureStdout();

      await daemonStopCommand();

      expect(process.exitCode).toBe(expected);
    });
  });
});

describe('alteroid daemon status', () => {
  it('稼働中（presence: present）なら pid・port・起動時刻・記憶の場所（デーモンに聞いた値）を出す', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'present',
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

  /**
   * issue #2141 段1: ISO の横に経過を添える。ISO はそのまま残る
   * （消えていない）ことも合わせて確かめる。
   */
  it('起動の横に経過を添える。ISO は消えない', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'present',
      info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    vi.mocked(daemon.storageOf).mockResolvedValue('postgres://example');
    const read = captureStdout();

    await daemonStatusCommand(new Date('2026-08-25T00:00:00.000Z').getTime());

    const text = read();
    expect(text).toContain('起動: 2026-08-24T00:00:00.000Z（1日前）');
  });

  it('稼働中でも記憶の場所を聞けなかったら、ローカルのパスへ落とさず「取得できません」と言う', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'present',
      info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    vi.mocked(daemon.storageOf).mockResolvedValue(null);
    const read = captureStdout();

    await daemonStatusCommand();

    const text = read();
    expect(text).toContain('記憶: 取得できません');
    expect(text).not.toContain('/home/test/.alteroid');
  });

  it('停止中（presence: absent）なら「停止中」と言い、記憶の場所はローカルの alteroidRoot() に落ちる', async () => {
    vi.mocked(daemon.status).mockResolvedValue({ presence: 'absent', info: null });
    const read = captureStdout();

    await daemonStatusCommand();

    const text = read();
    expect(text).toContain('停止中');
    expect(text).toContain('記憶: /home/test/.alteroid');
    expect(daemon.storageOf).not.toHaveBeenCalled();
  });

  // ⭐ #1765 段2 の歯 — 「判定できない」という3つ目の状態（presence: 'unknown'）を
  // 「停止中」に畳まないこと。畳むと、実際には生きているデーモンを見落として
  // いても「停止中」という確定的な文言で報告してしまう（誤報）。
  it('確かめられなかった（presence: unknown）なら「停止中」とは言わず、確認できないと言う', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'unknown',
      info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    const read = captureStdout();

    await daemonStatusCommand();

    const text = read();
    expect(text).not.toContain('停止中');
    expect(text).not.toContain('稼働中');
    expect(text).toContain('確認できません');
    expect(daemon.storageOf).not.toHaveBeenCalled();
  });
});

/**
 * `alteroid practice` が**入口として実在すること**（#1055 段3③）。
 *
 * 段3 の受け入れ基準は「人間がやり方を読んで書き換えられる（**3入口すべて**）」で、
 * `docs/PRD.md` の3入口は CLI / HTTP API / Web UI である。#1316 で HTTP と画面は
 * 通ったが、CLI は `practice.ts` が書かれただけで `program` へ繋がれていない状態が
 * 実在した。**そのとき `practice.ts` 側の歯は全部緑である** —— 関数を直接呼ぶ歯は、
 * 登録漏れを1本も検出しない。⟹ ここで見るのは「打てるか」そのものである。
 *
 * **`memory` を並べて測る。** `practice` だけを見ると、写像が定数（何を聞いても
 * 同じ答えを返す形）でも通ってしまう。
 */
describe('サブコマンドの登録（入口が在ること）', () => {
  function subcommandNames(parent: string): string[] {
    const command = program.commands.find((c) => c.name() === parent);
    if (command === undefined) throw new Error(`${parent} が登録されていない`);
    return command.commands.map((c) => c.name()).sort();
  }

  it('alteroid practice は list / show / edit / set / remove / history を持つ（memory + 版の履歴。#1309）', () => {
    expect(subcommandNames('practice')).toEqual([
      'edit',
      'history',
      'list',
      'remove',
      'set',
      'show',
    ]);
    expect(subcommandNames('memory')).toEqual(['edit', 'list', 'remove', 'set', 'show']);
  });

  /**
   * **`alteroid mcp` が入口として実在すること**（#325 段4。PRD の3入口の等価性）。
   * `mcp.ts` 側の歯は関数を直接呼ぶので、`program` への登録漏れを検出しない。
   * `show` の `--reveal` も同じ理由でここで見る —— 付け忘れると値を出す手段が
   * CLI から消える（`.mcp.json` へ書き戻す往復ができなくなる）。
   */
  it('alteroid mcp は list / show / edit / set / clear を持ち、show は --reveal を受ける（#325 段4）', () => {
    expect(subcommandNames('mcp')).toEqual(['clear', 'edit', 'list', 'set', 'show']);
    const mcp = program.commands.find((c) => c.name() === 'mcp');
    const show = mcp?.commands.find((c) => c.name() === 'show');
    expect((show?.options ?? []).map((o) => o.long)).toEqual(['--reveal']);
    const set = mcp?.commands.find((c) => c.name() === 'set');
    expect(set?.registeredArguments.map((arg) => [arg.name(), arg.required])).toEqual([
      ['file', true],
    ]);
  });

  /** **`alteroid integration` が入口として実在すること**（#3113 段2）。 */
  it('alteroid integration は list / create / revoke を持ち、create は --name と --source を要る', () => {
    expect(subcommandNames('integration')).toEqual([
      'create',
      'list',
      'remove-unreadable',
      'revoke',
    ]);
    const integration = program.commands.find((c) => c.name() === 'integration');
    const create = integration?.commands.find((c) => c.name() === 'create');
    expect(create?.options.map((o) => [o.long, o.mandatory])).toEqual([
      ['--name', true],
      ['--source', true],
      ['--expires', false],
      ['--max-body-bytes', false],
      ['--rate-per-minute', false],
      ['--json', false],
    ]);
    const revoke = integration?.commands.find((c) => c.name() === 'revoke');
    expect((revoke?.options ?? []).map((o) => o.long)).toEqual(['--yes']);
  });

  /**
   * **確認を持つ全コマンドの `--yes` の help 文は同じ**（#3214）。非対話で必須なのは全対象で同じ。
   * `integration revoke` も #3211（PR #3229）で揃ったので、例外なく全コマンドを見る。
   */
  it('--yes の help 文は、確認を持つ全コマンドで揃っている', () => {
    const expected = '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）';
    const found: string[] = [];
    const walk = (command: (typeof program.commands)[number], path: string[]): void => {
      for (const option of command.options) {
        if (option.long !== '--yes') continue;
        const name = path.join(' ');
        found.push(name);
        expect([name, option.description]).toEqual([name, expected]);
      }
      for (const child of command.commands) walk(child, [...path, child.name()]);
    };
    for (const command of program.commands) walk(command, [command.name()]);
    expect(found).toContain('reset');
    expect(found).toContain('access remove-unreadable');
    expect(found).toContain('integration revoke');
    expect(found).toContain('integration remove-unreadable');
  });

  /**
   * **`--kind` / `--title` が無いと、新しいやり方を CLI から1件も作れない。**
   * `PracticeStore.write` は `slug`/`kind`/`title`/`content` の全文置換で、
   * `kind` は `practiceKindSchema` が `min(1)` を課す必須フィールドである
   * ——`memory` の `PUT` が `{content}` だけで足りるのとの違いがここに出る。
   */
  it('practice の edit / set は --kind と --title を受ける（set は --file も）', () => {
    const practice = program.commands.find((c) => c.name() === 'practice');
    const optionsOf = (name: string): string[] =>
      (practice?.commands.find((c) => c.name() === name)?.options ?? [])
        .map((o) => o.long ?? '')
        .sort();

    expect(optionsOf('edit')).toEqual(['--kind', '--title']);
    expect(optionsOf('set')).toEqual(['--file', '--kind', '--title']);
  });

  /**
   * **`--force` が無いと、Issue #1851 の回復（状態ファイルの退避 → 起こし
   * 直し）を CLI から1件も引けない。** `--force` を持つのは `daemon start`
   * だけ——`stop` / `status` には要らない（フラグは起動側の回復専用）。
   */
  it('alteroid daemon start は --force を受ける（Issue #1851。stop / status は受けない）', () => {
    const daemonCmd = program.commands.find((c) => c.name() === 'daemon');
    const optionsOf = (name: string): string[] =>
      (daemonCmd?.commands.find((c) => c.name() === name)?.options ?? []).map((o) => o.long ?? '');

    expect(subcommandNames('daemon')).toEqual(['start', 'status', 'stop']);
    expect(optionsOf('start')).toEqual(['--force']);
    expect(optionsOf('stop')).toEqual([]);
    expect(optionsOf('status')).toEqual([]);
  });

  /**
   * 「回転の設定は読めない」の案内が指すコマンドが、`token policy` の引数解釈で
   * 実際に受け付けられること（案内が腐らないように）。フラグを改名・削除したら
   * 案内が存在しないフラグを指す——それを赤にする。
   */
  it('token policy の読めないとき案内は、登録済みのフラグと位置引数だけを指す', () => {
    const tokenCmd = program.commands.find((c) => c.name() === 'token');
    const policy = tokenCmd?.commands.find((c) => c.name() === 'policy');
    expect(policy).toBeDefined();

    const words = SETTINGS_UNREADABLE_FIX_COMMAND.split(' ');
    expect(words.slice(0, 3)).toEqual(['alteroid', 'token', 'policy']);

    const flags = words.filter((w) => w.startsWith('--'));
    expect(flags).toEqual(['--cooldown-ms']);
    const registered = (policy?.options ?? []).map((o) => o.long);
    for (const flag of flags) expect(registered).toContain(flag);

    // フラグの直後の値と、位置引数（回す契機）が1つ。それ以外の語は無い。
    const positionals = words
      .slice(3)
      .filter((w, i, all) => !w.startsWith('--') && all[i - 1] !== '--cooldown-ms');
    expect(positionals).toHaveLength(policy?.registeredArguments.length ?? -1);
  });
});
