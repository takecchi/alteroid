import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('@alteroid/storage-fs', () => ({
  initWorkspace: vi.fn(),
}));

vi.mock('./daemon.js', () => ({
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
  storageOf: vi.fn(),
  sessionRefusalOf: vi.fn(),
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

beforeEach(() => {
  // 既定は「弾かれていない」（欄が無い）
  vi.mocked(daemon.sessionRefusalOf).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
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
      kind: 'started',
      info: { pid: 4242, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    const read = captureStdout();

    await daemonStartCommand();

    expect(read()).toBe('alteroidd を起動しました (pid 4242, port 4517)\n');
  });

  it('⭐ 既に動いていたときは「起動しました」と言わず、「既に動いています」と言う（Issue #4081）', async () => {
    vi.mocked(daemon.start).mockResolvedValue({
      kind: 'already-present',
      info: { pid: 4242, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    const read = captureStdout();

    await daemonStartCommand();

    const text = read();
    expect(text).toBe('alteroidd は既に動いています (pid 4242, port 4517)\n');
    expect(text).not.toContain('起動しました');
  });

  it('⭐ --force を付けていなければ daemon.start() だけを呼ぶ（startWithRecovery には触れない）', async () => {
    vi.mocked(daemon.start).mockResolvedValue({
      kind: 'started',
      info: { pid: 1, port: 2, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    captureStdout();

    await daemonStartCommand({});
    await daemonStartCommand();

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
    [
      'cleanup-pending',
      'alteroidd の待ち受けは閉じましたが、後始末が終わっていません（プロセスがまだ残っています）。\n' +
        '終わる前に `alteroid daemon start` を打つと、2本が同じ記憶ストアを扱うおそれがあります。' +
        'しばらくしてからやり直すか、ログを確認してください。\n',
    ],
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
      ['cleanup-pending', 1],
      ['unknown', 1],
    ] as const)('%s のときの終了コードは %s', async (outcome, expected) => {
      vi.mocked(daemon.stop).mockResolvedValue(outcome);
      captureStdout();

      await daemonStopCommand();

      expect(process.exitCode).toBe(expected);
    });
  });

  it('後始末を待ち始めたら、待っていることを1行出してから結果を言う（Issue #4080）', async () => {
    vi.mocked(daemon.stop).mockImplementation(async (options) => {
      options?.onCleanupWait?.();
      return 'stopped';
    });
    const read = captureStdout();

    await daemonStopCommand();

    const text = read();
    expect(text).toContain('後始末');
    expect(text).toContain('待っています');
    expect(text.endsWith('alteroidd を停止しました\n')).toBe(true);
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
    expect(text).toContain('記憶: postgres://example');
    expect(text).not.toContain('/home/test/.alteroid');
  });

  it('安全分類器に弾かれ続けているときだけ、連続数・category・自動の開き直しの状態・開き直す口を1行で出す', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'present',
      info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    vi.mocked(daemon.storageOf).mockResolvedValue('postgres://example');
    vi.mocked(daemon.sessionRefusalOf).mockResolvedValue({
      streak: 2,
      category: 'cyber',
      since: '2026-10-08T00:00:00.000Z',
      sessionId: 's-1',
      autoReopen: 'halted',
    });
    const read = captureStdout();

    await daemonStatusCommand();

    const lines = read()
      .split('\n')
      .filter((line) => line.includes('安全分類器'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 回続けて弾かれている');
    expect(lines[0]).toContain('cyber');
    expect(lines[0]).toContain('止めた');
    expect(lines[0]).toContain('alteroid reopen');
  });

  it('弾かれていなければ（欄が無ければ）その行を出さない', async () => {
    vi.mocked(daemon.status).mockResolvedValue({
      presence: 'present',
      info: { pid: 99, port: 4517, startedAt: '2026-08-24T00:00:00.000Z', token: 't' },
    });
    vi.mocked(daemon.storageOf).mockResolvedValue('postgres://example');
    const read = captureStdout();

    await daemonStatusCommand();

    expect(read()).not.toContain('安全分類器');
  });

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

  it('alteroid mcp set の description は、足すのではなく置き換えると言う（#3531）', () => {
    const mcp = program.commands.find((c) => c.name() === 'mcp');
    const set = mcp?.commands.find((c) => c.name() === 'set');
    expect(set?.description()).toContain('足すのではない');
  });

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
    expect(found).toContain('conversations delete');
  });

  it('practice の edit / set は --kind と --title を受ける（set は --file も）', () => {
    const practice = program.commands.find((c) => c.name() === 'practice');
    const optionsOf = (name: string): string[] =>
      (practice?.commands.find((c) => c.name() === name)?.options ?? [])
        .map((o) => o.long ?? '')
        .sort();

    expect(optionsOf('edit')).toEqual(['--kind', '--title']);
    expect(optionsOf('set')).toEqual(['--allow-empty', '--file', '--kind', '--title']);
  });

  it('memory set / practice set の help に --allow-empty が出る（#3456）', () => {
    for (const parent of ['memory', 'practice']) {
      const set = program.commands
        .find((c) => c.name() === parent)
        ?.commands.find((c) => c.name() === 'set');
      expect(set?.helpInformation()).toContain('--allow-empty');
    }
  });

  it('alteroid daemon start は --force を受ける（Issue #1851。stop / status は受けない）', () => {
    const daemonCmd = program.commands.find((c) => c.name() === 'daemon');
    const optionsOf = (name: string): string[] =>
      (daemonCmd?.commands.find((c) => c.name() === name)?.options ?? []).map((o) => o.long ?? '');

    expect(subcommandNames('daemon')).toEqual(['start', 'status', 'stop']);
    expect(optionsOf('start')).toEqual(['--force']);
    expect(optionsOf('stop')).toEqual([]);
    expect(optionsOf('status')).toEqual([]);
  });

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

    const positionals = words
      .slice(3)
      .filter((w, i, all) => !w.startsWith('--') && all[i - 1] !== '--cooldown-ms');
    expect(positionals).toHaveLength(policy?.registeredArguments.length ?? -1);
  });

  it('tui の説明は TABS の全画面の名前を挙げ、「順に足していく」を含まない', async () => {
    const { TABS } = await import('./tui/layout.js');
    const description = program.commands.find((c) => c.name() === 'tui')?.description() ?? '';
    for (const tab of TABS) expect(description).toContain(tab.label);
    expect(description).toContain(`${TABS.length} 画面`);
    expect(description).not.toContain('順に足していく');
  });

  // list が「読めない行」に出す id を指す: デーモンの stderr の跡は、コンテナでは `docker logs` を掘ることになるため（#4052）
  it.each([
    ['access', 'アカウント'],
    ['permission', '許可'],
  ])(
    '%s remove-unreadable の help は、id を list の「読めない行」に出るものと案内する（#4052）',
    (parent, noun) => {
      const help =
        program.commands
          .find((c) => c.name() === parent)
          ?.commands.find((c) => c.name() === 'remove-unreadable')
          ?.description() ?? '';

      expect(help).toContain(`alteroid ${parent} list の「読めない${noun}の行」に出る`);
      expect(help).not.toContain('stderr');
      expect(help).not.toContain('読み飛ばしました');
    },
  );

  it.each(['access', 'permission', 'token', 'integration'])(
    '%s remove-unreadable の help は、デーモンの stderr の跡を案内しない（#4052）',
    (parent) => {
      const help =
        program.commands
          .find((c) => c.name() === parent)
          ?.commands.find((c) => c.name() === 'remove-unreadable')
          ?.description() ?? '';

      expect(help).toContain('list');
      expect(help).not.toContain('stderr');
    },
  );
});
