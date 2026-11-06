import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { describeCliFailure } from './failure-message.js';
import { captureStderr, captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
}));

const { memoryEditCommand } = await import('./memory.js');
const { practiceEditCommand } = await import('./practice.js');

// `memory edit` と `practice edit` の振る舞いを、場面ごとにコミットした固定値（edit-skeleton-pin.json）と丸ごと比べる。
// 2つの edit は「一時ファイルに書く → エディタで開く → 読み直す → 変わっていなければ何もしない → デーモンへ送る →
// 版違いなら下書きを残して案内する」という同じ骨格を別々に持っているので、骨格を1つにまとめるとき、
// 画面に出る文言・デーモンへの呼びの並び・エディタの起こし方・下書きの残り方・失敗の形が1文字も変わらないことを確かめる歯。
//
// 記録するもの（場面ごと）:
//   - stdout / stderr: 出力の全文（一時ディレクトリの場所と乱数だけを置き換える）
//   - requests: デーモンへ出した要求の並び（メソッド・URL・本文。本文は JSON として読んだもの）
//   - editor: エディタの起こし方（引数の数・開いたときのファイルの中身・ファイル名）
//   - out: 返ったか投げたか（投げた文言の全文・`alteroid: …` の失敗行・終了コード）
//   - drafts: 終了後に一時ディレクトリへ残ったファイル（相対パスと中身）。消えていれば空
//
// 固定値の作り直し（意図して振る舞いを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_EDIT_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/cli exec vitest run src/edit-skeleton-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write apps/cli/src/edit-skeleton-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の何が動いたかを読む。

const PIN_URL = new URL('./edit-skeleton-pin.json', import.meta.url);
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
}

const memDoc = (content: string, version = 'v-read'): Reply => ({
  status: 200,
  body: { document: { slug: 'values', content }, version },
});
const notFound: Reply = { status: 404, body: { error: 'not found' } };

const practiceBody = (over: Record<string, unknown> = {}, version?: string): Reply => ({
  status: 200,
  body: {
    practice: {
      slug: 'review',
      kind: 'レビュー',
      title: 'レビューの進め方',
      content: '# レビュー\n\n差分より先に Issue を読む。\n',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      chars: 30,
      ...over,
    },
    ...(version === undefined ? {} : { version }),
  },
});

const EDITED = '人間の編集\n';

const SCENARIOS: Scenario[] = [
  // ---- memory ----
  {
    name: 'memory/unchanged-existing',
    covers: '在る記憶を開いて何も変えずに閉じる: 書かずに「変更はありません」。下書きは消える',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n')],
  },
  {
    name: 'memory/changed-existing',
    covers: '在る記憶を書き換える: 読んだ版を ifMatch に付けた PUT。下書きは消える',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n'), { status: 200, body: {} }],
    writes: EDITED,
  },
  {
    name: 'memory/new-created',
    covers: '無い記憶を新しく書く: 読んだ時には無かったので ifMatch: null の PUT',
    run: () => memoryEditCommand('fresh'),
    replies: [notFound, { status: 200, body: {} }],
    writes: EDITED,
  },
  {
    name: 'memory/new-template-closed',
    covers: '無い記憶を雛形のまま閉じる: 書かずに「変更はありません」',
    run: () => memoryEditCommand('fresh'),
    replies: [notFound],
  },
  {
    name: 'memory/new-emptied',
    covers: '無い記憶の雛形を空にして閉じる: 書かずに断り、下書きを残して set --allow-empty を案内',
    run: () => memoryEditCommand('fresh'),
    replies: [notFound],
    writes: '',
  },
  {
    name: 'memory/emptied',
    covers: '在る記憶を空にして閉じる: 書かずに断り、下書きを残す',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n')],
    writes: '',
  },
  {
    name: 'memory/whitespace-only',
    covers: '在る記憶を空白だけにして閉じる: 空と同じ扱い',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n')],
    writes: ' \n\t\n',
  },
  {
    name: 'memory/editor-exit-after-edit',
    covers: '書き換えた後にエディタが非0で終わる: 送らず、下書きを残し、打ち直しのコマンドを案内',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n')],
    writes: EDITED,
    exit: 3,
  },
  {
    name: 'memory/editor-exit-unchanged',
    covers: '何も変えずにエディタが非0で終わる: 失敗にするが、下書きは残さず消す',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n')],
    exit: 3,
  },
  {
    name: 'memory/editor-missing',
    covers: 'エディタのコマンドが無い（127）: EDITOR / VISUAL と set --file を案内する失敗',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n')],
    editor: 'alteroid-no-such-editor-pin',
  },
  {
    name: 'memory/conflict-409',
    covers:
      '送ったら 409（読んだ後に変わっていた）: 下書きといまの記憶の両方を残し、diff と次の手を案内して失敗',
    run: () => memoryEditCommand('values'),
    replies: [
      memDoc('# 価値観\n'),
      {
        status: 409,
        body: {
          error: '変わっています',
          current: {
            document: { slug: 'values', content: '# 価値観\n\nクローンの判断\n' },
            version: 'v-now',
          },
        },
      },
    ],
    writes: EDITED,
  },
  {
    name: 'memory/conflict-409-current-null',
    covers: '409 で current が null（読んだ後に消された）: いまの記憶のファイルは作らない',
    run: () => memoryEditCommand('values'),
    replies: [
      memDoc('# 価値観\n'),
      { status: 409, body: { error: '変わっています', current: null } },
    ],
    writes: EDITED,
  },
  {
    name: 'memory/save-500',
    covers: '送ったら 500: 下書きを残し、場所と set --file を案内して失敗',
    run: () => memoryEditCommand('values'),
    replies: [memDoc('# 価値観\n'), { status: 500, body: { error: 'boom' } }],
    writes: EDITED,
  },
  {
    name: 'memory/read-500',
    covers: '読み出しが 500: エディタを起こさず、PUT もせず失敗',
    run: () => memoryEditCommand('values'),
    replies: [{ status: 500, body: { error: '記憶が読めない（pin 用）' } }],
    writes: EDITED,
  },
  {
    name: 'memory/invalid-slug',
    covers: '名前が不正（`../` で外へ出る）: 通信もエディタも起こさず失敗',
    run: () => memoryEditCommand('../../outside'),
    replies: [],
    writes: EDITED,
  },
  // ---- practice ----
  {
    name: 'practice/unchanged-existing',
    covers: '在るやり方を開いて何も変えずに閉じる: 書かずに「変更はありません」',
    run: () => practiceEditCommand('review', {}),
    replies: [practiceBody({}, 'v-read')],
  },
  {
    name: 'practice/changed-existing',
    covers: '本文を書き換える: 種類と題は引き継ぎ、読んだ版を ifMatch に付けた PUT',
    run: () => practiceEditCommand('review', {}),
    replies: [practiceBody({}, 'v-read'), { status: 200, body: {} }],
    writes: EDITED,
  },
  {
    name: 'practice/title-only-changed',
    covers: '本文は同じで --title だけ変わった: PUT する（変更なしにしない）',
    run: () => practiceEditCommand('review', { title: '別の題' }),
    replies: [practiceBody({}, 'v-read'), { status: 200, body: {} }],
  },
  {
    name: 'practice/kind-and-title-same-as-current',
    covers:
      '--kind / --title を今の値と同じに指定して本文も同じ: 変更なし（打ち直しの案内に --kind / --title を足さない）',
    run: () => practiceEditCommand('review', { kind: 'レビュー', title: 'レビューの進め方' }),
    replies: [practiceBody({}, 'v-read')],
  },
  {
    name: 'practice/new-created',
    covers: '無いやり方を --kind / --title つきで新しく書く: ifMatch: null の PUT',
    run: () => practiceEditCommand('fresh', { kind: '調査', title: '調べもの' }),
    replies: [notFound, { status: 200, body: {} }],
    writes: EDITED,
  },
  {
    name: 'practice/new-template-closed',
    covers: '無いやり方を雛形のまま閉じる: 書かずに「変更はありません」',
    run: () => practiceEditCommand('fresh', { kind: '調査', title: '調べ方' }),
    replies: [notFound],
  },
  {
    name: 'practice/new-missing-kind-title',
    covers: '無いやり方で --kind / --title が欠けている: エディタも PUT も起こさず失敗',
    run: () => practiceEditCommand('fresh', { kind: '調査' }),
    replies: [notFound],
    writes: EDITED,
  },
  {
    name: 'practice/emptied',
    covers:
      '本文を空にして閉じる: 書かずに断り、下書きを残し、set --allow-empty を案内（打ち直しの形に --kind / --title 付き）',
    run: () => practiceEditCommand('review', { title: '別の題' }),
    replies: [practiceBody({}, 'v-read')],
    writes: '',
  },
  {
    name: 'practice/editor-exit-after-edit',
    covers: '書き換えた後にエディタが非0で終わる: 送らず、下書きを残し、打ち直しのコマンドを案内',
    run: () => practiceEditCommand('review', {}),
    replies: [practiceBody({}, 'v-read')],
    writes: EDITED,
    exit: 3,
  },
  {
    name: 'practice/editor-exit-unchanged',
    covers: '何も変えずにエディタが非0で終わる: 失敗にするが、下書きは残さず消す',
    run: () => practiceEditCommand('review', {}),
    replies: [practiceBody({}, 'v-read')],
    exit: 3,
  },
  {
    name: 'practice/editor-missing',
    covers: 'エディタのコマンドが無い（127）: 案内つきの失敗',
    run: () => practiceEditCommand('review', {}),
    replies: [practiceBody({}, 'v-read')],
    editor: 'alteroid-no-such-editor-pin',
  },
  {
    name: 'practice/conflict-409',
    covers: '送ったら 409: 下書きといまのやり方の両方を残し、diff と次の手を案内して失敗',
    run: () => practiceEditCommand('review', {}),
    replies: [
      practiceBody({}, 'v-read'),
      {
        status: 409,
        body: {
          error: '変わっています',
          current: {
            practice: {
              slug: 'review',
              kind: 'レビュー',
              title: 'レビューの進め方',
              content: 'クローンの書き直し\n',
            },
            version: 'v-now',
          },
        },
      },
    ],
    writes: EDITED,
  },
  {
    name: 'practice/conflict-409-current-null',
    covers: '409 で current が null: いまのやり方のファイルは作らない',
    run: () => practiceEditCommand('review', {}),
    replies: [
      practiceBody({}, 'v-read'),
      { status: 409, body: { error: '変わっています', current: null } },
    ],
    writes: EDITED,
  },
  {
    name: 'practice/save-500',
    covers: '送ったら 500: 下書きを残し、場所と set --file を案内して失敗',
    run: () => practiceEditCommand('review', {}),
    replies: [practiceBody({}, 'v-read'), { status: 500, body: { error: 'boom' } }],
    writes: EDITED,
  },
  {
    name: 'practice/read-500',
    covers: '読み出しが 500: エディタを起こさず失敗',
    run: () => practiceEditCommand('review', {}),
    replies: [{ status: 500, body: { error: 'やり方が読めない（pin 用）' } }],
    writes: EDITED,
  },
  {
    name: 'practice/invalid-slug',
    covers: '名前が不正: 通信もエディタも起こさず失敗',
    run: () => practiceEditCommand('../../outside', { kind: '調査', title: '題' }),
    replies: [],
    writes: EDITED,
  },
  {
    name: 'practice/unreadable-with-kind-title',
    covers:
      '読めない形で入っている行（GET が 409）を --kind / --title つきで書き直す: 雛形から編集し、版なし（ifMatch の鍵ごと無し）で PUT',
    run: () => practiceEditCommand('broken', { kind: '調査', title: '調べもの' }),
    replies: [
      { status: 409, body: { error: '読めない形で入っている' } },
      { status: 200, body: {} },
    ],
    writes: EDITED,
  },
  {
    name: 'practice/unreadable-missing-kind-title',
    covers: '読めない形の行で --kind / --title が欠けている: エディタも PUT も起こさず失敗',
    run: () => practiceEditCommand('broken', {}),
    replies: [{ status: 409, body: { error: '読めない形で入っている' } }],
    writes: EDITED,
  },
];

const ALL_KEYS = SCENARIOS.map((scenario) => scenario.name);

interface Pinned {
  stdout: string;
  stderr: string;
  requests: { method: string; url: string; body: unknown }[];
  editor: { launched: boolean; argc?: string; file?: string; initial?: string };
  out: unknown;
  drafts: { path: string; content: string }[];
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
      .replace(/alteroid-(memory|practice)-[A-Za-z0-9]{6}/g, 'alteroid-$1-<RAND>');

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
  const readOut = captureStdout();
  const readErr = captureStderr();

  let out: unknown;
  try {
    await scenario.run();
    out = { returned: true, exitCode: 0 };
  } catch (error) {
    out = {
      returned: false,
      exitCode: 1,
      name: error instanceof Error ? error.name : typeof error,
      message: norm(error instanceof Error ? error.message : String(error)),
      // 場所の乱数を置き換えた後の文で作る: 伏せ字が乱数の場所の綴りに引きずられて、回ごとに変わらないように
      failureLine: `alteroid: ${describeCliFailure(new Error(norm(error instanceof Error ? error.message : String(error))))}`,
    };
  } finally {
    globalThis.fetch = originalFetch;
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
  const initial = await readLog('initial');
  const drafts = await Promise.all(
    (await walk(tmp)).map(async (path) => ({
      path: norm(relative(tmp, path)),
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

describe('memory edit と practice edit の出力・呼びの並び・下書きの固定（場面ごと）', () => {
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
