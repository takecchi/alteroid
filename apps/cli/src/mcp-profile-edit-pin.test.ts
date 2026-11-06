import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { describeCliFailure } from './failure-message.js';
import { captureStderr, captureStdout } from './test-support.js';

// 場面ごとに「届け先の注記」を切り替えられるようにする（未ログインの注記が出る場面）
const state = vi.hoisted(() => ({ note: null as string | null }));

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: state.note }),
}));

const { mcpEditCommand } = await import('./mcp.js');
const { profileEditCommand } = await import('./profile.js');

// `mcp edit` と `profile edit` の振る舞いを、場面ごとにコミットした固定値（mcp-profile-edit-pin.json）と丸ごと比べる。
// 2つの edit は「一時ファイル（0600）に書く → エディタで開く → 読み直す → 変わっていなければ何もしない → 送る」の
// 同じ骨格を持つ（記憶とやり方の edit と同じ骨格）。骨格を共通の関数に寄せるとき、画面に出る文言・デーモンへの
// 要求の並び・エディタの起こし方・一時ファイルの mode・下書きの残り方・失敗の形が1文字も変わらないことを確かめる歯。
//
// 記録するもの（場面ごと）:
//   - stdout / stderr: 出力の全文（一時ディレクトリの場所と乱数だけを置き換える）
//   - requests: デーモンへ出した要求の並び（メソッド・URL・本文。本文は JSON として読んだもの）
//   - editor: エディタの起こし方（引数の数・開いたファイル・開いたときの中身・ファイルの mode）
//   - out: 返ったか投げたか（投げた文言の全文・`alteroid: …` の失敗行・終了コード）
//   - drafts: 終了後に一時ディレクトリへ残ったファイル（相対パス・mode・中身）。消えていれば空
//
// 固定値の作り直し（意図して振る舞いを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_EDIT_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/cli exec vitest run src/mcp-profile-edit-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write apps/cli/src/mcp-profile-edit-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の何が動いたかを読む。
//
// 秘密: 値はすべて作りもの（FAKE_…）。

const PIN_URL = new URL('./mcp-profile-edit-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_EDIT_PIN === '1';

interface Reply {
  status: number;
  body: unknown;
}

interface Scenario {
  name: string;
  covers: string;
  run: () => Promise<unknown>;
  replies: Reply[];
  /** エディタが開いたファイルへ書く中身。無ければ触らない */
  writes?: string;
  /** エディタの終了コード（既定 0） */
  exit?: number;
  /** `EDITOR` をこの文字列にする（エディタが無い場面） */
  editor?: string;
  /** 届け先の注記（未ログインの案内） */
  note?: string;
}

const FAKE = 'FAKE_NOT_A_REAL_VALUE';
const MCP_SERVERS = { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: FAKE } } };
const MCP_EDITED = `${JSON.stringify({ mcpServers: { linear: { command: 'linear-mcp' } } }, null, 2)}\n`;

const mcpGet = (servers: unknown = MCP_SERVERS, version = 'v-read'): Reply => ({
  status: 200,
  body: { mcpServers: servers, updatedAt: '2026-11-08T00:00:00.000Z', version },
});
const mcpPut = (over: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    names: ['linear'],
    updatedAt: '2026-11-08T00:00:01.000Z',
    sha256: 'sha-new',
    appliesFrom: '次に起こす仕事から',
    runners: [
      { runnerId: 'runner-a', ok: true, mcpServers: { names: ['linear'], sha256: 'sha-new' } },
    ],
    ...over,
  },
});

const row = (name: string, script: string, scope = 'all', version = 'v-read') => ({
  name,
  script,
  scope,
  updatedAt: '2026-11-08T00:00:00.000Z',
  sha256: 'sha-row',
  bytes: script.length,
  version,
});
const profileGet = (entries: unknown[]): Reply => ({
  status: 200,
  body: { entries, clone: { sha256: 'c0' }, runner: { sha256: 'r0' } },
});
const profilePut = (name = 'default', over: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    updatedAt: '2026-11-08T00:00:01.000Z',
    entries: [row(name, 'x', 'all', 'v-new')],
    composed: { clone: { sha256: 'c1' }, runner: { sha256: 'r1' } },
    clone: { ok: true },
    runners: [{ runnerId: 'runner-a', ok: true }],
    ...over,
  },
});
const SCRIPT = 'export FAKE_A=1\n';
const EDITED = 'export FAKE_A=2\n';

const SCENARIOS: Scenario[] = [
  // ---- mcp ----
  {
    name: 'mcp/unchanged-existing',
    covers: '在る登録を開いて何も変えずに閉じる: 送らずに「変更はありません」。下書きは消える',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
  },
  {
    name: 'mcp/changed-existing',
    covers: '登録を書き換える: 読んだ版を ifMatch に付けた PUT。差し替えの報告を出す',
    run: () => mcpEditCommand(),
    replies: [mcpGet(), mcpPut()],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/changed-runner-push-failure',
    covers: '送れたが一部の runner へ届かない: 警告つきの報告を出した上で失敗にする。下書きは残す',
    run: () => mcpEditCommand(),
    replies: [
      mcpGet(),
      mcpPut({
        runners: [{ runnerId: 'runner-a', ok: false, error: 'runner が応答しない' }],
      }),
    ],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/empty-registry-unchanged',
    covers: '登録が空のとき開いて何も変えずに閉じる: 空の袋が雛形。変更なし',
    run: () => mcpEditCommand(),
    replies: [mcpGet({}, 'v0')],
  },
  {
    name: 'mcp/empty-registry-filled',
    covers: '登録が空のとき書いて閉じる: 版は読んだ版（v0）',
    run: () => mcpEditCommand(),
    replies: [mcpGet({}, 'v0'), mcpPut()],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/emptied-file',
    covers:
      'ファイルを空にして閉じる: 形の検査で断り（何も保存しない）、下書きを残す。空の本文の専用の断りは無い',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
    writes: '',
  },
  {
    name: 'mcp/invalid-json',
    covers: 'JSON として読めない: 断り、下書きを残す',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
    writes: '{ "mcpServers": ',
  },
  {
    name: 'mcp/wrong-shape',
    covers: '`{ "mcpServers": { … } }` の形でない: 断り、下書きを残す',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
    writes: '[]\n',
  },
  {
    name: 'mcp/editor-exit-after-edit',
    covers: '書き換えた後にエディタが非0で終わる: 送らず、下書きを残し、打ち直しのコマンドを案内',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
    writes: MCP_EDITED,
    exit: 3,
  },
  {
    name: 'mcp/editor-exit-unchanged',
    covers: '何も変えずにエディタが非0で終わる: 失敗にするが、下書きは残さず消す',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
    exit: 3,
  },
  {
    name: 'mcp/editor-missing',
    covers: 'エディタのコマンドが無い（127）: 案内つきの失敗',
    run: () => mcpEditCommand(),
    replies: [mcpGet()],
    editor: 'alteroid-no-such-editor-pin',
  },
  {
    name: 'mcp/conflict-409',
    covers:
      '送ったら 409（読んだ後に変わっていた）: いまの登録の名前だけを出して失敗。下書きは残す',
    run: () => mcpEditCommand(),
    replies: [
      mcpGet(),
      {
        status: 409,
        body: {
          error: '変わっています',
          current: { mcpServers: { zeta: {}, alpha: {} }, version: 'v-now' },
        },
      },
    ],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/conflict-409-no-body',
    covers: '409 で本文が読めない: 「いまの登録: （無し）」',
    run: () => mcpEditCommand(),
    replies: [mcpGet(), { status: 409, body: {} }],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/save-400',
    covers: '送ったら 400 + { error }: 前の登録が残っていると添えて失敗。下書きは残す',
    run: () => mcpEditCommand(),
    replies: [mcpGet(), { status: 400, body: { error: '形が不正（pin 用）' } }],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/save-500',
    covers: '送ったら 500 + { error }: そのまま失敗。下書きは残す',
    run: () => mcpEditCommand(),
    replies: [mcpGet(), { status: 500, body: { error: 'boom' } }],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/save-500-no-error',
    covers: '送ったら 500 で本文に error が無い: 状態コードだけの失敗',
    run: () => mcpEditCommand(),
    replies: [mcpGet(), { status: 500, body: {} }],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/read-500',
    covers: '読み出しが 500: エディタを起こさず失敗',
    run: () => mcpEditCommand(),
    replies: [{ status: 500, body: { error: '登録が読めない（pin 用）' } }],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/read-403',
    covers: '読み出しが 403（判別できない）: エディタを起こさず失敗',
    run: () => mcpEditCommand(),
    replies: [{ status: 403, body: {} }],
    writes: MCP_EDITED,
  },
  {
    name: 'mcp/target-note',
    covers: '届け先の注記がある（未ログイン）: 通信もエディタも起こさず、注記を投げる',
    run: () => mcpEditCommand(),
    replies: [],
    writes: MCP_EDITED,
    note: '未ログイン（pin 用の注記）',
  },
  // ---- profile ----
  {
    name: 'profile/unchanged-existing',
    covers: '在る行を開いて何も変えずに閉じる: 送らずに「変更はありません」',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)])],
  },
  {
    name: 'profile/changed-existing',
    covers:
      '行を書き換える: 読んだ行の版を ifMatch に付けた PUT。更新の報告（合成後の指紋・クローン・runner）',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)]), profilePut()],
    writes: EDITED,
  },
  {
    name: 'profile/changed-named-with-scope',
    covers:
      '名前つきの行を --scope runner つきで書き換える: PUT の本文に scope が入る。撒く先の報告',
    run: () => profileEditCommand('work', { scope: 'runner' }),
    replies: [
      profileGet([row('work', SCRIPT, 'all', 'v-work')]),
      profilePut('work', { entries: [row('work', EDITED, 'runner', 'v-new')] }),
    ],
    writes: EDITED,
  },
  {
    name: 'profile/scope-only-change',
    covers: '本文は同じで --scope だけ変わった: 更新である（変更なしにしない）。PUT する',
    run: () => profileEditCommand('work', { scope: 'app' }),
    replies: [profileGet([row('work', SCRIPT, 'all', 'v-work')]), profilePut('work')],
  },
  {
    name: 'profile/scope-same-unchanged',
    covers: '--scope が今と同じで本文も同じ: 変更なし',
    run: () => profileEditCommand('work', { scope: 'all' }),
    replies: [profileGet([row('work', SCRIPT, 'all', 'v-work')])],
  },
  {
    name: 'profile/new-created',
    covers: '無い行を新しく書く: ifMatch: null の PUT',
    run: () => profileEditCommand('fresh', {}),
    replies: [profileGet([]), profilePut('fresh')],
    writes: EDITED,
  },
  {
    name: 'profile/new-template-closed',
    covers: '無い行を雛形のまま閉じる: 送らずに「変更はありません」',
    run: () => profileEditCommand('fresh', {}),
    replies: [profileGet([])],
  },
  {
    name: 'profile/emptied',
    covers: '本文を空にして閉じる: 送らずに断り（外すなら rm と案内）、下書きを残す',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)])],
    writes: '',
  },
  {
    name: 'profile/whitespace-only',
    covers: '本文を空白だけにして閉じる: 空と同じ扱い',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)])],
    writes: ' \n\t\n',
  },
  {
    name: 'profile/new-emptied',
    covers: '無い行の雛形を空にして閉じる: 断る',
    run: () => profileEditCommand('fresh', {}),
    replies: [profileGet([])],
    writes: '',
  },
  {
    name: 'profile/changed-partial-push-failure',
    covers: '送れたが一部の runner へ反映できない: 警告と理由を出した上で失敗にする',
    run: () => profileEditCommand(undefined, {}),
    replies: [
      profileGet([row('default', SCRIPT)]),
      profilePut('default', {
        runners: [
          {
            runnerId: 'runner-a',
            ok: false,
            error: '評価に落ちた（pin 用）',
            output: 'line 1\nline 2',
          },
        ],
      }),
    ],
    writes: EDITED,
  },
  {
    name: 'profile/editor-exit-after-edit',
    covers:
      '書き換えた後にエディタが非0で終わる: 送らず、下書きを残し、打ち直しのコマンドを案内（--scope つき）',
    run: () => profileEditCommand('work', { scope: 'runner' }),
    replies: [profileGet([row('work', SCRIPT, 'all', 'v-work')])],
    writes: EDITED,
    exit: 3,
  },
  {
    name: 'profile/editor-exit-unchanged',
    covers: '何も変えずにエディタが非0で終わる: 失敗にするが、下書きは残さず消す',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)])],
    exit: 3,
  },
  {
    name: 'profile/editor-missing',
    covers: 'エディタのコマンドが無い（127）: 案内つきの失敗',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)])],
    editor: 'alteroid-no-such-editor-pin',
  },
  {
    name: 'profile/conflict-409',
    covers: '送ったら 409（行がほかで変わった）: 固定の文で案内して失敗。下書きは残す',
    run: () => profileEditCommand(undefined, {}),
    replies: [
      profileGet([row('default', SCRIPT)]),
      { status: 409, body: { error: '変わっています' } },
    ],
    writes: EDITED,
  },
  {
    name: 'profile/save-400-with-detail',
    covers:
      '送ったら 400 + { error, detail }: 伏せて切った error と detail を並べて失敗。下書きは残す',
    run: () => profileEditCommand(undefined, {}),
    replies: [
      profileGet([row('default', SCRIPT)]),
      { status: 400, body: { error: '評価に落ちた（pin 用）', detail: 'line 1: syntax error' } },
    ],
    writes: EDITED,
  },
  {
    name: 'profile/save-500-no-error',
    covers: '送ったら 500 で error が無い: 「<path> が失敗しました (500)」',
    run: () => profileEditCommand(undefined, {}),
    replies: [profileGet([row('default', SCRIPT)]), { status: 500, body: {} }],
    writes: EDITED,
  },
  {
    name: 'profile/read-500',
    covers: '読み出しが 500: エディタを起こさず失敗',
    run: () => profileEditCommand(undefined, {}),
    replies: [{ status: 500, body: { error: 'プロファイルが読めない（pin 用）' } }],
    writes: EDITED,
  },
  {
    name: 'profile/invalid-name',
    covers: '行の名前の形が不正: 通信もエディタも起こさず失敗',
    run: () => profileEditCommand('bad name!', {}),
    replies: [],
    writes: EDITED,
  },
  {
    name: 'profile/invalid-scope',
    covers: '--scope が不正: 通信もエディタも起こさず失敗',
    run: () => profileEditCommand('work', { scope: 'everywhere' }),
    replies: [],
    writes: EDITED,
  },
  {
    name: 'profile/target-note',
    covers: '届け先の注記がある（未ログイン）: 通信もエディタも起こさず、注記を投げる',
    run: () => profileEditCommand(undefined, {}),
    replies: [],
    writes: EDITED,
    note: '未ログイン（pin 用の注記）',
  },
];

const ALL_KEYS = SCENARIOS.map((scenario) => scenario.name);

interface Pinned {
  stdout: string;
  stderr: string;
  requests: { method: string; url: string; body: unknown }[];
  editor: { launched: boolean; argc?: string; file?: string; mode?: string; initial?: string };
  out: unknown;
  drafts: { path: string; mode: string; content: string }[];
}

interface PinFile {
  counts: Record<string, number>;
  scenarios: Record<string, Pinned>;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function runScenario(scenario: Scenario): Promise<Pinned> {
  const root = await makeTempDir('alteroid-edit-pin-');
  // 空白入りの TMPDIR: 案内のコマンドの引用も固定値に写る
  const tmp = join(root, 'tmp dir');
  await mkdir(tmp);
  const logs = join(root, 'logs');
  await mkdir(logs);
  const script = join(root, 'editor.sh');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      `printf '%s' "$#" > '${logs}/argc'`,
      `printf '%s' "$1" > '${logs}/file'`,
      `stat -c %a "$1" > '${logs}/mode'`,
      `cat "$1" > '${logs}/initial'`,
      scenario.writes === undefined ? '' : `cat '${root}/new' > "$1"`,
      `exit ${String(scenario.exit ?? 0)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  if (scenario.writes !== undefined) await writeFile(join(root, 'new'), scenario.writes, 'utf8');

  const norm = (text: string): string =>
    text
      .replaceAll(tmp, '<TMPDIR>')
      .replaceAll(root, '<ROOT>')
      .replace(/alteroid-(mcp|profile)-[A-Za-z0-9]{6}/g, 'alteroid-$1-<RAND>');

  const requests: Pinned['requests'] = [];
  const replies = [...scenario.replies];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    requests.push({
      method: init?.method ?? request.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  const saved = {
    EDITOR: process.env.EDITOR,
    VISUAL: process.env.VISUAL,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.TMPDIR = tmp;
  delete process.env.VISUAL;
  process.env.EDITOR = scenario.editor ?? `sh '${script}'`;
  state.note = scenario.note ?? null;
  const readOut = captureStdout();
  const readErr = captureStderr();

  let out: unknown;
  try {
    await scenario.run();
    out = { returned: true, exitCode: 0 };
  } catch (error) {
    const message = norm(error instanceof Error ? error.message : String(error));
    out = {
      returned: false,
      exitCode: 1,
      name: error instanceof Error ? error.name : typeof error,
      message,
      // 場所の乱数を置き換えた後の文で作る: 伏せ字が乱数の場所の綴りに引きずられて、回ごとに変わらないように
      failureLine: `alteroid: ${describeCliFailure(new Error(message))}`,
    };
  } finally {
    globalThis.fetch = originalFetch;
    state.note = null;
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }

  const readLog = async (name: string): Promise<string | undefined> =>
    readFile(join(logs, name), 'utf8').catch(() => undefined);
  const argc = await readLog('argc');
  const file = await readLog('file');
  const mode = await readLog('mode');
  const initial = await readLog('initial');
  const drafts = await Promise.all(
    (await walk(tmp)).map(async (path) => ({
      path: norm(relative(tmp, path)),
      mode: ((await stat(path)).mode & 0o777).toString(8),
      content: norm(await readFile(path, 'utf8')),
    })),
  );
  const result: Pinned = {
    stdout: norm(readOut()),
    stderr: norm(readErr()),
    requests,
    editor:
      argc === undefined
        ? { launched: false }
        : {
            launched: true,
            argc,
            file: norm(file ?? ''),
            mode: (mode ?? '').trim(),
            initial: norm(initial ?? ''),
          },
    out,
    drafts,
  };
  await rm(root, { recursive: true, force: true });
  return result;
}

async function runAll(): Promise<Record<string, Pinned>> {
  const out: Record<string, Pinned> = {};
  for (const scenario of SCENARIOS) out[scenario.name] = await runScenario(scenario);
  return out;
}

describe('mcp edit と profile edit の出力・呼びの並び・mode・下書きの固定（場面ごと）', () => {
  let actual: Record<string, Pinned> = {};
  let pinned: PinFile = { counts: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        counts: Object.fromEntries(
          ALL_KEYS.map((key) => [key, actual[key]?.requests.length ?? -1]),
        ),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 120_000);

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    expect(
      ALL_KEYS.filter(
        (key) => (actual[key]?.stdout ?? '') !== '' || (actual[key]?.stderr ?? '') !== '',
      ).length,
      '出力を持つ場面が無い',
    ).toBeGreaterThan(10);
  });

  it('エディタに開かせた一時ファイルは 0600 である（鍵が入りうるので絞る）', () => {
    const launched = ALL_KEYS.filter((key) => actual[key]?.editor.launched === true);
    expect(launched.length).toBeGreaterThan(10);
    for (const key of launched) expect(actual[key]?.editor.mode, key).toBe('600');
    for (const key of ALL_KEYS) {
      for (const draft of actual[key]?.drafts ?? [])
        expect(draft.mode, `${key} ${draft.path}`).toBe('600');
    }
  });

  it('場面ごとの要求の数の一覧が固定値と同じ', () => {
    const counts = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.requests.length ?? -1]),
    );
    expect(counts).toEqual(pinned.counts);
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    const key = scenario.name;

    it(`返り値・失敗の形が固定値と同じ（${scenario.covers}）`, () => {
      expect(pinned.scenarios[key], `${key} が固定値に無い`).toBeDefined();
      expect(actual[key]?.out, `場面 ${key} の返り値が固定値からずれた`).toEqual(
        pinned.scenarios[key]?.out,
      );
    });

    it('標準出力・標準エラー出力の全文が固定値と同じ', () => {
      expect(actual[key]?.stdout, `場面 ${key} の stdout が変わった`).toEqual(
        pinned.scenarios[key]?.stdout,
      );
      expect(actual[key]?.stderr, `場面 ${key} の stderr が変わった`).toEqual(
        pinned.scenarios[key]?.stderr,
      );
    });

    it('デーモンへの要求の並びとエディタの起こし方が固定値と同じ', () => {
      expect(actual[key]?.requests, `場面 ${key} の要求の並びが変わった`).toEqual(
        pinned.scenarios[key]?.requests,
      );
      expect(actual[key]?.editor, `場面 ${key} のエディタの起こし方が変わった`).toEqual(
        pinned.scenarios[key]?.editor,
      );
    });

    it('終了後に残った下書きが固定値と同じ', () => {
      expect(actual[key]?.drafts, `場面 ${key} の下書きの残り方が変わった`).toEqual(
        pinned.scenarios[key]?.drafts,
      );
    });
  });

  it('同じ入力で2回回すと、全場面で同じ記録になる（乱数の置き換え漏れが無い）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に本物らしい値と絶対パスが無い。値は作りものだけ', () => {
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toMatch(/\/tmp\/|\/home\//);
  });
});
