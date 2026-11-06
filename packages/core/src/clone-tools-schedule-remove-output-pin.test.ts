import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import type { InboxEvent, ScheduledRequest } from './schema.js';
import { UnreadableScheduleError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `schedule_remove` の出力（全文と字数）と、呼んだあとの状態（定期の依頼の行・受信箱の未読・日誌へ足された行・握った書き損じの跡）・呼びの並び
// （`journal.append`・`schedules.get/removeIfPresent`・`inbox.peekPending/removeMany`・`dropQueuedInboxEvents`。引数と結果）を、
// 場面ごとにコミットした固定値（clone-tools-schedule-remove-output-pin.json）と丸ごと比べる。
// `clone-tools-schedule.ts` の `tool('schedule_remove', …)`（`removeScheduleJournalFirst`: 先に日誌 → 外す → 外せなければ打ち消し。外せたら
// `context.dropQueuedInboxEvents` が在れば `dropUnreadTimersOfKind` で未読のタイマーを消す）を小さな関数へ分けるとき、振る舞いが1文字も変わらないことを
// 機械で確かめる歯。固定値の側で値を伏せず、入力（時計・依頼・受信箱）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - wrote: 呼ぶ前から変わったもの。none（何も）/ journal（日誌だけ）/ state（定期の依頼か受信箱が変わった。日誌も足される）。場面ごとの宣言と実際が合うことも確かめる
//   - schedules: 呼んだあとの定期の依頼の全行（`stores.schedules.list()`）
//   - inbox: 呼んだあとの受信箱の未読（id・種類・kind）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・id・at）
//   - dropped: 日誌の書き損じ・消し込みの失敗を握ったとき stderr へ残る跡
//   - calls: 呼びの並び（引数・結果・失敗付き）
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_SCHEDULE_REMOVE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-schedule-remove-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-schedule-remove-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、行・受信箱・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 作り方の注記:
//   - 読めない行: メモリのストアは壊れた行を持てないので、`get` が `UnreadableScheduleError` を投げ、`removeIfPresent` が行を消して `'unreadable'` を返す口（hooks.unreadableRow）で作る（本物のストアの振る舞いを写す）
//   - 「読んだ後に別の手で変えた」: `removeIfPresent` の直前に別の経路（素のストア）で行を消す・書き換える口（hooks.interfere）
//   - 受信箱・`dropQueuedInboxEvents` の失敗: 口（peekFails・removeManyFails・dropFails）。`dropUnreadTimersOfKind` は例外を握って跡だけ残す作りなので、応答は変わらない
//   - `context.dropQueuedInboxEvents` が無い配線は場面の `noDrop`
//
// 秘密: 本文・kind は作りものだけ。この道具は依頼の本文を日誌へ書く（伏せない）ので、本文に作りものの値が入る場面は、日誌へそのまま入ることをいまの振る舞いとして固定する
// （json にはその作りものの値が残る。本物ではない）。固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。
// 長い文字列は 10 字ごとに空白を挟む（`spaced`）。
//
// 作れない分岐: 無い（日誌の1行目・打ち消しの行・補いの行の失敗、受信箱の失敗、`get` / `removeIfPresent` の例外は口で作った）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み */
type Writes = 'none' | 'journal' | 'state';

interface Hooks {
  /** `schedules.get` が投げる（UnreadableScheduleError 以外） */
  getThrows: boolean;
  /** この呼びの kind の行が「在るが読めない」: `get` が UnreadableScheduleError を投げる */
  unreadableRow: boolean;
  /** `removeIfPresent` の直前に、別の経路が行を消す・書き換える */
  interfere: 'delete' | 'bump' | null;
  /** `removeIfPresent` が投げる */
  removeThrows: boolean;
  /** `journal.append` の n 回目（呼びの中・1 から）を投げさせる */
  journalFailsAt: number[];
  peekFails: boolean;
  removeManyFails: boolean;
  dropFails: boolean;
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
  seed: ScheduledRequest[];
  /** 受信箱へ仕込む未読 */
  inbox?: InboxEvent[];
  /** `context.dropQueuedInboxEvents` を渡さない配線 */
  noDrop?: boolean;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const SEED_AT = '2026-10-01T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-schedule-remove-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_SCHEDULE_REMOVE_PIN === '1';

const K = 'weekly-review';
/** 作りものの値（本物ではない）。依頼の本文へ入れて、日誌へ伏せずに入ることをいまのまま固定する */
const FAKE_VALUE = 'FAKE_NOT_A_REAL_VALUE_0123456789';

function callTime(index: number): number {
  return BASE_MS + (index + 1) * 60_000;
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function row(
  kind: string,
  request: string,
  spec: ScheduledRequest['spec'] = { type: 'every', minutes: 60 },
  extra: Partial<ScheduledRequest> = {},
): ScheduledRequest {
  return { kind, spec, request, createdAt: SEED_AT, updatedAt: SEED_AT, ...extra };
}

function timer(
  id: string,
  kind: string,
  extra: Partial<Extract<InboxEvent, { type: 'timer' }>> = {},
): InboxEvent {
  return { type: 'timer', id, at: SEED_AT, kind, cause: 'schedule', ...extra };
}

const w = (args: Args, writes: Writes, hooks?: Partial<Hooks>): Step => ({
  args,
  writes,
  ...(hooks === undefined ? {} : { hooks }),
});

const rm = (kind: string): Args => ({ kind });

const SCENARIOS: Scenario[] = [
  // ---- 外せる ----
  {
    name: 'remove-specs',
    covers:
      '外せる（予定の種類の各値）: 毎日（daily）・一定の間隔（every）・cron。日誌は先の行 1 本（「定期の依頼を外す: kind: 本文」）。行が消え、応答は「kind を外した。」。他の行は残る。未読のタイマーが無ければ受信箱へは peek だけ',
    seed: [
      row('daily-one', '毎日の依頼', { type: 'daily', at: '09:00' }),
      row('every-one', '一定の間隔の依頼', { type: 'every', minutes: 30 }),
      row('cron-one', 'cron の依頼', { type: 'cron', expression: '0 10 * * 1' }),
      row('keep-one', '残る依頼'),
    ],
    steps: [w(rm('daily-one'), 'state'), w(rm('every-one'), 'state'), w(rm('cron-one'), 'state')],
  },
  {
    name: 'remove-state-fields',
    covers:
      '外す行が実行の印（lastRunAt・pendingRun）を持っていても同じ: 日誌の本文に出るのは依頼の本文だけ',
    seed: [
      row(
        K,
        '印つきの依頼',
        { type: 'every', minutes: 60 },
        {
          lastRunAt: '2026-10-20T00:00:00.000Z',
          lastScheduledRunAt: '2026-10-20T00:00:00.000Z',
          pendingRun: { at: '2026-10-28T00:00:00.000Z', cause: 'schedule' },
        },
      ),
    ],
    steps: [w(rm(K), 'state')],
  },
  {
    name: 'remove-request-forms',
    covers:
      '依頼の本文の形: 長い本文（3,000 字）・多バイト文字と絵文字・改行を含む本文・前後の空白・1 字。日誌の decision に本文がそのまま（切らずに）入る',
    seed: [
      row('long-body', spaced(3_000, 'long')),
      row('multibyte', '日本語😀の依頼\n二行目 é'),
      row('multiline', '一行目\n\n三行目'),
      row('spaced', '  前後に空白  '),
      row('one-char', 'あ'),
    ],
    steps: [
      w(rm('long-body'), 'state'),
      w(rm('multibyte'), 'state'),
      w(rm('multiline'), 'state'),
      w(rm('spaced'), 'state'),
      w(rm('one-char'), 'state'),
    ],
  },
  {
    name: 'remove-value-in-request',
    covers:
      '依頼の本文に作りものの値が入る（いまの振る舞いのまま固定）: 日誌の decision へ伏せずにそのまま入る（応答には本文は出ない）',
    seed: [row(K, `export TOKEN=${FAKE_VALUE} を使う`)],
    steps: [w(rm(K), 'state')],
  },
  // ---- 未読のタイマー ----
  {
    name: 'timers-dropped',
    covers:
      '外せて、受信箱にその kind の未読のタイマーが在り、`dropQueuedInboxEvents` が在る: peekPending → removeMany（その kind の timer の id だけ）→ dropQueuedInboxEvents（実際に消えた id）。別の kind のタイマー・timer 以外の未読は残る。応答は変わらない',
    seed: [row(K, '依頼'), row('other', '別の依頼')],
    inbox: [
      timer('t-1', K),
      timer('t-2', K, { cause: 'manual' }),
      timer('t-3', 'other'),
      { type: 'distill', id: 'd-1', at: SEED_AT, reason: 'scheduled' },
    ],
    steps: [w(rm(K), 'state')],
  },
  {
    name: 'timers-none',
    covers:
      '外せて、受信箱にその kind の未読のタイマーが無い（別の kind のタイマーだけ・空）: peekPending だけで removeMany・dropQueuedInboxEvents は呼ばない',
    seed: [row(K, '依頼'), row('a', 'A'), row('b', 'B')],
    inbox: [timer('t-9', 'other')],
    steps: [w(rm(K), 'state'), w(rm('a'), 'state'), w(rm('b'), 'state')],
  },
  {
    name: 'no-drop-port',
    covers:
      '`context.dropQueuedInboxEvents` が無い配線: 外せるが未読のタイマーには触れない（受信箱への呼びが無い）。行は消え、タイマーは残る',
    seed: [row(K, '依頼')],
    inbox: [timer('t-1', K)],
    noDrop: true,
    steps: [w(rm(K), 'state')],
  },
  {
    name: 'timers-failures',
    covers:
      '未読のタイマーを消す所で落ちる（いまの振る舞いのまま）: peekPending・removeMany・dropQueuedInboxEvents のどれが落ちても `dropUnreadTimersOfKind` が握って跡だけ残し、応答は「外した」のまま（isError ではない）。行は消えている。落ちた先は仕事が残る: peek が落ちればタイマーは残る・removeMany が落ちても残る・drop が落ちたときは受信箱からは消えている',
    seed: [row('p', '依頼 p'), row('r', '依頼 r'), row('d', '依頼 d')],
    inbox: [timer('t-p', 'p'), timer('t-r', 'r'), timer('t-d', 'd')],
    steps: [
      w(rm('p'), 'state', { peekFails: true }),
      w(rm('r'), 'state', { removeManyFails: true }),
      w(rm('d'), 'state', { dropFails: true }),
    ],
  },
  // ---- 無い・読めない・競り合い ----
  {
    name: 'not-found',
    covers:
      '無い kind: 「継続中の依頼 kind は無い。」。日誌には何も書かない・受信箱へも触れない（get だけ）。他の行は残る。同じ kind を続けて外すと 2 回目は無い',
    seed: [row('present', '在る依頼')],
    inbox: [timer('t-1', 'ghost')],
    steps: [w(rm('ghost'), 'none'), w(rm('present'), 'state'), w(rm('present'), 'none')],
  },
  {
    name: 'kind-forms',
    covers:
      'kind の形の境目（道具は kind の形を検査しない。ストアが「無い」と答える）: 空・長い（65 字）・空白を含む・大文字・日本語・NUL を含む。どれも「継続中の依頼 … は無い」で、日誌は書かない。64 字ちょうどの kind は在れば外せる',
    seed: [row('a'.repeat(64), '64字の kind')],
    steps: [
      w(rm(''), 'none'),
      w(rm('a'.repeat(65)), 'none'),
      w(rm('has space'), 'none'),
      w(rm('UPPER'), 'none'),
      w(rm('日本語の kind'), 'none'),
      w(rm('a\u0000b'), 'none'),
      w(rm('a'.repeat(64)), 'state'),
    ],
  },
  {
    name: 'unreadable-row',
    covers:
      '読めない行（get が UnreadableScheduleError）: 「読めない形で入っていた依頼を外す: kind」の行を書いて外す（本文は取り出せない）。応答は「外した」。未読のタイマーも消す',
    seed: [row(K, '壊れた行'), row('other', '別の依頼')],
    inbox: [timer('t-1', K)],
    steps: [w(rm(K), 'state', { unreadableRow: true })],
  },
  {
    name: 'raced-delete',
    covers:
      '読んだ後・外す前に別の手が行を消していた（removeIfPresent が null）: 先の行のあとに打ち消しの行（「直前の定期の依頼を外す行は効いていない（外していない）。理由: 外す直前に依頼がほかで消えていた」）。応答は「無い」。未読のタイマーには触れない',
    seed: [row(K, '消される依頼')],
    inbox: [timer('t-1', K)],
    steps: [w(rm(K), 'state', { interfere: 'delete' })],
  },
  {
    name: 'raced-bump',
    covers:
      '読んだ後・外す前に別の手が本文を書き換えていた: 外したのは書き換え後の行で、先の行に書いた本文と違うので「…実際に外したのは次のとおり」の補いの行を足す。応答は「外した」',
    seed: [row(K, '書き換えられる依頼')],
    steps: [w(rm(K), 'state', { interfere: 'bump' })],
  },
  // ---- 先の日誌 ----
  {
    name: 'journal-first-fails',
    covers:
      '先の日誌が書けない: 何も外さず、JournalNotRecordedError（act-not-performed）を投げる（握った書き損じの跡が 1 つ）。行・受信箱は変わらない。日誌が戻れば次の呼びは外せる。読めない行でも同じ',
    seed: [row(K, '依頼'), row('u', '壊れた行')],
    inbox: [timer('t-1', K)],
    steps: [
      w(rm(K), 'none', { journalFailsAt: [1] }),
      w(rm('u'), 'none', { journalFailsAt: [1], unreadableRow: true }),
      w(rm(K), 'state'),
    ],
  },
  {
    name: 'journal-retraction-fails',
    covers:
      '打ち消しの行が書けない: 応答は「無い」のまま・跡を握る。補いの行が書けない場合も応答は「外した」のまま',
    seed: [row(K, '依頼 A'), row('b', '依頼 B')],
    steps: [
      w(rm(K), 'state', { interfere: 'delete', journalFailsAt: [2] }),
      w(rm('b'), 'state', { interfere: 'bump', journalFailsAt: [2] }),
    ],
  },
  // ---- ストアの失敗 ----
  {
    name: 'store-failures',
    covers:
      '`get` が UnreadableScheduleError 以外で落ちる・`removeIfPresent` が落ちる: 握らず投げ直す（例外で返る）。get が落ちれば日誌も書かない。removeIfPresent が落ちれば先の行だけ残る（打ち消しは書かない）',
    seed: [row(K, '依頼')],
    inbox: [timer('t-1', K)],
    steps: [
      w(rm(K), 'none', { getThrows: true }),
      w(rm(K), 'journal', { removeThrows: true }),
      w(rm(K), 'state'),
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
  schedules: Record<string, unknown>[];
  inbox: Record<string, unknown>[];
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
  return {
    getThrows: false,
    unreadableRow: false,
    interfere: null,
    removeThrows: false,
    journalFailsAt: [],
    peekFails: false,
    removeManyFails: false,
    dropFails: false,
  };
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function record(calls: PinnedCall[], op: string, args: unknown): PinnedCall {
  const entry: PinnedCall = { op, args: plain(args), outcome: '(まだ戻っていない)' };
  calls.push(entry);
  return entry;
}

function countOf(calls: PinnedCall[], op: string): number {
  return calls.filter((entry) => entry.op === op).length;
}

interface Snapshot {
  schedules: Record<string, unknown>[];
  inbox: Record<string, unknown>[];
  journal: Record<string, unknown>[];
}

async function snapshot(base: Stores): Promise<Snapshot> {
  const { entries } = await base.schedules.list();
  const peek = await base.inbox.peekPending();
  return {
    schedules: plain(entries) as unknown as Record<string, unknown>[],
    inbox: peek.entries.map(({ event }) => ({
      id: event.id,
      type: event.type,
      ...(event.type === 'timer' ? { kind: event.kind } : {}),
    })),
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[], kindOf: () => string): Stores {
  return {
    ...base,
    schedules: {
      ...base.schedules,
      get: async (kind) => {
        const entry = record(calls, 'schedules.get', { kind });
        if (hooks.getThrows) {
          entry.outcome = 'threw Error';
          throw new Error('定期の依頼が読めない（test）');
        }
        if (hooks.unreadableRow && kind === kindOf()) {
          entry.outcome = 'threw UnreadableScheduleError';
          throw new UnreadableScheduleError(`定期の依頼の行が読めない: ${kind}`, { kind });
        }
        const found = await base.schedules.get(kind);
        entry.outcome = found === null ? 'null' : `row updatedAt=${found.updatedAt}`;
        return found;
      },
      removeIfPresent: async (kind, options) => {
        const entry = record(calls, 'schedules.removeIfPresent', {
          kind,
          options: options ?? null,
        });
        if (hooks.interfere === 'delete') await base.schedules.removeIfPresent(kind);
        if (hooks.interfere === 'bump') {
          const current = await base.schedules.get(kind);
          if (current !== null) {
            await base.schedules.put({
              ...current,
              request: '別の手で書き換えた本文',
              updatedAt: '2026-10-29T00:00:30.000Z',
            });
          }
        }
        if (hooks.removeThrows) {
          entry.outcome = 'threw Error';
          throw new Error('定期の依頼を外せない（test）');
        }
        const real = await base.schedules.removeIfPresent(kind, options);
        // 読めない行は本物のストアなら 'unreadable' を返す（行は消える）
        const removed =
          hooks.unreadableRow && kind === kindOf() && real !== null ? 'unreadable' : real;
        entry.outcome =
          removed === null
            ? 'null'
            : removed === 'unreadable'
              ? 'unreadable'
              : `removed request=${removed.request.slice(0, 20)}`;
        return removed;
      },
    },
    inbox: {
      ...base.inbox,
      peekPending: async () => {
        const entry = record(calls, 'inbox.peekPending', {});
        if (hooks.peekFails) {
          entry.outcome = 'threw Error';
          throw new Error('受信箱が読めない（test）');
        }
        const peek = await base.inbox.peekPending();
        entry.outcome = `${String(peek.entries.length)} entries`;
        return peek;
      },
      removeMany: async (ids) => {
        const entry = record(calls, 'inbox.removeMany', { ids });
        if (hooks.removeManyFails) {
          entry.outcome = 'threw Error';
          throw new Error('受信箱から消せない（test）');
        }
        const removed = await base.inbox.removeMany(ids);
        entry.outcome = `removed ${JSON.stringify(removed)}`;
        return removed;
      },
    },
    journal: {
      ...base.journal,
      append: async (input) => {
        const entry = record(calls, 'journal.append', input);
        if (hooks.journalFailsAt.includes(countOf(calls, 'journal.append'))) {
          entry.outcome = 'threw Error: 日誌が落ちた';
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(input);
        entry.outcome = `ok ${written.id}`;
        return written;
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(SEED_AT));
  for (const seed of scenario.seed) await base.schedules.put(seed);
  for (const event of scenario.inbox ?? []) await base.inbox.put(event, SEED_AT);
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
      const kind = String(step.args.kind);
      const stores = withHooks(base, hooks, calls, () => kind);
      const found = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
        ...(scenario.noDrop === true
          ? {}
          : {
              dropQueuedInboxEvents: async (ids: readonly string[]) => {
                const entry = record(calls, 'dropQueuedInboxEvents', { ids });
                if (hooks.dropFails) {
                  entry.outcome = 'threw Error';
                  throw new Error('配達を止められない（test）');
                }
                entry.outcome = `dropped ${String(ids.length)}`;
                return ids.length;
              },
            }),
      }).find((entry) => entry.name === 'schedule_remove');
      if (!found) throw new Error('schedule_remove が無い');

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
      const stateChanged =
        JSON.stringify([before.schedules, before.inbox]) !==
        JSON.stringify([after.schedules, after.inbox]);
      const journalChanged = before.journal.length !== after.journal.length;
      const wrote: Writes = stateChanged ? 'state' : journalChanged ? 'journal' : 'none';
      const key = stepKey(scenario, index);
      expect(wrote, `場面 ${key}: 書き込みの有無が宣言（${step.writes}）と違う`).toBe(step.writes);
      results.push({
        output,
        wrote,
        schedules: after.schedules,
        inbox: after.inbox,
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

describe('schedule_remove の出力と呼んだあとの状態の固定（場面ごとの出力の全文・行・受信箱・日誌の行・呼びの並び）', () => {
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

      it(`${key} の呼んだあとの定期の依頼の行・受信箱が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.schedules, `場面 ${key} の定期の依頼の行が変わった`).toEqual(want?.schedules);
        expect(got?.inbox, `場面 ${key} の受信箱の未読が変わった`).toEqual(want?.inbox);
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

  it('同じ入力で2回回すと、全場面で同じ出力・行・受信箱・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に本物らしい値と絶対パスが無い。作りものの値は、依頼の本文の場面にだけ在る', () => {
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toContain('/tmp/');
    for (const key of ALL_KEYS) {
      if (key === 'remove-value-in-request') continue;
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
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const decisions = (key: string): string[] =>
      step(key).journal.map((entry) => String(entry.decision));
    const RETRACT = (why: string): string =>
      `直前の定期の依頼を外す行は効いていない（外していない）。理由: ${why}`;

    // 外せる
    for (const [key, kind, request] of [
      ['remove-specs#1', 'daily-one', '毎日の依頼'],
      ['remove-specs#2', 'every-one', '一定の間隔の依頼'],
      ['remove-specs#3', 'cron-one', 'cron の依頼'],
    ] as const) {
      expect(text(key), key).toBe(`${kind} を外した。`);
      expect(decisions(key), key).toEqual([`定期の依頼を外す: ${kind}: ${request}`]);
      expect(step(key).journal[0]?.grounds, key).toBe('この依頼はもう要らないという判断');
      expect(ops(key), key).toEqual([
        'schedules.get',
        'journal.append',
        'schedules.removeIfPresent',
        'inbox.peekPending',
      ]);
    }
    expect(step('remove-specs#3').schedules.map((r) => r.kind)).toEqual(['keep-one']);
    expect(decisions('remove-request-forms#1')[0]).toContain(spaced(3_000, 'long'));
    expect(decisions('remove-request-forms#2')[0]).toContain('日本語😀の依頼\n二行目 é');
    expect(decisions('remove-request-forms#4')[0]).toBe('定期の依頼を外す: spaced:   前後に空白  ');
    expect(text('remove-state-fields')).toBe(`${K} を外した。`);
    expect(decisions('remove-value-in-request')[0]).toContain(`export TOKEN=${FAKE_VALUE} を使う`);
    expect(text('remove-value-in-request')).not.toContain(FAKE_VALUE);

    // 未読のタイマー
    expect(ops('timers-dropped')).toEqual([
      'schedules.get',
      'journal.append',
      'schedules.removeIfPresent',
      'inbox.peekPending',
      'inbox.removeMany',
      'dropQueuedInboxEvents',
    ]);
    expect(step('timers-dropped').inbox).toEqual([
      { id: 't-3', type: 'timer', kind: 'other' },
      { id: 'd-1', type: 'distill' },
    ]);
    expect(step('timers-dropped').calls.find((c) => c.op === 'inbox.removeMany')?.args).toEqual({
      ids: ['t-1', 't-2'],
    });
    expect(ops('timers-none#1')).toEqual([
      'schedules.get',
      'journal.append',
      'schedules.removeIfPresent',
      'inbox.peekPending',
    ]);
    expect(ops('no-drop-port')).toEqual([
      'schedules.get',
      'journal.append',
      'schedules.removeIfPresent',
    ]);
    expect(step('no-drop-port').inbox).toEqual([{ id: 't-1', type: 'timer', kind: K }]);
    for (const key of ['timers-failures#1', 'timers-failures#2', 'timers-failures#3']) {
      expect(step(key).output.isError, key).toBe(false);
      expect(step(key).output.thrown, key).toBe(false);
      expect(step(key).dropped, key).toHaveLength(1);
      expect(step(key).dropped[0], key).toContain('取り消した定期の依頼の未読の起動の消し込み');
    }
    expect(text('timers-failures#1')).toBe('p を外した。');
    expect(step('timers-failures#1').inbox.map((e) => e.id)).toEqual(['t-p', 't-r', 't-d']);
    expect(step('timers-failures#3').inbox.map((e) => e.id)).toEqual(['t-p', 't-r']);

    // 無い・読めない・競り合い
    expect(text('not-found#1')).toBe('継続中の依頼 ghost は無い。');
    expect(ops('not-found#1')).toEqual(['schedules.get']);
    expect(step('not-found#1').journal).toEqual([]);
    expect(text('not-found#3')).toBe('継続中の依頼 present は無い。');
    for (let i = 1; i <= 6; i += 1) {
      const key = `kind-forms#${String(i)}`;
      expect(text(key), key).toMatch(/^継続中の依頼 .* は無い。$/u);
      expect(step(key).journal, key).toEqual([]);
    }
    expect(text('kind-forms#7')).toBe(`${'a'.repeat(64)} を外した。`);
    expect(text('unreadable-row')).toBe(`${K} を外した。`);
    expect(decisions('unreadable-row')).toEqual([`読めない形で入っていた依頼を外す: ${K}`]);
    expect(step('unreadable-row').inbox).toEqual([]);
    expect(text('raced-delete')).toBe(`継続中の依頼 ${K} は無い。`);
    expect(decisions('raced-delete')[1]).toBe(RETRACT('外す直前に依頼がほかで消えていた'));
    expect(ops('raced-delete')).not.toContain('inbox.peekPending');
    expect(text('raced-bump')).toBe(`${K} を外した。`);
    expect(decisions('raced-bump')[1]).toContain(
      '実際に外したのは次のとおり: 依頼 別の手で書き換えた本文',
    );

    // 先の日誌
    for (const key of ['journal-first-fails#1', 'journal-first-fails#2']) {
      expect(step(key).output.errorName, key).toBe('JournalNotRecordedError');
      expect(step(key).output.thrown, key).toBe(true);
      expect(text(key), key).toContain('schedule_remove');
      expect(ops(key), key).not.toContain('schedules.removeIfPresent');
      expect(step(key).journal, key).toEqual([]);
      expect(step(key).dropped, key).toHaveLength(1);
    }
    expect(text('journal-first-fails#3')).toBe(`${K} を外した。`);
    expect(text('journal-retraction-fails#1')).toBe(`継続中の依頼 ${K} は無い。`);
    expect(step('journal-retraction-fails#1').dropped).toHaveLength(1);
    expect(step('journal-retraction-fails#1').journal).toHaveLength(1);
    expect(text('journal-retraction-fails#2')).toBe('b を外した。');
    expect(step('journal-retraction-fails#2').dropped).toHaveLength(1);

    // ストアの失敗
    expect(step('store-failures#1').output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: '定期の依頼が読めない（test）',
    });
    expect(ops('store-failures#1')).toEqual(['schedules.get']);
    expect(step('store-failures#2').output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: '定期の依頼を外せない（test）',
    });
    expect(ops('store-failures#2')).toEqual([
      'schedules.get',
      'journal.append',
      'schedules.removeIfPresent',
    ]);
    expect(step('store-failures#2').journal).toHaveLength(1);
    expect(text('store-failures#3')).toBe(`${K} を外した。`);
  });
});
