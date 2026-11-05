import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `task_add` の出力（全文と字数）と、呼んだあとの状態（task の行・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-task-add-output-pin.json）と丸ごと比べる。
// `clone-tools-task.ts` の `tool('task_add', …)`（ハンドラ約 68 行）の長い式を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の本文）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか。例外なら message が text）
//   - tasks: 呼んだあとの task の行を、ストアから読んだ形のまま（閉じた行を含む全件・並び順のまま）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま。書けなかった行は含まない）
//   - calls: ストアの呼びの並び（tasks.add（渡した行と置き場所と結果）・tasks.get・journal.append（行の全体と成否））
//   - uuidsDrawn: この呼びが randomUUID を何回引いたか
//   - wrote: task か日誌のどちらかが呼ぶ前から変わったか。断った場面は false で、task・日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_ADD_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-add-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-add-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、task・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。呼びごとに基準時刻から 1 分ずつ進めて呼ぶ。
// 乱数: task の id と、起点の会話 id の補い（getWorkConversationId() が無いとき）は `randomUUID()` で作られるので、
// `node:crypto` の randomUUID を呼び順に 00000000-0000-4000-8000-000000000001, …02, … を返すものへ差し替える。
// 番号は場面ごとに 1 から数え直す（場面の中では呼びをまたいで進む）。起点の会話 id の補いは task の id より先に引かれる。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
//
// 足したのに確かめられない場面（existed・読み直しで null・読めない）は、ストアの口（Hooks）で作る。
// 行は書けている（existed の自然な場面だけは既存の行のまま）のに日誌が無い、という今の振る舞いをそのまま固定する。
//
// 作れない分岐（理由）:
//   - `added.kind === 'existed'` かつ読み直しが null / 読めない / 例外: existed のときは読み直しの結果にかかわらず同じ断りの文になる
//     （読み直しの例外だけは先に投げる）。existed の場面は、読み直しが見つかる場合と、例外の場合（get 失敗の口と併用）を作る。
//   - `resolveTaskPlacement` が返す `{ kind: 'ok', placement: undefined }` 以外で anchorId が空文字になる before / after:
//     空文字は invalid（to=before には anchorId が要る）として断られるので、ストアへ届く anchorId は常に1文字以上。

const uuidState = vi.hoisted(() => ({ drawn: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
      uuidState.drawn += 1;
      return `00000000-0000-4000-8000-${String(uuidState.drawn).padStart(12, '0')}`;
    },
  };
});

function u(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

type Args = Record<string, unknown>;

type Failure = 'unreadable' | 'plain';

interface SeedTask {
  id: string;
  /** createdAt（基準から何分後か） */
  minute: number;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
}

/** 起点の会話 id の出どころ（ToolContext の組み方） */
interface Ctx {
  /** conversationId が返す値 */
  conversationId?: string;
  /** workConversationId: 省略 = 渡さない（conversationId へ倒れる） / null = 渡すが undefined を返す / 文字列 = その値を返す */
  work?: string | null;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** tasks.add が落ちる */
  addFails?: boolean;
  /** tasks.add は本当に書いたうえで、結果だけ existed と返す（書き込みが静かに食い違った状況） */
  addReportsExisted?: boolean;
  /** 書いたあとの tasks.get: null を返す / 読めない形で落ちる / ほかの例外で落ちる */
  getResult?: 'null' | Failure;
  /** この呼びの journal.append の何回目（1 から）を投げさせるか */
  journalFailsAt?: number[];
}

interface Step {
  args: Args;
  /** task か日誌が書き換わるか。false と宣言した呼びは、呼ぶ前と task・日誌が同じであることを確かめる */
  writes: boolean;
  ctx?: Ctx;
  hooks?: Hooks;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedTask[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const TASK_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const SEED_UPDATED_ISO = '2026-10-02T00:00:00.000Z';
const SEED_CLOSED_ISO = '2026-10-03T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-task-add-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_ADD_PIN === '1';

/** 既定の ctx: いまのターンの会話（workConversationId として渡す） */
const WORK: Ctx = { work: 'conv-work-1' };
/** どちらの会話も無い（workConversationId は undefined を返し、conversationId も undefined） */
const NO_CONV: Ctx = { work: null };

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteIso(minute: number): string {
  return new Date(TASK_BASE + minute * 60_000).toISOString();
}

function t(id: string, minute: number, status?: SeedTask['status']): SeedTask {
  return status === undefined ? { id, minute } : { id, minute, status };
}

function add(title: string, body: string, extra: Args = {}): Args {
  return { title, body, ...extra };
}

const TITLE_200 = 'あ'.repeat(200);
const TITLE_201 = 'あ'.repeat(201);

const OPEN_SEED: SeedTask[] = [
  t('q-1', 1),
  t('q-2', 2),
  t('w-1', 3, 'waiting'),
  t('n-1', 4, 'needs_decision'),
  t('q-3', 5),
  t('d-1', 6, 'done'),
  t('c-1', 7, 'cancelled'),
];

const SCENARIOS: Scenario[] = [
  // ---- title の検査 ----
  {
    name: 'title-invalid',
    covers:
      'title が使えない: 201 文字・空・NUL だけ・空白だけ（半角・全角・改行とタブ）・改行を含む（\\n と \\r）。長さの検査が先で、次に空白だけ、最後に改行。断りの文。task・日誌・ストアの呼びは何も無い（randomUUID も引かない）',
    seed: [t('q-1', 1)],
    steps: [
      { args: add(TITLE_201, '本文'), writes: false },
      { args: add('', '本文'), writes: false },
      { args: add('\u0000', '本文'), writes: false },
      { args: add('   ', '本文'), writes: false },
      { args: add('　\t', '本文'), writes: false },
      { args: add('\n', '本文'), writes: false },
      { args: add('一行目\n二行目', '本文'), writes: false },
      { args: add('一行目\r二行目', '本文'), writes: false },
      { args: add('一行目\r\n', '本文'), writes: false },
      { args: add(`${TITLE_200}\n`, '本文'), writes: false },
      { args: add('\u0000'.repeat(201), '本文'), writes: false },
    ],
  },
  // ---- body の検査 ----
  {
    name: 'body-invalid',
    covers:
      'body が使えない: 空・NUL だけ・空白だけ（半角・全角・改行とタブ）。長さの上限は無い。title の検査は先に通る。断りの文。何も呼ばない',
    seed: [t('q-1', 1)],
    steps: [
      { args: add('題', ''), writes: false },
      { args: add('題', '\u0000'), writes: false },
      { args: add('題', '   '), writes: false },
      { args: add('題', '\n\t　'), writes: false },
      { args: add('', ''), writes: false },
      { args: add('一行目\n二行目', ''), writes: false },
    ],
  },
  // ---- source の検査 ----
  {
    name: 'source-invalid',
    covers:
      'source が空・空白だけ・NUL だけ（渡したのに実のある文字が無い）: 断りの文。省略（undefined）は断らない。title・body の検査が先。何も呼ばない',
    seed: [t('q-1', 1)],
    steps: [
      { args: add('題', '本文', { source: '' }), writes: false },
      { args: add('題', '本文', { source: '   ' }), writes: false },
      { args: add('題', '本文', { source: '\u0000' }), writes: false },
      { args: add('題', '本文', { source: '\n\t　\u0000' }), writes: false },
      { args: add('', '本文', { source: '' }), writes: false },
      { args: add('題', '', { source: '' }), writes: false },
    ],
  },
  {
    name: 'source-ok',
    covers:
      'source の通る形: 省略（行に source の鍵が無い）・明示 undefined（同じ）・実のある文字列（行に入る）・前後の空白付き（trim せずそのまま入る）・NUL 混じり（行へ入る形を固定）。置き場所は既定',
    seed: [],
    steps: [
      { args: add('source なし', '本文 1'), writes: true, ctx: NO_CONV },
      {
        args: add('source undefined', '本文 2', { source: undefined }),
        writes: true,
        ctx: NO_CONV,
      },
      { args: add('source あり', '本文 3', { source: 'mgr-1' }), writes: true, ctx: NO_CONV },
      {
        args: add('source 空白付き', '本文 4', { source: '  mgr-2  ' }),
        writes: true,
        ctx: NO_CONV,
      },
      {
        args: add('source NUL 混じり', '本文 5', { source: 'mgr\u00003' }),
        writes: true,
        ctx: NO_CONV,
      },
    ],
  },
  // ---- 通る title / body の形 ----
  {
    name: 'text-forms',
    covers:
      'title・body の通る形: title ちょうど 200 文字・title の前後の空白・NUL 混じり（行と日誌へ入る形）・body の複数行・前後の空白（trim しない）・長い body（240 文字を超えても全文が日誌の grounds へ入る）',
    seed: [],
    steps: [
      { args: add(TITLE_200, '本文'), writes: true },
      { args: add('  前後に空白  ', '  本文の前後も空白  \n'), writes: true },
      { args: add('NUL\u0000混じり', '本\u0000文'), writes: true },
      { args: add('複数行の本文', '一行目\n二行目\r\n三行目'), writes: true },
      { args: add('長い本文', 'あ'.repeat(500)), writes: true },
      { args: add('同じ題', '同じ本文'), writes: true },
      { args: add('同じ題', '同じ本文'), writes: true },
    ],
  },
  // ---- 置き場所の食い違い ----
  {
    name: 'placement-invalid',
    covers:
      'to と anchorId の組み合わせが食い違う（resolveTaskPlacement が invalid）: anchorId だけ・to=before / after に anchorId が無い（undefined・空文字）・to=front / back に anchorId（空文字も）。断りの文。何も呼ばない。title・body・source の検査より後',
    seed: [t('q-1', 1)],
    steps: [
      { args: add('題', '本文', { anchorId: 'q-1' }), writes: false },
      { args: add('題', '本文', { anchorId: '' }), writes: false },
      { args: add('題', '本文', { to: 'before' }), writes: false },
      { args: add('題', '本文', { to: 'after' }), writes: false },
      { args: add('題', '本文', { to: 'before', anchorId: '' }), writes: false },
      { args: add('題', '本文', { to: 'after', anchorId: '' }), writes: false },
      { args: add('題', '本文', { to: 'front', anchorId: 'q-1' }), writes: false },
      { args: add('題', '本文', { to: 'back', anchorId: 'q-1' }), writes: false },
      { args: add('題', '本文', { to: 'front', anchorId: '' }), writes: false },
      { args: add('題', '本文', { to: 'back', anchorId: '' }), writes: false },
      { args: add('', '本文', { to: 'before' }), writes: false },
      { args: add('題', '本文', { source: ' ', to: 'before' }), writes: false },
    ],
  },
  // ---- 置き場所 ----
  {
    name: 'placement-ok',
    covers:
      '置き場所の成功: 省略（既定の位置）・front・back・before / after（先頭・途中・末尾の件を基準に）・基準が waiting / needs_decision の開いた件。日誌の grounds に置き場所の文（既定の位置・先頭・末尾・<id> の直前 / 直後）。行の並びは呼びごとに積み上がる。tasks.get は書いたあとに1回',
    seed: OPEN_SEED,
    steps: [
      { args: add('既定', '省略'), writes: true },
      { args: add('先頭へ', 'front', { to: 'front' }), writes: true },
      { args: add('末尾へ', 'back', { to: 'back' }), writes: true },
      { args: add('q-2 の前', 'before', { to: 'before', anchorId: 'q-2' }), writes: true },
      { args: add('q-2 の後', 'after', { to: 'after', anchorId: 'q-2' }), writes: true },
      { args: add('w-1 の前', 'before waiting', { to: 'before', anchorId: 'w-1' }), writes: true },
      {
        args: add('n-1 の後', 'after needs_decision', { to: 'after', anchorId: 'n-1' }),
        writes: true,
      },
      { args: add('先頭の件の前', 'before first', { to: 'before', anchorId: u(2) }), writes: true },
      { args: add('末尾の件の後', 'after last', { to: 'after', anchorId: u(3) }), writes: true },
    ],
  },
  {
    name: 'placement-empty-store',
    covers:
      '開いた件が無いところへ足す: 既定・front・back のそれぞれ（別の場面で空から始める代わりに、同じ場面で積む）。閉じた件だけが在るところへの既定の位置',
    seed: [t('d-1', 1, 'done'), t('c-1', 2, 'cancelled')],
    steps: [
      { args: add('閉じた件だけの中へ', '既定'), writes: true },
      { args: add('先頭へ', 'front', { to: 'front' }), writes: true },
      { args: add('末尾へ', 'back', { to: 'back' }), writes: true },
    ],
  },
  {
    name: 'anchor-missing',
    covers:
      '基準の task が開いていない（anchor-not-found）: 無い id・閉じた件（done・cancelled）を before / after で指す。断りの文（anchorId をそのまま出す）。tasks.add までは呼ぶ（行は書かれない）ので randomUUID は2つ引かれ、tasks.get・日誌は呼ばない',
    seed: OPEN_SEED,
    steps: [
      { args: add('題', '本文', { to: 'before', anchorId: 'ghost' }), writes: false },
      { args: add('題', '本文', { to: 'after', anchorId: 'ghost' }), writes: false },
      { args: add('題', '本文', { to: 'before', anchorId: 'd-1' }), writes: false },
      { args: add('題', '本文', { to: 'after', anchorId: 'd-1' }), writes: false },
      { args: add('題', '本文', { to: 'before', anchorId: 'c-1' }), writes: false },
      { args: add('題', '本文', { to: 'after', anchorId: 'c-1' }), writes: false },
      { args: add('題', '本文', { to: 'before', anchorId: ' q-1' }), writes: false },
      {
        args: add('成功する呼び', '直前の断りのあとでも足せる', { to: 'before', anchorId: 'q-1' }),
        writes: true,
      },
    ],
  },
  // ---- 起点の会話 ----
  {
    name: 'origin-conversation',
    covers:
      '起点の会話 id: workConversationId があればそれ（randomUUID は task の id の1つだけ）・workConversationId が undefined を返すと補う（randomUUID が起点→task の順に2つ）・workConversationId を渡さず conversationId だけなら conversationId・両方あれば workConversationId が勝つ・workConversationId が undefined でも conversationId へは倒れない・空文字（?? を通る）。応答と日誌の grounds に起点の会話 id が入る',
    seed: [],
    steps: [
      { args: add('work あり', '本文 1'), writes: true, ctx: { work: 'conv-work-1' } },
      { args: add('work なし', '本文 2'), writes: true, ctx: { work: null } },
      {
        args: add('work 省略・conversationId あり', '本文 3'),
        writes: true,
        ctx: { conversationId: 'conv-turn-1' },
      },
      {
        args: add('両方あり', '本文 4'),
        writes: true,
        ctx: { conversationId: 'conv-turn-1', work: 'conv-work-2' },
      },
      {
        args: add('work は undefined・conversationId あり', '本文 5'),
        writes: true,
        ctx: { conversationId: 'conv-turn-1', work: null },
      },
      { args: add('work が空文字', '本文 6'), writes: true, ctx: { work: '' } },
      { args: add('どちらも省略', '本文 7'), writes: true, ctx: {} },
      { args: add('同じ会話に2件', '本文 8'), writes: true, ctx: { work: 'conv-work-1' } },
    ],
  },
  // ---- 足したのに確かめられない ----
  {
    name: 'existed-natural',
    covers:
      '足した task の id が既に在る（added が existed）: 同じ id の行を先に置く。work あり（task の id は1番目）・なし（起点が1つ引かれ task の id は 2 番目→ここでは 3 番目の行）。行は書かれない（既存の行のまま）。何も書いていないので読み直さず（tasks.get を呼ばない）、日誌も呼ばない。断りの文は「id が既に在ったので、何も書かなかった」（#6471）',
    seed: [t(u(1), 1), t(u(3), 2)],
    steps: [
      { args: add('既に在る id', '本文 1'), writes: false, ctx: WORK },
      { args: add('起点を補って既に在る id', '本文 2'), writes: false, ctx: NO_CONV },
    ],
  },
  {
    name: 'existed-after-write',
    covers:
      'add が行を書いたうえで existed を返す（器の食い違いを口で作る）: 道具は器の existed を信じて読み直さず、「id が既に在った」の断り。日誌は呼ばない。置き場所付き（before）でも同じ。次の呼びは普通に足せる',
    seed: [t('q-1', 1)],
    steps: [
      {
        args: add('書けているのに existed', '本文 1'),
        writes: true,
        hooks: { addReportsExisted: true },
      },
      {
        args: add('before 付き', '本文 2', { to: 'before', anchorId: 'q-1' }),
        writes: true,
        hooks: { addReportsExisted: true },
      },
      { args: add('そのあとの呼び', '本文 3'), writes: true },
    ],
  },
  {
    name: 'existed-get-fails',
    covers:
      'existed のとき読み直し（tasks.get）が落ちる口を付けても、existed では読み直さないので口は効かず、どちらも「id が既に在った」の断り（#6471）',
    seed: [t(u(1), 1), t(u(2), 2)],
    steps: [
      { args: add('既に在る id', '本文 1'), writes: false, hooks: { getResult: 'unreadable' } },
      { args: add('既に在る id', '本文 2'), writes: false, hooks: { getResult: 'plain' } },
    ],
  },
  {
    name: 'confirm-null',
    covers:
      '書いたあとの読み直しが null: 断りの文（task_list id=… の案内）。行は書けているので、日誌に「読み直しで確かめられなかった（見つからなかった）」の行を残す（#6471）。work あり・なし・置き場所付き。最後の段は日誌も書けない（落とすだけで、断りの文は返す）',
    seed: [t('q-1', 1)],
    steps: [
      {
        args: add('読み直しが null', '本文 1'),
        writes: true,
        ctx: WORK,
        hooks: { getResult: 'null' },
      },
      {
        args: add('起点を補って null', '本文 2'),
        writes: true,
        ctx: NO_CONV,
        hooks: { getResult: 'null' },
      },
      {
        args: add('after 付き', '本文 3', { to: 'after', anchorId: 'q-1' }),
        writes: true,
        ctx: WORK,
        hooks: { getResult: 'null' },
      },
      {
        args: add('日誌も書けない', '本文 4'),
        writes: true,
        ctx: WORK,
        hooks: { getResult: 'null', journalFailsAt: [1] },
      },
    ],
  },
  {
    name: 'confirm-unreadable',
    covers:
      '書いたあとの読み直しが読めない形（UnreadableTaskError）: null の場面と同じ断りの文。日誌に「読み直しで確かめられなかった（読めない形で入っていた）」の行を残す（#6471）',
    seed: [t('q-1', 1)],
    steps: [
      {
        args: add('読み直しが読めない', '本文 1'),
        writes: true,
        ctx: WORK,
        hooks: { getResult: 'unreadable' },
      },
      {
        args: add('front 付き', '本文 2', { to: 'front' }),
        writes: true,
        ctx: NO_CONV,
        hooks: { getResult: 'unreadable' },
      },
    ],
  },
  {
    name: 'confirm-throws',
    covers:
      '書いたあとの読み直しがほかの例外で落ちる: 日誌に「読み直しで確かめられなかった（例外で終わった）」の行を残してから、そのまま投げる（thrown。#6471）',
    seed: [t('q-1', 1)],
    steps: [
      {
        args: add('読み直しが落ちる', '本文 1'),
        writes: true,
        ctx: WORK,
        hooks: { getResult: 'plain' },
      },
    ],
  },
  {
    name: 'add-throws',
    covers:
      'tasks.add 自体が例外で落ちる: そのまま投げる（thrown）。tasks.get・日誌は呼ばない。何も書かれない。次の呼びは普通に足せる（id は引き続き進む）',
    seed: [t('q-1', 1)],
    steps: [
      { args: add('add が落ちる', '本文 1'), writes: false, ctx: WORK, hooks: { addFails: true } },
      { args: add('そのあとの呼び', '本文 2'), writes: true, ctx: WORK },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails',
    covers:
      '日誌が書けない（journal.append が落ちる）: 「完了済み・未記録・やり直し禁止」の例外（thrown）。行は書けている（足した行がそのまま残る）・応答の文は出ない。work なし・置き場所付き・長い本文も同じ。落ちた呼びのあとの呼びは普通に足せる',
    seed: [t('q-1', 1)],
    steps: [
      {
        args: add('日誌が落ちる', '本文 1'),
        writes: true,
        ctx: WORK,
        hooks: { journalFailsAt: [1] },
      },
      {
        args: add('起点を補って日誌が落ちる', '本文 2'),
        writes: true,
        ctx: NO_CONV,
        hooks: { journalFailsAt: [1] },
      },
      {
        args: add('before 付き', '本文 3', { to: 'before', anchorId: 'q-1' }),
        writes: true,
        ctx: WORK,
        hooks: { journalFailsAt: [1] },
      },
      { args: add('そのあとの呼び', '本文 4'), writes: true, ctx: WORK },
    ],
  },
  // ---- 全部を通す ----
  {
    name: 'full',
    covers:
      '全部入りの成功: source あり・front・work あり。続けて source あり・after・work なし。応答は「task を足した（id）。起点の会話は …」。日誌は decision 1 行（target は task）。呼びは tasks.add → tasks.get → journal.append',
    seed: [t('q-1', 1), t('q-2', 2)],
    steps: [
      {
        args: add('全部入り', '逐語の本文', { source: 'mgr-9', to: 'front' }),
        writes: true,
        ctx: WORK,
      },
      {
        args: add('全部入り（起点を補う）', '逐語の本文 2', {
          source: 'mgr-9',
          to: 'after',
          anchorId: 'q-1',
        }),
        writes: true,
        ctx: NO_CONV,
      },
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
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
  /** 例外で返ったときの名前（例外でなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: 'tasks.add' | 'tasks.get' | 'journal.append';
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  uuidsDrawn: number;
  /** 呼んだあとの task の行（閉じた行を含む全件。並び順のまま・ストアから読んだ形のまま） */
  tasks: Task[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** ストアの呼びの並び */
  calls: PinnedCall[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function snapshot(stores: Stores): Promise<{ tasks: Task[]; journal: unknown[] }> {
  return {
    tasks: plain((await stores.tasks.list({ includeClosed: true })).entries),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

function failureOf(error: unknown): string {
  const kind = error instanceof UnreadableTaskError ? 'UnreadableTaskError' : 'Error';
  return `threw ${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗・食い違いを起こす */
function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[]): Stores {
  const tasks: Stores['tasks'] = {
    ...base.tasks,
    add: async (entry, placement) => {
      const args = plain({ entry, placement });
      try {
        if (hooks.addFails === true) throw new Error('ストアが落ちた（add）');
        const result = await base.tasks.add(entry, placement);
        const reported = hooks.addReportsExisted === true ? { kind: 'existed' as const } : result;
        calls.push({ op: 'tasks.add', args, outcome: reported.kind });
        return reported;
      } catch (error) {
        calls.push({ op: 'tasks.add', args, outcome: failureOf(error) });
        throw error;
      }
    },
    get: async (id) => {
      try {
        if (hooks.getResult === 'unreadable')
          throw new UnreadableTaskError('読めない行（テスト用）');
        if (hooks.getResult === 'plain') throw new Error('ストアが落ちた（get）');
        const found = hooks.getResult === 'null' ? null : await base.tasks.get(id);
        calls.push({
          op: 'tasks.get',
          args: { id },
          outcome: found === null ? 'null' : `found ${found.status}`,
        });
        return found;
      } catch (error) {
        calls.push({ op: 'tasks.get', args: { id }, outcome: failureOf(error) });
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
        const journalCalls = calls.filter((c) => c.op === 'journal.append').length + 1;
        const args = plain(entry);
        if ((hooks.journalFailsAt ?? []).includes(journalCalls)) {
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
      createdAt: minuteIso(spec.minute),
      updatedAt: status === 'queued' ? minuteIso(spec.minute) : SEED_UPDATED_ISO,
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

function toolsFor(stores: Stores, ctx: Ctx) {
  const work = ctx.work;
  return createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => ctx.conversationId,
    ...(work === undefined ? {} : { workConversationId: () => work ?? undefined }),
  });
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedTasks(base, scenario.seed);
  uuidState.drawn = 0;
  const hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const stores = withHooks(base, hooks, calls);

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const found = toolsFor(stores, step.ctx ?? WORK).find((entry) => entry.name === 'task_add');
    if (!found) throw new Error('task_add が無い');
    const before = await snapshot(base);
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    Object.assign(hooks, step.hooks ?? {});
    calls.length = 0;
    const drawnBefore = uuidState.drawn;
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(step.args as never, {});
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
        errorName: error instanceof Error ? error.constructor.name : typeof error,
      };
    }
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    const uuidsDrawn = uuidState.drawn - drawnBefore;
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.tasks) !== JSON.stringify(after.tasks) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      uuidsDrawn,
      tasks: after.tasks,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
    });
    if (!step.writes) {
      // 書き込みが起きなかった呼びは、task が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
      expect(
        after.tasks,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、task が呼ぶ前から変わった`,
      ).toEqual(before.tasks);
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
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

describe('task_add の出力と呼んだあとの状態の固定（場面ごとの出力の全文・task の行・日誌の行・ストアの呼び）', () => {
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

  it('書き込みが起きなかったと宣言した場面は、実際にも書き込みが起きていない（その逆も）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes);
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
          {
            isError: got?.output.isError,
            thrown: got?.output.thrown,
            errorName: got?.output.errorName,
          },
          `場面 ${key} の出力の isError／例外で返ったか（名前）、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の呼んだあとの task の行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.tasks.map((task) => task.id),
          `場面 ${key} の task: 行の並び（id）が変わった`,
        ).toEqual(want?.tasks.map((task) => task.id));
        for (const [row, wantTask] of (want?.tasks ?? []).entries()) {
          const gotTask = got?.tasks[row];
          expect(
            gotTask,
            `場面 ${key} の task ${wantTask.id}（${String(row)} 行目）が固定値からずれた（起点の会話・source・本文など）`,
          ).toEqual(wantTask);
        }
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
        expect(got?.uuidsDrawn, `場面 ${key} の randomUUID の引き数が変わった`).toBe(
          want?.uuidsDrawn,
        );
      });

      it(`${key} の呼んだあとに日誌へ足された行が固定値と同じ`, () => {
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
      });

      it(`${key} のストアの呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} のストアの呼び: 並び（tasks.add・tasks.get・journal.append）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び: 渡した引数（行・置き場所・日誌の行）か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・task・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const out = (key: string): PinnedOutput | undefined => actual[key]?.output;
    const text = (key: string): string => out(key)?.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const outcomes = (key: string): string[] =>
      (actual[key]?.calls ?? []).map((entry) => entry.outcome);
    const ids = (key: string): string[] => (actual[key]?.tasks ?? []).map((row) => row.id);
    const row = (key: string, id: string): Task | undefined =>
      actual[key]?.tasks.find((entry) => entry.id === id);
    const grounds = (key: string): string => {
      const value = journal(key)[0]?.grounds;
      return typeof value === 'string' ? value : '';
    };
    const REFUSED = '直後に読み直しても';
    const SAID = (id: string, origin: string): string =>
      `task を足した（${id}）。起点の会話は ${origin}（task_say taskId=${id} でここへ書ける）。位置は task_list で確かめられる。`;

    // title
    expect(text('title-invalid#1')).toBe('title は使えない（1文字以上200文字以下のみ）。');
    expect(text('title-invalid#2')).toBe('title は使えない（1文字以上200文字以下のみ）。');
    expect(text('title-invalid#3')).toBe('title は使えない（1文字以上200文字以下のみ）。');
    expect(text('title-invalid#4')).toContain('空白だけの値は空と同じ');
    expect(text('title-invalid#5')).toContain('空白だけの値は空と同じ');
    expect(text('title-invalid#6')).toContain('空白だけの値は空と同じ');
    expect(text('title-invalid#7')).toBe('title は使えない（改行を含まない一行のみ）。');
    expect(text('title-invalid#8')).toBe('title は使えない（改行を含まない一行のみ）。');
    expect(text('title-invalid#9')).toBe('title は使えない（改行を含まない一行のみ）。');
    // 200 文字 + 改行 = 201 文字: 長さの検査が改行の検査より先
    expect(text('title-invalid#10')).toBe('title は使えない（1文字以上200文字以下のみ）。');
    expect(text('title-invalid#11')).toBe('title は使えない（1文字以上200文字以下のみ）。');
    for (let n = 1; n <= 11; n += 1) {
      expect(ops(`title-invalid#${String(n)}`)).toEqual([]);
      expect(actual[`title-invalid#${String(n)}`]?.uuidsDrawn).toBe(0);
    }
    // body
    expect(text('body-invalid#1')).toBe('body は使えない（1文字以上のみ）。');
    expect(text('body-invalid#2')).toBe('body は使えない（1文字以上のみ）。');
    expect(text('body-invalid#3')).toContain('空白だけの値は空と同じ');
    expect(text('body-invalid#4')).toContain('空白だけの値は空と同じ');
    expect(text('body-invalid#5')).toContain('title は使えない');
    expect(text('body-invalid#6')).toContain('title は使えない');
    // source
    for (let n = 1; n <= 4; n += 1) {
      expect(text(`source-invalid#${String(n)}`)).toBe(
        'source が空です。分かるときだけ実のある文字列で渡し、無いなら省略してください。',
      );
    }
    expect(text('source-invalid#5')).toContain('title は使えない');
    expect(text('source-invalid#6')).toContain('body は使えない');
    // 起点の会話が無いので、呼びごとに起点→task の順に2つ引く（task の id は偶数番）
    expect(row('source-ok#1', u(2))).toBeDefined();
    expect('source' in (row('source-ok#1', u(2)) ?? { source: '' })).toBe(false);
    expect(row('source-ok#2', u(4))).toBeDefined();
    expect('source' in (row('source-ok#2', u(4)) ?? { source: '' })).toBe(false);
    expect(row('source-ok#3', u(6))?.source).toBe('mgr-1');
    expect(row('source-ok#4', u(8))?.source).toBe('  mgr-2  ');
    // placement
    expect(text('placement-invalid#1')).toContain('anchorId だけでは置き場所が決まらない');
    expect(text('placement-invalid#2')).toContain('anchorId だけでは置き場所が決まらない');
    expect(text('placement-invalid#3')).toBe(
      'to=before には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#4')).toBe(
      'to=after には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#5')).toBe(
      'to=before には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#6')).toBe(
      'to=after には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#7')).toContain('to=front に anchorId は付けられない');
    expect(text('placement-invalid#8')).toContain('to=back に anchorId は付けられない');
    expect(text('placement-invalid#9')).toContain('to=front に anchorId は付けられない');
    expect(text('placement-invalid#10')).toContain('to=back に anchorId は付けられない');
    expect(text('placement-invalid#11')).toContain('title は使えない');
    expect(text('placement-invalid#12')).toContain('source が空です');
    for (let n = 1; n <= 12; n += 1) expect(ops(`placement-invalid#${String(n)}`)).toEqual([]);
    expect(ops('placement-ok#1')).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
    expect(grounds('placement-ok#1')).toContain('置き場所: 既定の位置。');
    expect(grounds('placement-ok#2')).toContain('置き場所: 先頭。');
    expect(grounds('placement-ok#3')).toContain('置き場所: 末尾。');
    expect(grounds('placement-ok#4')).toContain('置き場所: q-2 の直前。');
    expect(grounds('placement-ok#5')).toContain('置き場所: q-2 の直後。');
    expect(grounds('placement-ok#6')).toContain('置き場所: w-1 の直前。');
    expect(grounds('placement-ok#7')).toContain('置き場所: n-1 の直後。');
    expect(ids('placement-ok#2')[0]).toBe(u(2));
    expect(ids('placement-empty-store#2')[0]).toBe(u(2));
    // anchor-not-found
    for (let n = 1; n <= 7; n += 1) {
      expect(ops(`anchor-missing#${String(n)}`)).toEqual(['tasks.add']);
      expect(outcomes(`anchor-missing#${String(n)}`)).toEqual(['anchor-not-found']);
      expect(actual[`anchor-missing#${String(n)}`]?.uuidsDrawn).toBe(1);
      expect(journal(`anchor-missing#${String(n)}`)).toEqual([]);
    }
    expect(text('anchor-missing#1')).toContain('anchorId ghost は開いている task に無い');
    expect(text('anchor-missing#3')).toContain('anchorId d-1 は開いている task に無い');
    expect(text('anchor-missing#8')).toBe(SAID(u(8), 'conv-work-1'));
    // origin
    expect(actual['origin-conversation#1']?.uuidsDrawn).toBe(1);
    expect(text('origin-conversation#1')).toBe(SAID(u(1), 'conv-work-1'));
    expect(actual['origin-conversation#2']?.uuidsDrawn).toBe(2);
    expect(text('origin-conversation#2')).toBe(SAID(u(3), u(2)));
    expect(text('origin-conversation#3')).toBe(SAID(u(4), 'conv-turn-1'));
    expect(text('origin-conversation#4')).toBe(SAID(u(5), 'conv-work-2'));
    expect(text('origin-conversation#5')).toBe(SAID(u(7), u(6)));
    expect(text('origin-conversation#6')).toBe(SAID(u(8), ''));
    // existed / confirm
    // existed: 何も書いていないので読み直さず、「id が既に在った」と断る（#6471）
    const EXISTED = 'が既に在ったので、何も書かなかった';
    for (const key of [
      'existed-natural#1',
      'existed-natural#2',
      'existed-after-write#1',
      'existed-get-fails#1',
      'existed-get-fails#2',
    ]) {
      expect(ops(key), key).toEqual(['tasks.add']);
      expect(text(key), key).toContain(EXISTED);
      expect(text(key), key).not.toContain(REFUSED);
      expect(out(key)?.thrown, key).toBe(false);
      expect(journal(key), key).toEqual([]);
    }
    expect(outcomes('existed-natural#1')).toEqual(['existed']);
    expect(ids('existed-after-write#1')).toContain(u(1));
    // 器は書いたと返したが確かめられない: 断りの文は同じで、日誌に確かめられなかった行を残す（#6471）
    const UNCONFIRMED = '直後の読み直しで確かめられなかった';
    for (const key of ['confirm-null#1', 'confirm-null#2', 'confirm-null#3']) {
      expect(ops(key)).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
      expect(outcomes(key).slice(0, 2)).toEqual(['added', 'null']);
      expect(text(key)).toContain(REFUSED);
      expect(journal(key)).toHaveLength(1);
      expect(journal(key)[0]).toMatchObject({ type: 'decision' });
      expect(JSON.stringify(journal(key)[0])).toContain(UNCONFIRMED);
      expect(JSON.stringify(journal(key)[0])).toContain('読み直し: 見つからなかった');
      expect(actual[key]?.wrote).toBe(true);
    }
    // 日誌も書けない: 落とすだけで、断りの文は返す
    expect(ops('confirm-null#4')).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
    expect(text('confirm-null#4')).toContain(REFUSED);
    expect(out('confirm-null#4')?.thrown).toBe(false);
    expect(journal('confirm-null#4')).toEqual([]);
    for (const key of ['confirm-unreadable#1', 'confirm-unreadable#2']) {
      expect(ops(key)).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
      expect(outcomes(key)[1]).toContain('threw UnreadableTaskError');
      expect(text(key)).toContain(REFUSED);
      expect(out(key)?.thrown).toBe(false);
      expect(journal(key)).toHaveLength(1);
      expect(JSON.stringify(journal(key)[0])).toContain('読み直し: 読めない形で入っていた');
      expect(actual[key]?.wrote).toBe(true);
    }
    expect(text('confirm-throws')).toBe('ストアが落ちた（get）');
    expect(out('confirm-throws')?.thrown).toBe(true);
    expect(ops('confirm-throws')).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
    expect(journal('confirm-throws')).toHaveLength(1);
    expect(JSON.stringify(journal('confirm-throws')[0])).toContain('読み直し: 例外で終わった');
    expect(actual['confirm-throws']?.wrote).toBe(true);
    expect(ops('add-throws#1')).toEqual(['tasks.add']);
    expect(text('add-throws#1')).toBe('ストアが落ちた（add）');
    expect(out('add-throws#1')?.thrown).toBe(true);
    expect(text('add-throws#2')).toBe(SAID(u(2), 'conv-work-1'));
    // journal
    for (const key of ['journal-fails#1', 'journal-fails#2', 'journal-fails#3']) {
      expect(ops(key)).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
      expect(outcomes(key)[2]).toBe('threw Error: 日誌が落ちた');
      expect(text(key)).toContain('⚠⚠ 完了済み・未記録・やり直し禁止');
      expect(out(key)?.thrown).toBe(true);
      expect(out(key)?.errorName).toBe('JournalNotRecordedError');
      expect(journal(key)).toEqual([]);
      expect(actual[key]?.wrote).toBe(true);
    }
    expect(text('journal-fails#4')).toBe(SAID(u(5), 'conv-work-1'));
    // full
    expect(ops('full#1')).toEqual(['tasks.add', 'tasks.get', 'journal.append']);
    expect(outcomes('full#1')).toEqual(['added', 'found queued', 'ok id-1']);
    expect(journal('full#1')).toHaveLength(1);
    expect(journal('full#1')[0]?.type).toBe('decision');
    expect(out('full#1')?.isError).toBe(false);
  });
});
