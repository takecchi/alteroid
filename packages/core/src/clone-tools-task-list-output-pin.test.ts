import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { excerptLine, renderListingEntry } from './excerpt.js';
import type { Task, TaskOrigin } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { taskStatusLine } from './task-tools.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `task_list` の出力（全文と字数）と、呼んだあとの状態（task の行・日誌・ストアの書き込み口が呼ばれたか）を、
// 場面ごとにコミットした固定値（clone-tools-task-list-output-pin.json）と丸ごと比べる。
// `clone-tools-task.ts` の `tool('task_list', …)`（約 129 行・入れ子 6 段の式）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の本文）を固定して毎回同じにする。
// この道具は読むだけ（task_set_status_many と違って書かない）。だから出力に加えて、次を場面ごとに確かめる:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - wrote: 呼ぶ前後で task の行（閉じた行を含む全件）・日誌の行数が変わったか。全場面で false でなければならない（試験の中で比べる）
//   - writeCalls: 呼びの間にストアの書き込み口（task の add/move/setStatus/setKeep/edit/clear/removeForConversation・日誌の append）が呼ばれた記録。全場面で空
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。task は場面の頭に固定の createdAt
// （基準の 2026-10-01 から分単位）で入れる。task_list は時刻を出力に作らないので、時計は task の行の時刻（閉じた時刻）にだけ効く。
// 一覧の予算（TASK_LIST_BUDGET = 8,000 字）・頁の大きさ（TASK_PAGE = 8,000 字）・抜粋（TASK_BODY_LIMIT = 240 字）の境目は、
// 1件ぶんの字数を `renderListingEntry` で測って task の題の長さで合わせて作る（ちょうど 8,000 / 8,001 / 7,999 字）。
// 続きの cursor を使う場面は、前の呼びの出力から cursor を取り出して渡す（道具が案内した cursor がそのまま使えることも測る）。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない: `scripts/agents-md-references.test.ts` の走査が二乗の時間になるため。
// 長い本文・題は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

interface SeedTask {
  id: string;
  origin: TaskOrigin;
  /** createdAt（基準から何分後か） */
  minute: number;
  source?: string;
  title?: string;
  body?: string;
  conv?: string;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
  /** 「続く」の印（閉じる前に立てる） */
  keep?: boolean;
  /** 閉じる理由を付けない */
  noReason?: boolean;
  /** 閉じた主体。'none' なら記録しない。省略は human */
  by?: 'clone' | 'human' | 'daemon' | 'none';
  /** 閉じた時刻（基準から何分後か）。省略は createdAt の 100 分後（新しく作った task ほど新しく閉じた） */
  closedMinute?: number;
}

interface Hooks {
  /** 一覧が返す「読めない行」（id が無い行も作れる） */
  unreadable?: { id?: string; reason: string }[];
  /** この id の `get` が読めない行の例外（UnreadableTaskError）で落ちる */
  getUnreadable?: string[];
  /** この id の `get` が器の障害（普通の Error）で落ちる */
  getThrows?: string[];
  /** 一覧そのものが落ちる */
  listFails?: boolean;
}

interface Step {
  /** 前の呼びの出力の全文（先頭の呼びは空）を受けて引数を作れる（cursor の取り出し用） */
  args: Args | ((previous: string) => Args);
  hooks?: Hooks;
  /** この呼びの直前に、別の経路が task を動かす（呼ぶ前の状態を作る。道具の書き込みではない） */
  before?: (base: Stores) => Promise<void>;
}

interface Scenario {
  name: string;
  /** 読み手のための整理。表に出す */
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedTask[];
  hooks?: Hooks;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const TASK_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const SEED_UPDATED_ISO = '2026-10-02T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-task-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_LIST_PIN === '1';

const TASK_BODY_LIMIT = 240;
const TASK_LIST_BUDGET = 8_000;
const TASK_PAGE = 8_000;
/** 全文読みの1頁の本文の先頭に付く見出し（開いている task は理由が無いので、頁の先頭はこれ） */
const BODY_HEADING = '本文（全文）: ';

function minuteIso(minute: number): string {
  return new Date(TASK_BASE + minute * 60_000).toISOString();
}

function t(
  id: string,
  origin: TaskOrigin,
  minute: number,
  extra: Partial<Omit<SeedTask, 'id' | 'origin' | 'minute'>> = {},
): SeedTask {
  return { id, origin, minute, ...extra };
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** cursor を道具の実装と独立に組む（形そのものも固定する） */
function cur(id: string, includeClosed = false): string {
  return Buffer.from(JSON.stringify({ id, includeClosed }), 'utf8').toString('base64url');
}

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** 前の出力の「続きは task_list cursor=… で取れる」から cursor を取り出す */
function cursorOf(previous: string): string {
  const found = /task_list cursor=([A-Za-z0-9_-]+) で取れる/.exec(previous);
  if (found === null || found[1] === undefined) throw new Error('前の出力に cursor の案内が無い');
  return found[1];
}

function toTask(spec: SeedTask): Task {
  return {
    id: spec.id,
    createdAt: minuteIso(spec.minute),
    updatedAt: minuteIso(spec.minute),
    status: 'queued',
    origin: spec.origin,
    title: spec.title ?? `仕事 ${spec.id}`,
    body: spec.body ?? `本文 ${spec.id}`,
    ...(spec.source === undefined ? {} : { source: spec.source }),
    ...(spec.conv === undefined ? {} : { originConversationId: spec.conv }),
  };
}

/** 一覧の1件ぶんの字数（queued の task が、一覧の position 番目に出るとき） */
function itemLength(spec: SeedTask, position: number): number {
  const task = toTask(spec);
  return renderListingEntry({
    id: task.id,
    title: task.title,
    summary: excerptLine(task.body, TASK_BODY_LIMIT),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    extra: [
      `  ${position}番目 / ${taskStatusLine(task)}`,
      ...(task.originConversationId === undefined
        ? []
        : [`  起点の会話: ${task.originConversationId}`]),
    ],
  }).length;
}

/**
 * 先頭から count 件の1件ぶんの字数の合計がちょうど target になる task の並び（最後の1件の題の長さで合わせる）。
 * 後ろに extras を足す（予算に収まらず省略される件）。
 */
function calibrated(count: number, target: number, extras: SeedTask[] = []): SeedTask[] {
  const specs = Array.from({ length: count }, (_, index) =>
    t(`b-${pad2(index + 1)}`, 'external', index + 1, {
      title: spaced(150, 'title'),
      body: spaced(TASK_BODY_LIMIT),
    }),
  );
  const last = specs[count - 1];
  if (last === undefined) throw new Error('count が 0');
  let others = 0;
  for (const [index, spec] of specs.slice(0, -1).entries()) others += itemLength(spec, index + 1);
  const base = itemLength({ ...last, title: '' }, count);
  const titleLen = target - others - base;
  if (titleLen < 1) throw new Error(`題の長さが合わせられない: ${String(titleLen)}`);
  last.title = spaced(titleLen, 'title');
  const total = others + itemLength(last, count);
  if (total !== target) throw new Error(`合計が目標と違う: ${String(total)} / ${String(target)}`);
  return [...specs, ...extras];
}

function manyTasks(count: number, prefix = 'm'): SeedTask[] {
  return Array.from({ length: count }, (_, index) =>
    t(`${prefix}-${pad2(index + 1)}`, 'external', index + 1, {
      title: spaced(60, 'ttl'),
      body: spaced(TASK_BODY_LIMIT),
    }),
  );
}

/** 全部の状態・起点・印を持つ標準の task 一式。開いている5件（add の順）と閉じた3件 */
const MIX: SeedTask[] = [
  t('human-1', 'human', 1, {
    source: 'thread-9',
    conv: 'conv-h1',
    keep: true,
    title: '人間の依頼 1',
    body: '人間の発言の本文。',
  }),
  t('human-2', 'human', 2, {
    title: '会話の無い人間の依頼',
    body: '台帳から移した、会話の欄が無い行。',
  }),
  t('mgr-1', 'manager', 3, { source: 'mgr-77', status: 'waiting', body: '報告を待っている。' }),
  t('ext-1', 'external', 4, {
    source: 'ci-watch',
    status: 'needs_decision',
    body: '決めてほしい外部イベント。',
  }),
  t('self-1', 'self', 5, { conv: 'conv-s1', body: '自分で気づいた宿題。' }),
  t('done-1', 'human', 6, {
    conv: 'conv-h2',
    status: 'done',
    body: '返答して閉じた。',
    closedMinute: 200,
  }),
  t('canc-1', 'external', 7, {
    status: 'cancelled',
    noReason: true,
    by: 'daemon',
    body: '理由なしで取りやめた。',
    closedMinute: 201,
  }),
  t('done-2', 'self', 8, {
    status: 'done',
    keep: true,
    by: 'none',
    body: '閉じた主体の記録が無い。',
    closedMinute: 199,
  }),
];

function bodyOfPageText(pageTextLength: number): string {
  return spaced(pageTextLength - BODY_HEADING.length);
}

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-offset',
    group: '引数の検査',
    covers:
      'offset の違反（負・小数・NaN・Infinity）。id があってもなくても、モードに入る前に断る（ストアは読まない）。違反でない 0・大きい値は通る',
    seed: [t('t-1', 'human', 1)],
    steps: [
      { args: { id: 't-1', offset: -1 } },
      { args: { id: 't-1', offset: 1.5 } },
      { args: { id: 't-1', offset: Number.NaN } },
      { args: { id: 't-1', offset: Number.POSITIVE_INFINITY } },
      { args: { id: 't-1', offset: -0.5 } },
      { args: { offset: -1 } },
      { args: { offset: 2.5, includeClosed: true, cursor: 'x' } },
      { args: { id: 'no-such', offset: -3 } },
      { args: { id: 't-1', offset: 0 } },
      { args: { offset: 5 } },
    ],
  },

  // ---- id の全文読み: 無い・読めない ----
  {
    name: 'id-missing',
    group: 'id の全文読み',
    covers:
      '無い id（空文字も id として扱う）。一覧用の引数（includeClosed・cursor）は id があると無視されるので、壊れた cursor でも同じ断り',
    seed: MIX,
    steps: [
      { args: { id: 'no-such' } },
      { args: { id: '' } },
      { args: { id: 'no-such', includeClosed: true, cursor: 'garbage' } },
      { args: { id: 'HUMAN-1' } },
      { args: { id: ' human-1' } },
    ],
  },
  {
    name: 'id-unreadable',
    group: 'id の全文読み',
    covers:
      '読めない形で入っている行（get が UnreadableTaskError）: 「無い」とは別の文言。別の id は読める',
    seed: MIX,
    hooks: { getUnreadable: ['bad-1'] },
    steps: [
      { args: { id: 'bad-1' } },
      { args: { id: 'bad-1', offset: 100 } },
      { args: { id: 'human-1' } },
    ],
  },
  {
    name: 'id-store-error',
    group: 'id の全文読み',
    covers: '器の障害（普通の Error）は飲み込まず例外のまま出る（THREW）。読めない行とは区別される',
    seed: MIX,
    hooks: { getThrows: ['boom'], getUnreadable: ['bad-1'] },
    steps: [{ args: { id: 'boom' } }, { args: { id: 'bad-1' } }, { args: { id: 'self-1' } }],
  },

  // ---- id の全文読み: 状態・起点の印・閉じた記録 ----
  {
    name: 'id-each-task',
    group: 'id の全文読み',
    covers:
      '標準の8件を1件ずつ全文で: 起点の印4種（source の有る・無し）・状態5種（queued / waiting / needs_decision / done / cancelled）・「続く」の印・起点の会話の有り無し・閉じた理由（有り・無し・閉じた主体の記録なし）',
    seed: MIX,
    steps: MIX.map((spec) => ({ args: { id: spec.id } })),
  },
  {
    name: 'id-closed-variants',
    group: 'id の全文読み',
    covers:
      '閉じた task の理由の出方: 理由あり・理由なし・主体が clone / daemon / 記録なし・閉じた task の続く印・理由が複数行',
    seed: [
      t('c-reason', 'human', 1, { status: 'done', conv: 'c-1', body: '理由つき。' }),
      t('c-noreason', 'manager', 2, { status: 'cancelled', noReason: true, body: '理由なし。' }),
      t('c-clone', 'self', 3, { status: 'done', by: 'clone', body: 'clone が閉じた。' }),
      t('c-daemon', 'external', 4, { status: 'cancelled', by: 'daemon', source: 'ci-watch' }),
      t('c-none', 'self', 5, { status: 'done', by: 'none', keep: true }),
    ],
    steps: ['c-reason', 'c-noreason', 'c-clone', 'c-daemon', 'c-none'].map((id) => ({
      args: { id },
    })),
  },
  {
    name: 'id-open-keep',
    group: 'id の全文読み',
    covers: '開いている task の「続く」の印（queued / waiting / needs_decision で付く）',
    seed: [
      t('k-q', 'human', 1, { keep: true, conv: 'k-c' }),
      t('k-w', 'manager', 2, { keep: true, status: 'waiting' }),
      t('k-d', 'external', 3, { keep: true, status: 'needs_decision' }),
      t('k-n', 'human', 4, { conv: 'k-c2' }),
    ],
    steps: ['k-q', 'k-w', 'k-d', 'k-n'].map((id) => ({ args: { id } })),
  },
  {
    name: 'id-text-shape',
    group: 'id の全文読み',
    covers:
      '全文は本文をそのまま出す（改行・連続した空白・題の改行をたたまない）。空の本文・空白だけの本文。一覧の抜粋とは違い切らない',
    seed: [
      t('s-multi', 'human', 1, {
        title: '題の1行目\n題の2行目',
        body: '一行目\n\n  二行目\t三行目\n',
      }),
      t('s-empty', 'self', 2, { title: '', body: '' }),
      t('s-blank', 'self', 3, { body: '   \n  ' }),
      t('s-long-240', 'external', 4, { body: spaced(TASK_BODY_LIMIT + 60) }),
    ],
    steps: ['s-multi', 's-empty', 's-blank', 's-long-240'].map((id) => ({ args: { id } })),
  },

  // ---- id の全文読み: 頁の境目 ----
  {
    name: 'id-offset-small',
    group: 'id の全文読み（頁・offset）',
    covers:
      '小さな本文の offset: 先頭（全文の言い方）・途中・見出しの直後・末尾の1字手前・末尾ちょうど・末尾を越える・巨大な値。続きの案内は付かない。offset 0 を明示しても同じ',
    seed: [t('o-small', 'human', 1, { body: 'abcdefghij' })],
    steps: [0, 3, BODY_HEADING.length, BODY_HEADING.length + 9, 18, 19, 1_000_000].map(
      (offset) => ({ args: { id: 'o-small', offset } }),
    ),
  },
  {
    name: 'id-page-edge',
    group: 'id の全文読み（頁・offset）',
    covers:
      '開いている task は頁の先頭が「本文（全文）: 」なので、本文 7,991 / 7,992 / 7,993 字で頁の全体が 7,999 / 8,000 / 8,001 字: 8,000 字ちょうどは1頁で終わる（続きなし）、8,001 字は 8,000 字目で切れて続きの offset=8000。offset 1 は境目をまたいでも 2〜8,001 で最後（続きなし）',
    seed: [
      t('e-7999', 'human', 1, { body: bodyOfPageText(7_999) }),
      t('e-8000', 'human', 2, { body: bodyOfPageText(8_000) }),
      t('e-8001', 'human', 3, { body: bodyOfPageText(8_001) }),
    ],
    steps: [
      { args: { id: 'e-7999' } },
      { args: { id: 'e-8000' } },
      { args: { id: 'e-8000', offset: 1 } },
      { args: { id: 'e-8001' } },
      { args: { id: 'e-8001', offset: 1 } },
      { args: { id: 'e-8001', offset: 2 } },
      { args: { id: 'e-8001', offset: 8_000 } },
      { args: { id: 'e-8001', offset: 8_001 } },
      { args: { id: 'e-8001', offset: 8_002 } },
    ],
  },
  {
    name: 'id-page-three',
    group: 'id の全文読み（頁・offset）',
    covers:
      '頁の全体が 16,001 字: 0 → 8000 → 16000（最後は1字）→ 16001（末尾ちょうど）。続きの offset を案内どおりに渡す',
    seed: [t('p-3', 'human', 1, { body: bodyOfPageText(16_001) })],
    steps: [
      { args: { id: 'p-3' } },
      { args: { id: 'p-3', offset: TASK_PAGE } },
      { args: { id: 'p-3', offset: 2 * TASK_PAGE } },
      { args: { id: 'p-3', offset: 16_001 } },
    ],
  },
  {
    name: 'id-page-astral',
    group: 'id の全文読み（頁・offset）',
    covers:
      '8,000 字目が補助面の文字の途中: 1頁目は 7,999 字で切る（文字を割らない）。続きの offset は 7999。7,999 字目から読むと補助面の文字から始まる',
    seed: [
      t('a-1', 'human', 1, {
        body: `${spaced(7_991)}😀tail`,
      }),
    ],
    steps: [
      { args: { id: 'a-1' } },
      { args: { id: 'a-1', offset: 7_999 } },
      { args: { id: 'a-1', offset: 8_000 } },
    ],
  },
  {
    name: 'id-page-closed',
    group: 'id の全文読み（頁・offset）',
    covers:
      '閉じた task が長い: 閉じた理由は本文より先（1頁目の先頭）に置かれる。理由のぶん本文の頁の切れ目が前へずれる。続きの offset で残りを読む。短い閉じた task は1頁',
    seed: [
      t('z-1', 'human', 1, { status: 'done', body: bodyOfPageText(8_000) }),
      t('z-2', 'self', 2, { status: 'cancelled', body: '短い本文。' }),
    ],
    steps: [
      { args: { id: 'z-1' } },
      { args: { id: 'z-1', offset: TASK_PAGE } },
      { args: { id: 'z-2' } },
    ],
  },

  // ---- id: 一覧用の引数は無視される ----
  {
    name: 'id-ignores-list-args',
    group: 'id の全文読み',
    covers:
      'id があれば includeClosed・cursor は無視される（壊れた cursor・食い違う cursor・読めない行があっても全文読みは変わらない）。一覧は呼ばれない（listFails でも読める）',
    seed: MIX,
    hooks: { listFails: true, unreadable: [{ id: 'bad-1', reason: '壊れ' }] },
    steps: [
      { args: { id: 'human-1' } },
      { args: { id: 'human-1', includeClosed: true } },
      { args: { id: 'human-1', cursor: 'garbage' } },
      { args: { id: 'human-1', includeClosed: true, cursor: cur('mgr-1', false) } },
      { args: { id: 'done-1', includeClosed: false } },
    ],
  },

  // ---- 一覧: 空・読めない行 ----
  {
    name: 'list-empty',
    group: '一覧（空・読めない行）',
    covers:
      'task が1件も無く読めない行も無い: 「（task は無い）」。includeClosed・offset・壊れた cursor を付けても同じ（cursor は読まれない）',
    seed: [],
    steps: [
      { args: {} },
      { args: { includeClosed: true } },
      { args: { includeClosed: false } },
      { args: { cursor: 'garbage' } },
      { args: { cursor: cur('x'), includeClosed: true } },
      { args: { offset: 5 } },
    ],
  },
  {
    name: 'list-only-closed',
    group: '一覧（空・読めない行）',
    covers:
      '閉じた task だけが在る: 既定の一覧は開いている件だけなので「（task は無い）」に落ちる（閉じた件が在るのに）。includeClosed を付けると出る',
    seed: [
      t('d-1', 'human', 1, { status: 'done', closedMinute: 50 }),
      t('d-2', 'self', 2, { status: 'cancelled', closedMinute: 60 }),
    ],
    steps: [
      { args: {} },
      { args: { includeClosed: true } },
      { args: { cursor: cur('d-1'), includeClosed: false } },
    ],
  },
  {
    name: 'list-unreadable-only',
    group: '一覧（空・読めない行）',
    covers:
      '読める task が無く読めない行だけ: 「（読める task は無い）」＋読めない行の注（id の並び）。cursor を付けると、空の entries に cursor を当てた結果（壊れている・includeClosed の食い違い・錨が居ない）が先に出る',
    seed: [],
    hooks: {
      unreadable: [
        { id: 'bad-1', reason: '壊れた行（テスト用）' },
        { id: 'bad-2', reason: '壊れた行（テスト用）' },
      ],
    },
    steps: [
      { args: {} },
      { args: { includeClosed: true } },
      { args: { cursor: cur('bad-1') } },
      { args: { cursor: 'garbage' } },
      { args: { cursor: cur('bad-1', true) } },
    ],
  },
  {
    name: 'list-unreadable-no-id',
    group: '一覧（空・読めない行）',
    covers:
      '読めない行に id が無い: 件数だけ出て「（id: …）」は付かない。id の有る行・無い行の混在は、有るものだけ並べる',
    seed: [],
    steps: [
      {
        args: {},
        hooks: { unreadable: [{ reason: 'id 無し' }, { reason: 'id 無し 2' }] },
      },
      {
        args: {},
        hooks: { unreadable: [{ reason: 'id 無し' }, { id: 'bad-9', reason: 'id 有り' }] },
      },
      {
        args: {},
        hooks: { unreadable: [{ id: 'bad-1', reason: 'id 有り' }] },
      },
    ],
  },
  {
    name: 'list-unreadable-ids-shown',
    group: '一覧（空・読めない行）',
    covers:
      '読めない行の id は 20 件まで: 19・20 件は全部並べ、21 件目から「…ほか n 件は省略」。id の無い行は件数に数えるが id の並びには出ない（22 件のうち 3 件が id 無しなら 19 件を並べて省略なし、24 件のうち 3 件が id 無しなら 20 件を並べて 1 件省略）',
    seed: [],
    steps: [
      ...[19, 20, 21, 25].map((n) => ({
        args: {},
        hooks: {
          unreadable: Array.from({ length: n }, (_, i) => ({
            id: `bad-${pad2(i + 1)}`,
            reason: '壊れ',
          })),
        },
      })),
      {
        args: {},
        hooks: {
          unreadable: [
            ...Array.from({ length: 19 }, (_, i) => ({ id: `bad-${pad2(i + 1)}`, reason: '壊れ' })),
            { reason: 'id 無し' },
            { reason: 'id 無し' },
            { reason: 'id 無し' },
          ],
        },
      },
      {
        args: {},
        hooks: {
          unreadable: [
            ...Array.from({ length: 21 }, (_, i) => ({ id: `bad-${pad2(i + 1)}`, reason: '壊れ' })),
            { reason: 'id 無し' },
            { reason: 'id 無し' },
            { reason: 'id 無し' },
          ],
        },
      },
    ],
  },
  {
    name: 'list-with-unreadable',
    group: '一覧（空・読めない行）',
    covers:
      '読める task と読めない行が両方在る: 一覧の後ろに読めない行の注。cursor より後ろが無い回・予算で切れた回にも注は付く。読める task が在れば「（読める task は無い）」は出ない',
    seed: MIX,
    hooks: {
      unreadable: [
        { id: 'bad-1', reason: '壊れ' },
        { id: 'bad-2', reason: '壊れ' },
      ],
    },
    steps: [
      { args: {} },
      { args: { includeClosed: true } },
      { args: { cursor: cur('self-1') } },
      { args: { cursor: cur('done-2', true), includeClosed: true } },
    ],
  },

  // ---- 一覧: 開いている件・includeClosed・各状態 ----
  {
    name: 'list-mix',
    group: '一覧（開いている件・閉じた件）',
    covers:
      '標準の8件（開いている5件・閉じた3件）。既定・includeClosed=false は開いている5件（先頭が先・見出しが「すべて開いている件」）、includeClosed=true は閉じた件が新しい順で後ろに続く（見出しが変わる）。各件の「n番目 / 状態…」・起点の会話・続く印・閉じた時刻',
    seed: MIX,
    steps: [
      { args: {} },
      { args: { includeClosed: false } },
      { args: { includeClosed: true } },
      { args: { id: undefined, includeClosed: undefined, cursor: undefined, offset: undefined } },
    ],
  },
  {
    name: 'list-statuses',
    group: '一覧（開いている件・閉じた件）',
    covers:
      '各状態の1件ずつ（queued / waiting / needs_decision / done / cancelled）。起点の印は一覧には出ない（全文読みだけ）。起点の会話の有り無しの行',
    seed: [
      t('st-q', 'human', 1, { conv: 'conv-q' }),
      t('st-w', 'manager', 2, { status: 'waiting' }),
      t('st-d', 'external', 3, { status: 'needs_decision', conv: 'conv-d' }),
      t('st-done', 'self', 4, { status: 'done', conv: 'conv-done', closedMinute: 10 }),
      t('st-canc', 'human', 5, { status: 'cancelled', closedMinute: 20 }),
    ],
    steps: [{ args: {} }, { args: { includeClosed: true } }],
  },
  {
    name: 'list-closed-order',
    group: '一覧（開いている件・閉じた件）',
    covers:
      '閉じた件は閉じた時刻の新しい順（作成の順ではない）。同じ時刻は id の順。開いている件の後ろに続く。includeClosed のとき開いている件が無くても閉じた件だけが出る',
    seed: [
      t('cl-a', 'human', 1, { status: 'done', closedMinute: 30 }),
      t('cl-b', 'human', 2, { status: 'done', closedMinute: 10 }),
      t('cl-c', 'human', 3, { status: 'cancelled', closedMinute: 30 }),
      t('cl-d', 'human', 4, { status: 'done', closedMinute: 20 }),
    ],
    steps: [{ args: { includeClosed: true } }],
  },

  // ---- 本文の抜粋 ----
  {
    name: 'list-excerpt-limit',
    group: '本文の抜粋（TASK_BODY_LIMIT）',
    covers:
      '本文 239 / 240 / 241 字: 240 字までは抜粋しない（注記なし）、241 字は 240 字で切って「…（1 文字省略。全 241 文字）」。長い本文は省略した字数と全体の字数が出る',
    seed: [
      t('x-239', 'external', 1, { body: spaced(239) }),
      t('x-240', 'external', 2, { body: spaced(240) }),
      t('x-241', 'external', 3, { body: spaced(241) }),
      t('x-1000', 'external', 4, { body: spaced(1_000) }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-excerpt-astral',
    group: '本文の抜粋（TASK_BODY_LIMIT）',
    covers:
      '補助面の文字は 1 字と数える（コードポイント）: 239 字 + 😀 + x（全 241 字）は 240 字目の 😀 まで残す（割らない・省略 1 文字）。238 字 + 😀 + zz（全 241 字）は 😀 + z まで残す（省略 1 文字）。240 字ちょうどが絵文字で終わるなら切らない',
    seed: [
      t('y-239', 'external', 1, { body: `${spaced(239)}😀x` }),
      t('y-238', 'external', 2, { body: `${spaced(238)}😀zz` }),
      t('y-end', 'external', 3, { body: `${spaced(239)}😀` }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-excerpt-whitespace',
    group: '本文の抜粋（TASK_BODY_LIMIT）',
    covers:
      '空白・改行は1つの空白にたたんで前後を落としてから字数を測る（たたむ前が 240 字を超えていても、たたんだ後が収まれば切らない。たたんだ後が超えれば全体の字数はたたんだ後のもの）。空の本文・空白だけの本文は空の行。題は抜粋せずそのまま（改行を含む）',
    seed: [
      t('w-short', 'human', 1, { body: 'abcdefghi\n\n   '.repeat(22) }),
      t('w-long', 'human', 2, { body: 'abcdefghi\n\n   '.repeat(25) }),
      t('w-empty', 'human', 3, { body: '' }),
      t('w-blank', 'human', 4, { body: ' \n\t ' }),
      t('w-title', 'human', 5, { title: '題の1行目\n題の2行目', body: '本文' }),
      t('w-lead', 'human', 6, { body: '   前後に空白   ' }),
    ],
    steps: [{ args: {} }],
  },

  // ---- 予算（TASK_LIST_BUDGET）----
  {
    name: 'budget-exact-fit',
    group: '予算（TASK_LIST_BUDGET）',
    covers:
      '15 件の字数の合計がちょうど 7,999 / 8,000 字: 全部出る（省略の断り書きなし）。比較は「予算を超えたら切る」（8,000 字ちょうどは超えない）',
    seed: calibrated(15, TASK_LIST_BUDGET),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-under-by-one',
    group: '予算（TASK_LIST_BUDGET）',
    covers: '15 件の字数の合計が 7,999 字: 全部出る',
    seed: calibrated(15, TASK_LIST_BUDGET - 1),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-over-by-one',
    group: '予算（TASK_LIST_BUDGET）',
    covers:
      '15 件の字数の合計が 8,001 字: 最後の1件だけ落ちる（…ほか 1 件は省略。14 件を出した）。続きの cursor は 14 件目の id。cursor で続けると最後の1件が「15番目」として出る',
    seed: calibrated(15, TASK_LIST_BUDGET + 1),
    steps: [{ args: {} }, { args: (previous) => ({ cursor: cursorOf(previous) }) }],
  },
  {
    name: 'budget-first-item-over',
    group: '予算（TASK_LIST_BUDGET）',
    covers:
      '先頭の1件だけで予算を超える（題が 9,000 字）: その1件を抜粋して出し（…（n 文字省略。全 m 文字））、後ろは省略。続きは1件目の id から。cursor で続けると残りが普通に出る',
    seed: [
      t('big-1', 'external', 1, { title: spaced(9_000, 'huge') }),
      t('small-1', 'external', 2),
      t('small-2', 'external', 3),
    ],
    steps: [{ args: {} }, { args: (previous) => ({ cursor: cursorOf(previous) }) }],
  },
  {
    name: 'budget-single-8000',
    group: '予算（TASK_LIST_BUDGET）',
    covers:
      '先頭の1件がちょうど 8,000 字: 抜粋せずそのまま出る（先頭の例外は「予算を超える」ときだけ）。後ろの1件は予算が尽きて省略',
    seed: calibrated(1, TASK_LIST_BUDGET, [t('after-1', 'external', 2)]),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-single-8001',
    group: '予算（TASK_LIST_BUDGET）',
    covers: '先頭の1件が 8,001 字: 抜粋される（1 文字省略）。後ろの1件は省略',
    seed: calibrated(1, TASK_LIST_BUDGET + 1, [t('after-1', 'external', 2)]),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-pages',
    group: '予算（TASK_LIST_BUDGET）',
    covers:
      '45 件を頁で読む: 1頁目（先頭から。「並びの 1 番目から n 件」）→ 案内された cursor で2頁目（「n+1 番目から」）→ 3頁目（最後の頁で省略なし）→ さらに最後の件の cursor で「cursor より後ろの task は無い」。母数（task は 45 件あり）は頁が進んでも動かない（cursor の前の件も含む全件）',
    seed: manyTasks(45),
    steps: [
      { args: {} },
      { args: (previous) => ({ cursor: cursorOf(previous) }) },
      { args: (previous) => ({ cursor: cursorOf(previous) }) },
      { args: { cursor: cur('m-45') } },
    ],
  },
  {
    name: 'budget-pages-include-closed',
    group: '予算（TASK_LIST_BUDGET）',
    covers:
      '開いている 30 件 + 閉じた 20 件を includeClosed=true で頁で読む（cursor にも includeClosed=true が入っている）。頁が開いている件と閉じた件をまたぐ。省略の断り書きに「includeClosed=true のまま呼ぶこと」',
    seed: [
      ...manyTasks(30, 'o'),
      ...manyTasks(20, 'c').map((spec) => ({
        ...spec,
        minute: 100 + spec.minute,
        status: 'done' as const,
        closedMinute: 500 + spec.minute,
      })),
    ],
    steps: [
      { args: { includeClosed: true } },
      { args: (previous) => ({ includeClosed: true, cursor: cursorOf(previous) }) },
      { args: (previous) => ({ includeClosed: true, cursor: cursorOf(previous) }) },
    ],
  },

  // ---- cursor ----
  {
    name: 'cursor-follow',
    group: 'cursor',
    covers:
      '標準の8件で cursor を渡す: 先頭の件（human-1）の次から・途中（「n番目」は cursor の前の件も数えた通し番号）・開いている最後の件（既定の一覧では後ろが無い）。includeClosed=true で開いている最後の件の次から閉じた件だけ（通し番号は開いている件の数から続く）。一覧の最後の件では「cursor より後ろの task は無い」',
    seed: MIX,
    steps: [
      { args: { cursor: cur('human-1') } },
      { args: { cursor: cur('mgr-1') } },
      { args: { cursor: cur('self-1') } },
      { args: { cursor: cur('self-1', true), includeClosed: true } },
      { args: { cursor: cur('done-1', true), includeClosed: true } },
      { args: { cursor: cur('done-2', true), includeClosed: true } },
    ],
  },
  {
    name: 'cursor-malformed',
    group: 'cursor',
    covers:
      'cursor が壊れている: 空文字・base64url でない・JSON でない・JSON が null・数・文字列・配列・id が無い・id が空・id が数・includeClosed が無い・includeClosed が真偽でない。どれも同じ断り（先頭から読み直す案内）。余分な欄が有っても正しければ通る',
    seed: MIX,
    steps: [
      { args: { cursor: '' } },
      { args: { cursor: '!!!' } },
      { args: { cursor: Buffer.from('not json', 'utf8').toString('base64url') } },
      { args: { cursor: rawCursor(null) } },
      { args: { cursor: rawCursor(5) } },
      { args: { cursor: rawCursor('human-1') } },
      { args: { cursor: rawCursor([]) } },
      { args: { cursor: rawCursor({ includeClosed: false }) } },
      { args: { cursor: rawCursor({ id: '', includeClosed: false }) } },
      { args: { cursor: rawCursor({ id: 5, includeClosed: false }) } },
      { args: { cursor: rawCursor({ id: 'human-1' }) } },
      { args: { cursor: rawCursor({ id: 'human-1', includeClosed: 'false' }) } },
      { args: { cursor: rawCursor({ id: 'human-1', includeClosed: false, extra: 1 }) } },
    ],
  },
  {
    name: 'cursor-mismatch',
    group: 'cursor',
    covers:
      'cursor の includeClosed と引数の includeClosed の食い違い（cursor=真・引数なし / cursor=真・引数=偽 / cursor=偽・引数=真）: 揃えて呼び直す案内に、cursor の側の値と cursor がそのまま入る。食い違いは錨の有無より先に判定する（錨が無い id でも食い違いの断り）',
    seed: MIX,
    steps: [
      { args: { cursor: cur('human-1', true) } },
      { args: { cursor: cur('human-1', true), includeClosed: false } },
      { args: { cursor: cur('human-1', false), includeClosed: true } },
      { args: { cursor: cur('no-such', true) } },
    ],
  },
  {
    name: 'cursor-anchor-gone',
    group: 'cursor',
    covers:
      'cursor の指す task が居ない: 無い id・既定の一覧に居ない閉じた件（includeClosed=false の cursor で閉じた件の id）・錨が呼ぶ前に閉じられた・錨が消された（会話ごと消えた）。同じ cursor でも includeClosed=true の一覧なら錨が居るので続きが出る',
    seed: MIX,
    steps: [
      { args: { cursor: cur('no-such') } },
      { args: { cursor: cur('done-1') } },
      {
        args: { cursor: cur('mgr-1') },
        before: async (base) => {
          await base.tasks.setStatus('mgr-1', 'done', {
            reason: '別の経路が閉じた',
            by: 'human',
            at: '2026-10-28T00:00:00.000Z',
          });
        },
      },
      { args: { cursor: cur('mgr-1', true), includeClosed: true } },
      {
        args: { cursor: cur('self-1') },
        before: async (base) => {
          await base.tasks.removeForConversation('conv-s1');
        },
      },
    ],
  },
  {
    name: 'cursor-after-last',
    group: 'cursor',
    covers:
      '最後の件の cursor（一覧の後ろに何も無い）: 「（cursor より後ろの task は無い。これが最後の頁）」だけ。読めない行の注は付く（上の list-with-unreadable）。1件だけの一覧でその1件を錨にした場合も同じ',
    seed: [t('only-1', 'human', 1)],
    steps: [{ args: {} }, { args: { cursor: cur('only-1') } }],
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
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
}

interface PinnedStep {
  output: PinnedOutput;
  /** task の行・日誌が呼ぶ前から変わったか（読むだけの道具なので全場面で false） */
  wrote: boolean;
  /** 呼びの間に呼ばれたストアの書き込み口（全場面で空） */
  writeCalls: string[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function snapshot(stores: Stores): Promise<{ tasks: Task[]; journalCount: number }> {
  return {
    tasks: plain((await stores.tasks.list({ includeClosed: true })).entries),
    journalCount: (await stores.journal.list({ order: 'asc' })).length,
  };
}

function recorded<A extends unknown[], R>(
  calls: string[],
  name: string,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    calls.push(name);
    return fn(...args);
  };
}

function withHooks(base: Stores, hooks: () => Hooks, calls: string[]): Stores {
  const tasks: Stores['tasks'] = {
    ...base.tasks,
    list: async (options) => {
      const now = hooks();
      if (now.listFails === true) throw new Error('task の一覧が読めない');
      const listed = await base.tasks.list(options);
      if (now.unreadable === undefined) return listed;
      return { entries: listed.entries, unreadable: now.unreadable };
    },
    get: async (id) => {
      const now = hooks();
      if (now.getUnreadable?.includes(id) === true) {
        throw new UnreadableTaskError('読めない行（テスト用）');
      }
      if (now.getThrows?.includes(id) === true) throw new Error('ストアが落ちた');
      return base.tasks.get(id);
    },
    add: recorded(calls, 'tasks.add', base.tasks.add),
    move: recorded(calls, 'tasks.move', base.tasks.move),
    setStatus: recorded(calls, 'tasks.setStatus', base.tasks.setStatus),
    setKeep: recorded(calls, 'tasks.setKeep', base.tasks.setKeep),
    edit: recorded(calls, 'tasks.edit', base.tasks.edit),
    clear: recorded(calls, 'tasks.clear', base.tasks.clear),
    removeForConversation: recorded(
      calls,
      'tasks.removeForConversation',
      base.tasks.removeForConversation,
    ),
  };
  return {
    ...base,
    tasks,
    journal: { ...base.journal, append: recorded(calls, 'journal.append', base.journal.append) },
  };
}

async function seedTasks(base: Stores, seed: readonly SeedTask[]): Promise<void> {
  for (const spec of seed) {
    const closing = spec.status === 'done' || spec.status === 'cancelled';
    const status = spec.status === undefined || closing ? 'queued' : spec.status;
    const task: Task = {
      ...toTask(spec),
      updatedAt: status === 'queued' ? minuteIso(spec.minute) : SEED_UPDATED_ISO,
      status,
    };
    await base.tasks.add(task);
    if (spec.keep === true) await base.tasks.setKeep(spec.id, true);
    if (closing && spec.status !== undefined) {
      await base.tasks.setStatus(spec.id, spec.status, {
        ...(spec.noReason === true ? {} : { reason: '先に閉じた' }),
        by: spec.by === 'none' ? (undefined as never) : (spec.by ?? 'human'),
        at: minuteIso(spec.closedMinute ?? spec.minute + 100),
      });
    }
  }
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedTasks(base, scenario.seed);
  let hooks: Hooks = {};
  const calls: string[] = [];
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'task_list');
  if (!found) throw new Error('task_list が無い');

  const results: PinnedStep[] = [];
  let previous = '';
  for (const [index, step] of scenario.steps.entries()) {
    if (step.before !== undefined) await step.before(base);
    hooks = { ...scenario.hooks, ...step.hooks };
    const before = await snapshot(base);
    calls.length = 0;
    const args = typeof step.args === 'function' ? step.args(previous) : step.args;
    let output: PinnedOutput;
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = { length: text.length, text, isError: result.isError === true, thrown: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = { length: text.length, text, isError: true, thrown: true };
    }
    previous = output.text;
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.tasks) !== JSON.stringify(after.tasks) ||
      before.journalCount !== after.journalCount;
    // 読むだけの道具: task の行・日誌が呼ぶ前と同じで、書き込み口も呼ばれていない
    expect(
      after.tasks,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、task が呼ぶ前から変わった`,
    ).toEqual(before.tasks);
    expect(
      after.journalCount,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、日誌に行が足された`,
    ).toBe(before.journalCount);
    expect(
      calls,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、書き込み口が呼ばれた`,
    ).toEqual([]);
    results.push({ output, wrote, writeCalls: [...calls] });
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

describe('task_list の出力の固定（場面ごとの全文と字数・読むだけで書かないこと）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

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
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  }, 60_000);

  afterAll(() => {
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

  it('読むだけの道具: 全場面で task・日誌が変わらず、書き込み口も呼ばれていない', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 書き込みが起きた`).toBe(false);
      expect(actual[key]?.writeCalls, `${key}: 書き込み口が呼ばれた`).toEqual([]);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote`).toBe(false);
      expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
    }
  });

  describe.each(SCENARIOS)('場面 $name（$group）', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const before = (key: string, first: string, second: string): boolean =>
      text(key).indexOf(first) >= 0 && text(key).indexOf(first) < text(key).indexOf(second);
    const NO_TASK = '（task は無い）';
    const LAST_PAGE = '（cursor より後ろの task は無い。これが最後の頁）';
    const MALFORMED = 'cursor が壊れている（この道具が返したものではないか、書き換えられている）';
    const GONE = 'cursor が指していた task は、いまの一覧に居ない';
    const OPEN_HEADER = '（以下はすべて開いている件。上が先）';
    const ALL_HEADER = '（上から並び順。開いている件の後ろに、閉じた件が新しい順で続く）';
    // 引数の検査
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(text(`arg-offset#${String(n)}`)).toContain('は使えない（0以上の整数のみ）。');
    }
    expect(text('arg-offset#9')).toContain('t-1 仕事 t-1');
    expect(text('arg-offset#10')).toContain(OPEN_HEADER);
    // id: 無い・読めない
    expect(text('id-missing#1')).toBe(
      'task no-such は無い（task_list で実在する id を確かめること）。',
    );
    expect(text('id-missing#2')).toBe('task  は無い（task_list で実在する id を確かめること）。');
    expect(text('id-missing#3')).toBe(text('id-missing#1'));
    expect(text('id-unreadable#1')).toContain('読めない形で入っている（無いのとは違う）');
    expect(text('id-unreadable#3')).toContain('human-1 人間の依頼 1');
    expect(text('id-store-error#1')).toBe('ストアが落ちた');
    expect(actual['id-store-error#1']?.output.thrown).toBe(true);
    expect(text('id-store-error#2')).toContain('読めない形で入っている');
    expect(actual['id-store-error#2']?.output.thrown).toBe(false);
    // id: 起点の印・状態・閉じた記録
    expect(text('id-each-task#1')).toContain('[人間の依頼 / thread-9]');
    expect(text('id-each-task#1')).toContain('起点の会話: conv-h1');
    expect(text('id-each-task#1')).toContain(
      '状態: queued（待ち行列） / 続く（返答しても自動で閉じない）',
    );
    expect(text('id-each-task#2')).toContain('[人間の依頼]\n');
    expect(text('id-each-task#2')).not.toContain('起点の会話');
    expect(text('id-each-task#3')).toContain('[マネージャーの報告 / mgr-77]');
    expect(text('id-each-task#3')).toContain('状態: waiting（待ち（外の返事・時間待ち））');
    expect(text('id-each-task#4')).toContain('[外部イベント / ci-watch]');
    expect(text('id-each-task#4')).toContain('状態: needs_decision（決めてほしい）');
    expect(text('id-each-task#5')).toContain('[自分で気づいた宿題]');
    expect(text('id-each-task#6')).toContain(
      // 閉じた時刻の前の区切りは「）/ 」（空白が無い）。続く印の前は「 / 」。現状の文言のまま固定する
      '状態: done（終わった）/ 2026-10-01T03:20:00.000Z に閉じた',
    );
    expect(text('id-each-task#6')).toContain(
      '閉じた理由: 閉じた時刻=2026-10-01T03:20:00.000Z / 閉じた主体=human / 理由=先に閉じた',
    );
    expect(text('id-each-task#6')).not.toContain('続く');
    expect(text('id-each-task#7')).toContain('状態: cancelled（取りやめた）');
    expect(text('id-each-task#7')).toContain('閉じた主体=daemon / 理由=（理由の記録なし）');
    expect(text('id-each-task#8')).toContain('閉じた主体=（記録なし）');
    expect(text('id-each-task#8')).toContain('に閉じた / 続く（返答しても自動で閉じない）');
    expect(text('id-closed-variants#3')).toContain('閉じた主体=clone');
    expect(text('id-open-keep#2')).toContain('waiting（待ち（外の返事・時間待ち）） / 続く');
    expect(text('id-open-keep#4')).not.toContain('続く');
    expect(text('id-text-shape#1')).toContain('s-multi 題の1行目\n題の2行目\n');
    expect(text('id-text-shape#1')).toContain('本文（全文）: 一行目\n\n  二行目\t三行目\n');
    expect(text('id-text-shape#4')).not.toContain('省略');
    // id: 頁
    expect(text('id-offset-small#1')).toContain('（全 18 文字）');
    expect(text('id-offset-small#2')).toContain('4〜18 文字目 / 全 18 文字');
    expect(text('id-offset-small#4')).toContain('18〜18 文字目 / 全 18 文字');
    expect(text('id-offset-small#5')).toContain('全 18 文字の末尾を越えている');
    expect(text('id-offset-small#7')).toContain('全 18 文字の末尾を越えている');
    expect(text('id-offset-small#1')).not.toContain('ここで切れている');
    expect(text('id-page-edge#1')).toContain('（全 7,999 文字）');
    expect(text('id-page-edge#2')).toContain('（全 8,000 文字）');
    expect(text('id-page-edge#2')).not.toContain('ここで切れている');
    expect(text('id-page-edge#3')).toContain('2〜8,000 文字目 / 全 8,000 文字');
    expect(text('id-page-edge#4')).toContain('1〜8,000 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#4')).toContain('続きは task_list id=e-8001 offset=8000）');
    expect(text('id-page-edge#5')).toContain('2〜8,001 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#5')).not.toContain('ここで切れている');
    expect(text('id-page-edge#6')).toContain('3〜8,001 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#7')).toContain('8,001〜8,001 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#8')).toContain('全 8,001 文字の末尾を越えている');
    expect(text('id-page-three#1')).toContain('offset=8000）');
    expect(text('id-page-three#2')).toContain('8,001〜16,000 文字目 / 全 16,001 文字');
    expect(text('id-page-three#2')).toContain('offset=16000）');
    expect(text('id-page-three#3')).toContain('16,001〜16,001 文字目 / 全 16,001 文字');
    expect(text('id-page-three#4')).toContain('全 16,001 文字の末尾を越えている');
    expect(text('id-page-astral#1')).toContain('1〜7,999 文字目 / 全 8,005 文字');
    expect(text('id-page-astral#1')).toContain('offset=7999）');
    expect(text('id-page-astral#2')).toContain('8,000〜8,005 文字目 / 全 8,005 文字');
    expect(text('id-page-astral#2')).toContain('😀tail');
    expect(text('id-page-closed#1')).toMatch(/^z-1 仕事 z-1/);
    expect(text('id-page-closed#1')).toContain('閉じた理由: 閉じた時刻=');
    expect(text('id-page-closed#1')).toContain('offset=8000）');
    expect(text('id-page-closed#2')).not.toContain('ここで切れている');
    expect(text('id-page-closed#3')).toContain('状態: cancelled（取りやめた）');
    for (const n of [2, 3, 4]) {
      expect(text(`id-ignores-list-args#${String(n)}`)).toBe(text('id-ignores-list-args#1'));
    }
    // 一覧: 空・読めない行
    for (const n of [1, 2, 3, 4, 5, 6]) expect(text(`list-empty#${String(n)}`)).toBe(NO_TASK);
    expect(text('list-only-closed#1')).toBe(NO_TASK);
    expect(text('list-only-closed#2')).toContain('d-2');
    expect(text('list-only-closed#3')).toBe(NO_TASK);
    expect(text('list-unreadable-only#1')).toBe(
      '（読める task は無い）\n**読めない行が 2 件ある（id: bad-1, bad-2）。終わったのではない。**',
    );
    expect(text('list-unreadable-only#3')).toContain(GONE);
    expect(text('list-unreadable-only#4')).toContain(MALFORMED);
    expect(text('list-unreadable-only#5')).toContain('cursor は includeClosed=true の一覧から出た');
    expect(text('list-unreadable-no-id#1')).toBe(
      '（読める task は無い）\n**読めない行が 2 件ある。終わったのではない。**',
    );
    expect(text('list-unreadable-no-id#2')).toContain('読めない行が 2 件ある（id: bad-9）');
    expect(text('list-unreadable-ids-shown#1')).toContain('bad-19）');
    expect(text('list-unreadable-ids-shown#1')).not.toContain('ほか');
    expect(text('list-unreadable-ids-shown#2')).toContain('bad-20）');
    expect(text('list-unreadable-ids-shown#2')).not.toContain('ほか');
    expect(text('list-unreadable-ids-shown#3')).toContain('bad-20 …ほか 1 件は省略）');
    expect(text('list-unreadable-ids-shown#3')).not.toContain('bad-21');
    expect(text('list-unreadable-ids-shown#4')).toContain('…ほか 5 件は省略');
    expect(text('list-unreadable-ids-shown#5')).toContain('読めない行が 22 件ある（id: bad-01,');
    expect(text('list-unreadable-ids-shown#5')).toContain('bad-19）');
    expect(text('list-unreadable-ids-shown#5')).not.toContain('ほか');
    expect(text('list-unreadable-ids-shown#6')).toContain('読めない行が 24 件ある');
    expect(text('list-unreadable-ids-shown#6')).toContain('bad-20 …ほか 1 件は省略）');
    expect(text('list-with-unreadable#1')).toContain(OPEN_HEADER);
    expect(text('list-with-unreadable#1')).toContain('読めない行が 2 件ある（id: bad-1, bad-2）');
    expect(text('list-with-unreadable#1')).not.toContain('読める task は無い');
    expect(text('list-with-unreadable#3')).toContain(LAST_PAGE);
    expect(text('list-with-unreadable#3')).toContain('読めない行が 2 件ある');
    expect(text('list-with-unreadable#4')).toContain(LAST_PAGE);
    // 一覧: 開いている件・閉じた件
    expect(text('list-mix#1')).toContain(OPEN_HEADER);
    expect(text('list-mix#1')).toContain(
      '  1番目 / 状態: queued（待ち行列） / 続く（返答しても自動で閉じない）',
    );
    expect(text('list-mix#1')).toContain('  起点の会話: conv-h1');
    expect(text('list-mix#1')).toContain('  5番目 / 状態: queued（待ち行列）');
    expect(text('list-mix#1')).not.toContain('done-1');
    expect(text('list-mix#2')).toBe(text('list-mix#1'));
    expect(text('list-mix#4')).toBe(text('list-mix#1'));
    expect(text('list-mix#3')).toContain(ALL_HEADER);
    expect(text('list-mix#3')).not.toContain(OPEN_HEADER);
    expect(text('list-mix#3')).toContain('  8番目 / 状態: done（終わった）/ ');
    expect(before('list-mix#3', '- canc-1 ', '- done-1 ')).toBe(true);
    expect(before('list-mix#3', '- done-1 ', '- done-2 ')).toBe(true);
    expect(before('list-mix#3', '- self-1 ', '- canc-1 ')).toBe(true);
    expect(text('list-statuses#1')).not.toContain('done');
    expect(text('list-statuses#2')).toContain('状態: cancelled（取りやめた）/ ');
    expect(text('list-statuses#2')).toContain('状態: needs_decision（決めてほしい）');
    expect(before('list-closed-order', '- cl-a ', '- cl-c ')).toBe(true);
    expect(before('list-closed-order', '- cl-c ', '- cl-d ')).toBe(true);
    expect(before('list-closed-order', '- cl-d ', '- cl-b ')).toBe(true);
    // 本文の抜粋
    expect(count(text('list-excerpt-limit'), '文字省略。全 ')).toBe(2);
    expect(text('list-excerpt-limit')).toContain('…（1 文字省略。全 241 文字）');
    expect(text('list-excerpt-limit')).toContain('全 1,000 文字）');
    expect(text('list-excerpt-limit')).not.toContain('全 240 文字');
    expect(count(text('list-excerpt-astral'), '文字省略。全 ')).toBe(2);
    expect(text('list-excerpt-astral')).toContain('😀…（1 文字省略。全 241 文字）');
    expect(text('list-excerpt-astral')).toContain('😀z…（1 文字省略。全 241 文字）');
    expect(count(text('list-excerpt-whitespace'), '文字省略。全 ')).toBe(1);
    expect(text('list-excerpt-whitespace')).toContain('全 249 文字）');
    expect(text('list-excerpt-whitespace')).toContain('- w-title 題の1行目\n題の2行目\n');
    // 予算
    for (const key of ['budget-exact-fit', 'budget-under-by-one']) {
      expect(text(key)).not.toContain('…ほか');
      expect(text(key)).toContain('  15番目 / ');
      expect(text(key)).toContain('（本文は240字の抜粋。1件の全文は task_list id=<id> で取れる）');
    }
    expect(text('budget-over-by-one#1')).toContain(
      '…ほか 1 件は省略（task は 15 件あり、並びの 1 番目から 14 件だけ出した。',
    );
    expect(text('budget-over-by-one#1')).toContain(`task_list cursor=${cur('b-14')} で取れる`);
    expect(text('budget-over-by-one#1')).toContain('includeClosed=false のまま呼ぶこと）。');
    expect(text('budget-over-by-one#1')).not.toContain('  15番目 / ');
    expect(text('budget-over-by-one#2')).toContain('  15番目 / ');
    expect(text('budget-over-by-one#2')).not.toContain('  14番目 / ');
    expect(text('budget-over-by-one#2')).not.toContain('…ほか');
    expect(text('budget-first-item-over#1')).toContain('文字省略。全 ');
    expect(text('budget-first-item-over#1')).toContain(
      '…ほか 2 件は省略（task は 3 件あり、並びの 1 番目から 1 件だけ出した。',
    );
    expect(text('budget-first-item-over#1')).toContain(`cursor=${cur('big-1')} で取れる`);
    expect(text('budget-first-item-over#2')).toContain('  2番目 / ');
    expect(text('budget-first-item-over#2')).toContain('  3番目 / ');
    expect(text('budget-single-8000')).not.toContain('文字省略');
    expect(text('budget-single-8000')).toContain('…ほか 1 件は省略（task は 2 件あり');
    expect(text('budget-single-8001')).toContain('…（1 文字省略。全 8,001 文字）');
    expect(text('budget-pages#1')).toContain('並びの 1 番目から 20 件だけ出した');
    expect(text('budget-pages#1')).toContain(`cursor=${cur('m-20')} で取れる`);
    expect(text('budget-pages#2')).toContain(
      'task は 45 件あり、並びの 21 番目から 20 件だけ出した',
    );
    expect(text('budget-pages#2')).toContain('…ほか 5 件は省略');
    expect(text('budget-pages#3')).toContain('  45番目 / ');
    expect(text('budget-pages#3')).not.toContain('…ほか');
    expect(text('budget-pages#4')).toBe(LAST_PAGE);
    expect(text('budget-pages-include-closed#1')).toContain(ALL_HEADER);
    expect(text('budget-pages-include-closed#1')).toContain('includeClosed=true のまま呼ぶこと');
    expect(text('budget-pages-include-closed#2')).toContain('並びの 21 番目から 19 件だけ出した');
    expect(text('budget-pages-include-closed#3')).toContain('  50番目 / ');
    expect(text('budget-pages-include-closed#3')).not.toContain('…ほか');
    // cursor
    expect(text('cursor-follow#1')).toContain('  2番目 / ');
    expect(text('cursor-follow#1')).not.toContain('- human-1 ');
    expect(text('cursor-follow#2')).toContain('  4番目 / ');
    expect(text('cursor-follow#2')).not.toContain('- mgr-1 ');
    expect(text('cursor-follow#3')).toBe(LAST_PAGE);
    expect(text('cursor-follow#4')).toContain('  6番目 / ');
    expect(text('cursor-follow#4')).toContain(ALL_HEADER);
    expect(text('cursor-follow#4')).not.toContain('- self-1 ');
    expect(text('cursor-follow#5')).toContain('  8番目 / ');
    expect(text('cursor-follow#5')).not.toContain('  7番目 / ');
    expect(text('cursor-follow#6')).toBe(LAST_PAGE);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(text(`cursor-malformed#${String(n)}`)).toContain(MALFORMED);
    }
    expect(text('cursor-malformed#13')).toContain('  2番目 / ');
    expect(text('cursor-mismatch#1')).toContain(
      'cursor は includeClosed=true の一覧から出た続きの位置。',
    );
    expect(text('cursor-mismatch#1')).toContain(
      `task_list includeClosed=true cursor=${cur('human-1', true)} のように揃えて呼び直すか、`,
    );
    expect(text('cursor-mismatch#2')).toBe(text('cursor-mismatch#1'));
    expect(text('cursor-mismatch#3')).toContain(
      'cursor は includeClosed=false の一覧から出た続きの位置。',
    );
    expect(text('cursor-mismatch#4')).toContain(`cursor=${cur('no-such', true)} のように`);
    for (const key of [
      'cursor-anchor-gone#1',
      'cursor-anchor-gone#2',
      'cursor-anchor-gone#3',
      'cursor-anchor-gone#5',
    ]) {
      expect(text(key)).toContain(GONE);
    }
    expect(text('cursor-anchor-gone#4')).toContain('  6番目 / ');
    expect(text('cursor-anchor-gone#4')).not.toContain('- mgr-1 ');
    expect(text('cursor-after-last#1')).toContain('- only-1 ');
    expect(text('cursor-after-last#2')).toBe(LAST_PAGE);
  });
});
