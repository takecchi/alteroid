import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GROUNDS_NOT_DELIVERED } from './clone-tools-journal.js';
import { setStderrSinkForTesting } from './dropped-record.js';
import type { Task } from './schema.js';
import { UnreadableTaskError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `journal_write` の出力（全文と字数）と、呼んだあとの状態（日誌へ足された行・`closes` で閉じた task の行・握った書き損じの跡）・呼びの並び
// （`journal.append`・`tasks.get`・`tasks.setStatus`）を、場面ごとにコミットした固定値（clone-tools-journal-write-output-pin.json）と丸ごと比べる。
// `clone-tools-journal.ts` の `tool('journal_write', …)`（`closes` の検査 → grounds が無ければ跡を残す → 日誌を先に書く → `finishWithCloses` で `closes` の task を
// done にして応答を組む）と、`clone-tools-closes.ts` の `closeTaskBody` / `finishWithCloses` を直す前の歯。固定値の側で値を伏せず、入力（時計・id・task）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・対象・id・at をそのまま。書けなかった行は含まない）
//   - tasks: 呼んだあとの task の全行（`closes` で閉じた行の状態を含む）
//   - dropped: 握った書き損じ・grounds が届かなかった跡（stderr。`noteDroppedRecord`。本文は含まない）
//   - calls: 呼びの並び（`journal.append` の行と成否・`tasks.get`・`tasks.setStatus` の引数と結果）
//   - wrote: 呼ぶ前から変わったもの。none（日誌も task も同じ）/ journal（日誌だけ）/ task-and-journal（task が閉じた。日誌も足される）/ task（task だけ閉じた。日誌が書けなかった）
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_JOURNAL_WRITE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-journal-write-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-journal-write-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、日誌・task・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。task は場面の頭に固定の時刻で積み、呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 作り方の注記:
//   - 読めない task・ストアの失敗・競り合い（`setStatus` が not-found / unchanged / rejected を返す）は、`tasks.get` / `tasks.setStatus` の口（hooks）で起こす
//   - 閉じる側の日誌（「task_set_status」の行）が書けない場面は、`journalFailsAt` の 2 回目（呼びの中の 1 行目は本文の行）
//
// 秘密: 値は作りものだけ。この道具は decision・grounds を日誌へ伏せずに書く（`noteDroppedRecord` が残す跡には本文は含まれない）ので、作りものの値が入る場面は
// 日誌へそのまま入ることをいまの振る舞いとして固定する（json にはその作りものの値が残る。本物ではない）。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い文字列は 5 字ごと（既定の語なら 10 字ごと）に空白を挟む（`spaced`）。
//
// 作れない分岐: 無い（`closes` の検査・grounds の有無・日誌の失敗・閉じる側の失敗・競り合いは口で作った）。

type Args = Record<string, unknown>;

type Writes = 'none' | 'journal' | 'task-and-journal' | 'task';

type Failure = 'unreadable' | 'plain';

interface SeedTask {
  id: string;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
}

interface Hooks {
  /** `journal.append` の何回目（呼びの中・1 から）を投げさせるか */
  journalFailsAt: number[];
  /** `tasks.get` が id ごとに落ちる */
  getFails: Record<string, Failure>;
  /** `tasks.setStatus` が id ごとに落ちる */
  setFails: Record<string, Failure>;
  /** `tasks.setStatus` が（実際には書かずに）この結果を返す */
  setReturns: Record<string, 'not-found' | 'unchanged' | 'rejected'>;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Hooks>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedTask[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const SEED_ISO = '2026-10-01T00:00:00.000Z';
const SEED_CLOSED_ISO = '2026-10-02T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-journal-write-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_JOURNAL_WRITE_PIN === '1';

/** 作りものの値（本物ではない）。decision・grounds へ入れて、日誌へ伏せずに入ることをいまのまま固定する */
const FAKE_VALUE = 'FAKE_NOT_A_REAL_VALUE_0123456789';

function callTime(index: number): number {
  return BASE_MS + (index + 1) * 60_000;
}

/** 長さ len の、「語＋空白」を繰り返した文字列（空白の間隔は語の長さ＋1 字。既定の語は 9 字で 10 字ごと、`'long'` は 5 字ごと。末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

const w = (args: Args, writes: Writes, hooks?: Partial<Hooks>): Step => ({
  args,
  writes,
  ...(hooks === undefined ? {} : { hooks }),
});

const j = (extra: Args = {}): Args => ({
  decision: '週次の見直しを始める',
  grounds: '記憶の方針',
  ...extra,
});

const OPEN: SeedTask[] = [
  { id: 'q-1' },
  { id: 'w-1', status: 'waiting' },
  { id: 'n-1', status: 'needs_decision' },
];

const SCENARIOS: Scenario[] = [
  // ---- grounds ----
  {
    name: 'grounds',
    covers:
      'grounds の3通り: あり（そのまま日誌へ）・省略（日誌の grounds は GROUNDS_NOT_DELIVERED。応答に ⚠ の注意。stderr に跡が1つ）・「根拠なし」と書いた（そのまま「根拠なし」。注意も跡も無い）。3つの日誌の grounds が互いに違う',
    seed: [],
    steps: [
      w(j(), 'journal'),
      w({ decision: '週次の見直しを始める' }, 'journal'),
      w(j({ grounds: '根拠なし' }), 'journal'),
    ],
  },
  {
    name: 'grounds-empty-and-null',
    covers:
      'grounds が空文字・空白だけ・undefined を明示: 空文字と空白はそのまま日誌へ（届いた扱い。注意も跡も無い）。undefined は省略と同じ',
    seed: [],
    steps: [
      w(j({ grounds: '' }), 'journal'),
      w(j({ grounds: '   ' }), 'journal'),
      w(j({ grounds: undefined }), 'journal'),
    ],
  },
  // ---- decision・grounds の形 ----
  {
    name: 'decision-forms',
    covers:
      'decision の形: 長い（3,000 字）・改行を含む・多バイトと絵文字・1 字・空文字・空白だけ・前後の空白。切らずにそのまま日誌へ入る。省略時の跡の `decision.chars=` は decision の長さ（UTF-16）',
    seed: [],
    steps: [
      w(j({ decision: spaced(3_000, 'long') }), 'journal'),
      w(j({ decision: '一行目\n二行目\n\n四行目' }), 'journal'),
      w(j({ decision: '日本語😀の判断 é' }), 'journal'),
      w(j({ decision: 'あ' }), 'journal'),
      w(j({ decision: '' }), 'journal'),
      w(j({ decision: '   ' }), 'journal'),
      w(j({ decision: '  前後に空白  ' }), 'journal'),
      w({ decision: '日本語😀の判断 é' }, 'journal'),
      w({ decision: spaced(3_000, 'long') }, 'journal'),
    ],
  },
  {
    name: 'grounds-forms',
    covers:
      'grounds の形: 長い（3,000 字）・改行を含む・多バイトと絵文字・1 字。そのまま日誌へ入る',
    seed: [],
    steps: [
      w(j({ grounds: spaced(3_000, 'long') }), 'journal'),
      w(j({ grounds: '一行目\n二行目' }), 'journal'),
      w(j({ grounds: '日本語😀の根拠 é' }), 'journal'),
      w(j({ grounds: 'あ' }), 'journal'),
    ],
  },
  {
    name: 'value-in-text',
    covers:
      'decision・grounds に作りものの値が入る（いまの振る舞いのまま固定）: 日誌へ伏せずにそのまま入る。応答には出ない。grounds を省いた回の stderr の跡は本文を含まない',
    seed: [],
    steps: [
      w(
        j({ decision: `export TOKEN=${FAKE_VALUE} を設定した`, grounds: `id=${FAKE_VALUE}` }),
        'journal',
      ),
      w({ decision: `export TOKEN=${FAKE_VALUE} を設定した` }, 'journal'),
    ],
  },
  // ---- closes ----
  {
    name: 'closes-none',
    covers:
      '`closes` を渡さない・undefined・空配列: 応答は「日誌に記録した（id）。」だけで、task へ触れない（tasks への呼びが無い）。省略時は注意つき',
    seed: OPEN,
    steps: [
      w(j(), 'journal'),
      w(j({ closes: undefined }), 'journal'),
      w(j({ closes: [] }), 'journal'),
      w({ decision: '判断', closes: [] }, 'journal'),
    ],
  },
  {
    name: 'closes-open',
    covers:
      '`closes` で開いている task を閉じる（各状態 queued・waiting・needs_decision）: 本文の行のあとに「task_set_status」の行（grounds に「journal_write の closes」）。応答は本文の行＋「closes id: id を done にした。」。task は done になり閉じた理由が残る',
    seed: OPEN,
    steps: [
      w(j({ closes: [{ id: 'q-1', reason: 'もう済んだ' }] }), 'task-and-journal'),
      w(j({ closes: [{ id: 'w-1', reason: '返事が来た' }] }), 'task-and-journal'),
      w(j({ closes: [{ id: 'n-1', reason: '人間が決めた' }] }), 'task-and-journal'),
    ],
  },
  {
    name: 'closes-many',
    covers:
      '`closes` に複数（3・上限ちょうどの 5）: 渡した順に1件ずつ閉じ、結果が1行ずつ並ぶ。同じ id を2回渡すと2回目は「既に … に閉じてある」',
    seed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }],
    steps: [
      w(
        j({
          closes: [
            { id: 'a', reason: '理由 a' },
            { id: 'b', reason: '理由 b' },
            { id: 'c', reason: '理由 c' },
          ],
        }),
        'task-and-journal',
      ),
      w(
        j({
          closes: [
            { id: 'd', reason: '一回目' },
            { id: 'd', reason: '二回目' },
          ],
        }),
        'task-and-journal',
      ),
    ],
  },
  {
    name: 'closes-five',
    covers: '`closes` が上限ちょうどの 5 件（検査を通る）',
    seed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
    steps: [
      w(
        j({
          closes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, reason: `理由 ${id}` })),
        }),
        'task-and-journal',
      ),
    ],
  },
  {
    name: 'closes-states',
    covers:
      '`closes` の task の状態ごとの結果: 無い id（「task … は無い」）・既に閉じた行（done / cancelled。「既に … に閉じてある（理由）」）。どれも日誌の行は本文の1本だけで、閉じる側の行は足さない。応答の頭の行は日誌に記録した旨のまま',
    seed: [
      { id: 'closed-done', status: 'done' },
      { id: 'closed-cancelled', status: 'cancelled' },
      { id: 'open-one' },
    ],
    steps: [
      w(j({ closes: [{ id: 'ghost', reason: '無い' }] }), 'journal'),
      w(j({ closes: [{ id: 'closed-done', reason: '再び' }] }), 'journal'),
      w(j({ closes: [{ id: 'closed-cancelled', reason: '再び' }] }), 'journal'),
      w(
        j({
          closes: [
            { id: 'ghost', reason: '無い' },
            { id: 'open-one', reason: '閉じる' },
            { id: 'closed-done', reason: '再び' },
          ],
        }),
        'task-and-journal',
      ),
    ],
  },
  {
    name: 'closes-forms',
    covers:
      '`closes` の reason の形: 長い（3,000 字）・改行・多バイト・前後の空白は日誌の grounds へそのまま入る。id の形（NUL・空文字・長い）は「無い」',
    seed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    steps: [
      w(j({ closes: [{ id: 'a', reason: spaced(3_000, 'long') }] }), 'task-and-journal'),
      w(j({ closes: [{ id: 'b', reason: '一行目\n二行目' }] }), 'task-and-journal'),
      w(j({ closes: [{ id: 'c', reason: '日本語😀の理由 é' }] }), 'task-and-journal'),
      w(j({ closes: [{ id: 'd', reason: '  前後に空白  ' }] }), 'task-and-journal'),
      w(
        j({
          closes: [
            { id: '', reason: '空の id' },
            { id: 'a\u0000b', reason: 'NUL の id' },
            { id: 'x'.repeat(300), reason: '長い id' },
          ],
        }),
        'journal',
      ),
    ],
  },
  {
    name: 'closes-grounds-omitted',
    covers:
      'grounds を省き、かつ `closes` を渡す: 日誌の grounds は GROUNDS_NOT_DELIVERED・stderr に跡・応答は注意つきの頭の行のあとに closes の行。閉じる',
    seed: [{ id: 'a' }],
    steps: [w({ decision: '判断', closes: [{ id: 'a', reason: '済んだ' }] }, 'task-and-journal')],
  },
  // ---- closes の検査 ----
  {
    name: 'closes-violation',
    covers:
      '`closes` の検査の断り: 6 件（上限超え）・reason が空・空白だけ・N 件目の reason（添字が文言に出る）。「…何もしていない。」で、日誌も task も動かさない。grounds を省いていても跡を残さない（検査が先）',
    seed: [{ id: 'a' }],
    steps: [
      w(
        j({
          closes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, reason: '理由' })),
        }),
        'none',
      ),
      w(j({ closes: [{ id: 'a', reason: '' }] }), 'none'),
      w(j({ closes: [{ id: 'a', reason: '   ' }] }), 'none'),
      w(
        {
          decision: '判断',
          closes: [
            { id: 'a', reason: '良い' },
            { id: 'b', reason: '' },
          ],
        },
        'none',
      ),
      w({ decision: '判断', closes: [{ id: 'a', reason: '\n\t　' }] }, 'none'),
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails',
    covers:
      '日誌が書けない（本文の行）: 何も閉じず JournalNotRecordedError（act-not-performed）を投げる。握った跡が残る（grounds を省いた回は「届かなかった」の跡も）。`closes` の task は開いたまま。日誌が戻れば次の呼びは通る',
    seed: [{ id: 'a' }],
    steps: [
      w(j({ closes: [{ id: 'a', reason: '済んだ' }] }), 'none', { journalFailsAt: [1] }),
      w({ decision: '判断', closes: [{ id: 'a', reason: '済んだ' }] }, 'none', {
        journalFailsAt: [1],
      }),
      w(j(), 'none', { journalFailsAt: [1] }),
      w(j({ closes: [{ id: 'a', reason: '済んだ' }] }), 'task-and-journal'),
    ],
  },
  // ---- 閉じる所の失敗 ----
  {
    name: 'closes-failures',
    covers:
      '閉じる所の失敗（いまの振る舞いのまま）: 読めない task（get が UnreadableTaskError → 「読めない形で入っている…閉じていない」・isError ではない）・get が普通の Error で落ちる（「閉じる処理が失敗した（理由）」・isError・task は未処理）・setStatus が読めない／普通の Error で落ちる。本文の行は残り、応答の頭は日誌に記録した旨のまま',
    seed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    steps: [
      w(j({ closes: [{ id: 'a', reason: '済んだ' }] }), 'journal', {
        getFails: { a: 'unreadable' },
      }),
      w(j({ closes: [{ id: 'a', reason: '済んだ' }] }), 'journal', { getFails: { a: 'plain' } }),
      w(j({ closes: [{ id: 'b', reason: '済んだ' }] }), 'journal', {
        setFails: { b: 'unreadable' },
      }),
      w(j({ closes: [{ id: 'b', reason: '済んだ' }] }), 'journal', { setFails: { b: 'plain' } }),
      w(
        j({
          closes: [
            { id: 'c', reason: '成功' },
            { id: 'd', reason: '失敗' },
          ],
        }),
        'task-and-journal',
        { getFails: { d: 'plain' } },
      ),
    ],
  },
  {
    name: 'closes-races',
    covers:
      '確かめた直後に状態が変わっていた（setStatus が書かずに返す）: not-found（「確かめた直後に消えていた」）・unchanged（「既に done」）・rejected（「… から done へは移せない」）。日誌の行は本文の1本だけ',
    seed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    steps: [
      w(j({ closes: [{ id: 'a', reason: '済んだ' }] }), 'journal', {
        setReturns: { a: 'not-found' },
      }),
      w(j({ closes: [{ id: 'b', reason: '済んだ' }] }), 'journal', {
        setReturns: { b: 'unchanged' },
      }),
      w(j({ closes: [{ id: 'c', reason: '済んだ' }] }), 'journal', {
        setReturns: { c: 'rejected' },
      }),
    ],
  },
  {
    name: 'closes-journal-fails',
    covers:
      '閉じる側の日誌（task_set_status の行）が書けない（呼びの中の 2 回目）: task は done になっているのに応答は isError の「task は done にしている…日誌に残せていない」。本文の行は残る。別の id が成功した行はそのまま',
    seed: [{ id: 'a' }, { id: 'b' }],
    steps: [
      w(j({ closes: [{ id: 'a', reason: '済んだ' }] }), 'task-and-journal', {
        journalFailsAt: [2],
      }),
      w(
        j({
          closes: [
            { id: 'b', reason: '済んだ' },
            { id: 'ghost', reason: '無い' },
          ],
        }),
        'journal',
        { journalFailsAt: [2], setFails: { b: 'plain' } },
      ),
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

// ---- 記録の形 ----

interface PinnedOutput {
  length: number;
  text: string;
  isError: boolean;
  thrown: boolean;
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: Writes;
  tasks: Record<string, unknown>[];
  journal: Record<string, unknown>[];
  dropped: string[];
  calls: PinnedCall[];
}

interface PinFile {
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freshHooks(): Hooks {
  return { journalFailsAt: [], getFails: {}, setFails: {}, setReturns: {} };
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function failureOf(error: unknown): string {
  return `threw ${nameOf(error)}: ${error instanceof Error ? error.message : String(error)}`;
}

function countOf(calls: PinnedCall[], op: string): number {
  return calls.filter((entry) => entry.op === op).length;
}

interface Snapshot {
  tasks: Record<string, unknown>[];
  journal: Record<string, unknown>[];
}

async function snapshot(base: Stores): Promise<Snapshot> {
  const { entries } = await base.tasks.list({ includeClosed: true });
  return {
    tasks: plain(entries) as unknown as Record<string, unknown>[],
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[]): Stores {
  const tasks: Stores['tasks'] = {
    ...base.tasks,
    get: async (id) => {
      try {
        if (hooks.getFails[id] === 'unreadable')
          throw new UnreadableTaskError('読めない行（テスト用）');
        if (hooks.getFails[id] === 'plain') throw new Error('ストアが落ちた（get）');
        const found = await base.tasks.get(id);
        calls.push({
          op: 'tasks.get',
          args: { id },
          outcome: found === null ? 'null' : found.status,
        });
        return found;
      } catch (error) {
        calls.push({ op: 'tasks.get', args: { id }, outcome: failureOf(error) });
        throw error;
      }
    },
    setStatus: async (id, status, options) => {
      const args = plain({ id, status, options });
      try {
        if (hooks.setFails[id] === 'unreadable')
          throw new UnreadableTaskError('読めない行（テスト用）');
        if (hooks.setFails[id] === 'plain') throw new Error('ストアが落ちた（setStatus）');
        const faked = hooks.setReturns[id];
        if (faked !== undefined) {
          const current = await base.tasks.get(id);
          const result =
            faked === 'not-found'
              ? ({ kind: 'not-found' } as const)
              : faked === 'unchanged' && current !== null
                ? ({ kind: 'unchanged', task: current } as const)
                : ({ kind: 'rejected', from: 'done', to: 'done' } as const);
          calls.push({ op: 'tasks.setStatus', args, outcome: `${result.kind} (faked)` });
          return result;
        }
        const result = await base.tasks.setStatus(id, status, options);
        calls.push({ op: 'tasks.setStatus', args, outcome: result.kind });
        return result;
      } catch (error) {
        calls.push({ op: 'tasks.setStatus', args, outcome: failureOf(error) });
        throw error;
      }
    },
  };
  return {
    ...base,
    tasks,
    journal: {
      ...base.journal,
      append: async (entry) => {
        const args = plain(entry);
        if (hooks.journalFailsAt.includes(countOf(calls, 'journal.append') + 1)) {
          calls.push({ op: 'journal.append', args, outcome: 'threw Error: 日誌が落ちた' });
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(entry);
        calls.push({ op: 'journal.append', args, outcome: `ok ${written.id}` });
        return written;
      },
    },
  };
}

async function seedTasks(base: Stores, seed: readonly SeedTask[]): Promise<void> {
  for (const spec of seed) {
    const closing = spec.status === 'done' || spec.status === 'cancelled';
    const status = spec.status === undefined || closing ? 'queued' : spec.status;
    const task: Task = {
      id: spec.id,
      createdAt: SEED_ISO,
      updatedAt: SEED_ISO,
      status,
      origin: 'external',
      title: `仕事 ${spec.id}`,
      body: `本文 ${spec.id}`,
    };
    await base.tasks.add(task);
    if (closing && spec.status !== undefined) {
      await base.tasks.setStatus(spec.id, spec.status, {
        reason: '先に閉じた',
        by: 'human',
        at: SEED_CLOSED_ISO,
      });
    }
  }
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(SEED_ISO));
  await seedTasks(base, scenario.seed);
  const dropped: string[] = [];
  setStderrSinkForTesting((line) => {
    dropped.push(line);
  });
  const results: PinnedStep[] = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const hooks = { ...freshHooks(), ...(step.hooks ?? {}) };
      const calls: PinnedCall[] = [];
      dropped.length = 0;
      const found = createCloneTools({
        stores: withHooks(base, hooks, calls),
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      }).find((entry) => entry.name === 'journal_write');
      if (!found) throw new Error('journal_write が無い');

      const before = await snapshot(base);
      vi.setSystemTime(new Date(callTime(index)));
      let output: PinnedOutput;
      try {
        const result = await found.handler(step.args as never, {} as never);
        const text = (result.content ?? [])
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        output = {
          length: text.length,
          text,
          isError: result.isError === true,
          thrown: false,
          errorName: null,
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output = {
          length: text.length,
          text,
          isError: true,
          thrown: true,
          errorName: nameOf(error),
        };
      }
      const after = await snapshot(base);
      const taskChanged = JSON.stringify(before.tasks) !== JSON.stringify(after.tasks);
      const journalChanged = before.journal.length !== after.journal.length;
      const wrote: Writes = taskChanged
        ? journalChanged
          ? 'task-and-journal'
          : 'task'
        : journalChanged
          ? 'journal'
          : 'none';
      const key = stepKey(scenario, index);
      expect(wrote, `場面 ${key}: 書き込みの有無が宣言（${step.writes}）と違う`).toBe(step.writes);
      results.push({
        output,
        wrote,
        tasks: after.tasks,
        journal: after.journal.slice(before.journal.length),
        dropped: [...dropped],
        calls: plain(calls),
      });
    }
  } finally {
    setStderrSinkForTesting(null);
  }
  return results;
}

async function runAll(): Promise<Record<string, PinnedStep>> {
  const out: Record<string, PinnedStep> = {};
  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    for (const [index, result] of results.entries()) out[stepKey(scenario, index)] = result;
  }
  return out;
}

describe('journal_write の出力と呼んだあとの状態の固定（場面ごとの出力の全文・日誌の行・task・握った跡・呼びの並び）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 120_000);

  afterAll(() => {
    setStderrSinkForTesting(null);
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.output.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの出力の字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.output.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.output.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.output.length);
    }
  });

  it('書き込みの有無が、場面の宣言・固定値と同じ', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes);
        expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が宣言と違う`).toBe(
          step.writes,
        );
      }
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          {
            isError: got?.output.isError,
            thrown: got?.output.thrown,
            errorName: got?.output.errorName,
          },
          `場面 ${key} の出力の isError／例外で返ったか／例外の名前、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の呼んだあとの task が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.tasks, `場面 ${key} の task（closes で閉じた行を含む）が変わった`).toEqual(
          want?.tasks,
        );
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} の呼んだあとに日誌へ足された行と握った跡が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・本文・grounds・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
        expect(got?.dropped, `場面 ${key} の握った跡（stderr）が変わった`).toEqual(want?.dropped);
      });

      it(`${key} の呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び（引数・結果・失敗）が固定値からずれた`).toEqual(
          want?.calls,
        );
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・日誌・task・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に本物らしい値と絶対パスが無い。作りものの値は、decision・grounds の場面にだけ在る', () => {
    // 先頭が英字でない `sk-`（`task-and-journal` の `sk-` は数えない）
    expect(pinnedRaw).not.toMatch(/(^|[^A-Za-z])sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toContain('/tmp/');
    for (const key of ALL_KEYS) {
      if (key.startsWith('value-in-text')) continue;
      expect(
        JSON.stringify(actual[key]).includes(FAKE_VALUE),
        `場面 ${key} の記録に作りものの値が入っている`,
      ).toBe(false);
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const groundsOf = (key: string): string[] =>
      step(key).journal.map((entry) => String(entry.grounds));
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const WARN =
      '⚠ grounds が呼び出しに届かなかったので、根拠は「届かなかった」として残してある（あなたが「根拠なし」と書いた場合とは区別してある）。根拠が在るなら、もう一度 grounds 付きで呼べば別の行として残る。';

    // grounds の3通り
    expect(groundsOf('grounds#1')).toEqual(['記憶の方針']);
    expect(groundsOf('grounds#2')).toEqual([GROUNDS_NOT_DELIVERED]);
    expect(groundsOf('grounds#3')).toEqual(['根拠なし']);
    expect(
      new Set([groundsOf('grounds#1')[0], groundsOf('grounds#2')[0], groundsOf('grounds#3')[0]])
        .size,
    ).toBe(3);
    expect(text('grounds#1')).toBe('日誌に記録した（id-1）。');
    expect(text('grounds#2')).toBe(`日誌に記録した（id-2）。${WARN}`);
    expect(text('grounds#3')).toBe('日誌に記録した（id-3）。');
    expect(step('grounds#1').dropped).toEqual([]);
    expect(step('grounds#2').dropped).toHaveLength(1);
    expect(step('grounds#2').dropped[0]).toContain(
      '判断の根拠（journal_write の grounds）を記録できませんでした（decision.chars=10）',
    );
    expect(step('grounds#3').dropped).toEqual([]);
    expect(groundsOf('grounds-empty-and-null#1')).toEqual(['']);
    expect(groundsOf('grounds-empty-and-null#2')).toEqual(['   ']);
    expect(groundsOf('grounds-empty-and-null#3')).toEqual([GROUNDS_NOT_DELIVERED]);
    expect(step('grounds-empty-and-null#1').dropped).toEqual([]);

    // 形
    expect(String(step('decision-forms#1').journal[0]?.decision)).toHaveLength(3_000);
    expect(step('decision-forms#5').journal[0]?.decision).toBe('');
    expect(step('decision-forms#8').dropped[0]).toContain('decision.chars=');
    expect(groundsOf('grounds-forms#2')).toEqual(['一行目\n二行目']);
    expect(text('value-in-text#1')).not.toContain(FAKE_VALUE);
    expect(step('value-in-text#2').dropped.join('')).not.toContain(FAKE_VALUE);

    // closes
    for (const key of ['closes-none#1', 'closes-none#2', 'closes-none#3']) {
      expect(ops(key), key).toEqual(['journal.append']);
    }
    expect(text('closes-none#4')).toContain(WARN);
    expect(text('closes-open#1')).toContain('closes q-1: q-1 を done にした。');
    expect(step('closes-open#1').journal).toHaveLength(2);
    expect(String(step('closes-open#1').journal[1]?.grounds)).toContain('journal_write の closes');
    expect(step('closes-open#1').tasks.find((t) => t.id === 'q-1')?.status).toBe('done');
    expect(text('closes-open#2')).toContain('closes w-1: w-1 を done にした。');
    expect(text('closes-open#3')).toContain('closes n-1: n-1 を done にした。');
    expect(text('closes-many#2')).toContain('closes d: d を done にした。');
    expect(text('closes-many#2')).toMatch(/closes d: d は既に .* に閉じてある/u);
    expect(text('closes-five')).toContain('closes e: e を done にした。');
    expect(text('closes-states#1')).toContain(
      'closes ghost: task ghost は無い（task_list で実在する id を確かめること）。',
    );
    expect(text('closes-states#2')).toContain('closes closed-done: closed-done は既に');
    expect(step('closes-states#1').journal).toHaveLength(1);
    expect(step('closes-grounds-omitted').dropped).toHaveLength(1);
    expect(text('closes-grounds-omitted')).toContain(WARN);
    expect(text('closes-grounds-omitted')).toContain('closes a: a を done にした。');

    // closes の検査
    for (let i = 1; i <= 5; i += 1) {
      const key = `closes-violation#${String(i)}`;
      expect(text(key), key).toMatch(/何もしていない。$/u);
      expect(step(key).journal, key).toEqual([]);
      expect(step(key).dropped, key).toEqual([]);
      expect(step(key).calls, key).toEqual([]);
    }
    expect(text('closes-violation#4')).toContain('closes[1].reason');

    // 日誌が書けない
    for (const key of ['journal-fails#1', 'journal-fails#2', 'journal-fails#3']) {
      expect(step(key).output.errorName, key).toBe('JournalNotRecordedError');
      expect(step(key).output.thrown, key).toBe(true);
      expect(text(key), key).toContain('journal_write');
      expect(ops(key), key).toEqual(['journal.append']);
      expect(step(key).tasks.find((t) => t.id === 'a')?.status, key).toBe('queued');
    }
    expect(step('journal-fails#1').dropped).toHaveLength(1);
    expect(step('journal-fails#2').dropped).toHaveLength(2);
    expect(text('journal-fails#4')).toContain('closes a: a を done にした。');

    // 閉じる所の失敗
    expect(text('closes-failures#1')).toContain(
      'closes a: task a は読めない形で入っている。読めない形のまま書き直さないので、閉じていない。',
    );
    expect(step('closes-failures#1').output.isError).toBe(false);
    expect(text('closes-failures#2')).toContain(
      'closes a: 閉じる処理が失敗した（Error: ストアが落ちた（get））',
    );
    expect(step('closes-failures#2').output.isError).toBe(true);
    expect(text('closes-failures#3')).toContain('task b は読めない形で入っている');
    expect(text('closes-failures#4')).toContain(
      '閉じる処理が失敗した（Error: ストアが落ちた（setStatus））',
    );
    expect(text('closes-failures#5')).toContain('closes c: c を done にした。');
    expect(text('closes-failures#5')).toContain('closes d: 閉じる処理が失敗した');
    expect(step('closes-failures#5').output.isError).toBe(true);
    expect(text('closes-races#1')).toContain(
      'closes a: task a は無い（確かめた直後に消えていた）。この呼びでは閉じていない。',
    );
    expect(text('closes-races#2')).toContain('closes b: b は既に done。');
    expect(text('closes-races#3')).toContain('closes c: c は done から done へは移せない');
    expect(text('closes-journal-fails#1')).toContain(
      '**task は done にしている**が、日誌に残せていない',
    );
    expect(step('closes-journal-fails#1').output.isError).toBe(true);
    expect(step('closes-journal-fails#1').tasks.find((t) => t.id === 'a')?.status).toBe('done');
    expect(step('closes-journal-fails#1').dropped).toHaveLength(1);
  });
});
