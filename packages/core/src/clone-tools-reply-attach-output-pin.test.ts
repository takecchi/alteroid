import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  canBindAttachmentTo,
  isAttachmentBound,
  isBoundTo,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentLimits,
  type AttachmentMeta,
} from './attachment.js';
import type { AttachmentRef } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import type { ReplyAttachments } from './tools.js';

// `reply_attach` の出力（全文と字数）と、呼んだあとの状態（添付の行と結び付き・いまのターンの返信の添付 `context.replyAttachments`）・呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-reply-attach-output-pin.json）と丸ごと比べる。
// 共用の `checkAndBindOutboundAttachments`（`outbound-attachments.ts`。`task_say` と共用）の結び付けを直す前の歯。
// 固定値の側で値を伏せず、入力（時計・id・添付の控え・いまのターンですでに添えた分）を固定して毎回同じにする。
// この道具は添付を会話へ結び、返信の添付の口へ足すので、出力だけでなく「呼んだあとの状態」と「呼びの順」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - attachments: 呼んだあとの添付の行を、置き場から読んだ形のまま（結び付いた会話 conversationId の有無を含む全件）
//   - slot: 呼んだあとの `context.replyAttachments.current()` の中身（並び順のまま）
//   - calls: 呼びの並び（attachments.getMeta / bind / unbind・replyAttachments.current / add を1本の並びで。引数ごと）
//   - wrote: 添付か slot のどちらかが呼ぶ前から変わったか。断った場面は false で、添付・slot が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_REPLY_ATTACH_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-reply-attach-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-reply-attach-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、添付・slot・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 添付の置き場は、id を固定するため場面ごとに作る小さな置き場（結び付けの判定は本物の attachment.ts の関数を使う）で差し替える。
// 同じ場面で続けて呼ぶと状態（添付・slot）が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
// 結ぶ間に別の手が変える・結ぶ・結び戻しが落ちる・控えが読めない、は口（Hooks）で作る。呼びの記録（calls）には道具の呼びだけが残り、口の書き換えは残らない。
//
// 作れない分岐（理由）:
//   - `validateAttachmentBatch` 以外の `AttachmentRejectedError` でない例外（`throw error` の行）: 純関数で、上限の2つ以外を投げない。
//   - 引数の検査（ids が空配列・空文字）: zod の検査はハンドラの外（SDK 側）にあり、ハンドラへ直接渡す本試験では通らない。
//     ids が空配列のときのハンドラの振る舞い（「すでに添えてある」の文）は場面に入れて固定する（実際には SDK が先に断る）。
//   - `bound.missing` と `bound.conflicts` が同時に出る分岐: 口は1回に1つの id しか書き換えないので、missing が先に出る側の文だけを固定する
//     （missing を先に判定する三項の片側で、conflicts の側は conflict だけの場面で通る）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（添付か slot）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

interface SeedAttachment {
  id: string;
  size: number;
  mediaType?: string;
  /** すでに結ばれている会話 */
  conv?: string;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** attachments.getMeta が落ちる */
  getMetaFails?: boolean;
  /** attachments.bind が落ちる（口の書き換えより前） */
  bindFails?: boolean;
  /** attachments.bind の直前に、別の手が id を消す（remove）・別の会話へ結ぶ（conflict） */
  raceBeforeBind?: { id: string; action: 'remove' | 'conflict' };
  /** attachments.unbind が落ちる */
  unbindFails?: boolean;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Hooks;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  attachments: SeedAttachment[];
  /** このターンですでに添えた分（attachments の id から控えを作る） */
  slotSeed?: string[];
  /** いまのターンに会話が無い（getConversationId() が undefined） */
  noConversation?: boolean;
  /** 器が replyAttachments を持たない */
  noSlot?: boolean;
  /** 省略すると LIMITS。'default' は context.attachmentLimits を渡さない（道具が環境から読む） */
  limits?: 'default' | AttachmentLimits;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const ATTACHMENT_CREATED_ISO = '2026-10-28T00:00:00.000Z';
const NOW_CONV = 'conv-now';
const PIN_URL = new URL('./clone-tools-reply-attach-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_REPLY_ATTACH_PIN === '1';

const LIMITS: AttachmentLimits = {
  maxImageBytes: 100,
  maxFileBytes: 50,
  maxLargeFileBytes: 0,
  maxPerMessage: 3,
  maxTotalBytes: 100,
  retentionDays: 30,
};

function a(id: string, size: number, conv?: string, mediaType?: string): SeedAttachment {
  return {
    id,
    size,
    ...(conv === undefined ? {} : { conv }),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function reply(...ids: string[]): Args {
  return { ids };
}

const SCENARIOS: Scenario[] = [
  // ---- 道具の手前で断る ----
  {
    name: 'no-conversation',
    covers:
      'いまのターンに会話が無い（getConversationId() が undefined）: isError の断りの文。slot も置き場も呼ばない。slot が無い器でも会話の検査が先',
    attachments: [a('att-1', 10)],
    noConversation: true,
    steps: [{ args: reply('att-1'), writes: 'none' }],
  },
  {
    name: 'no-conversation-no-slot',
    covers: '会話が無く、slot も無い器: 会話の検査が先なので「返信先の会話が無い」の文',
    attachments: [a('att-1', 10)],
    noConversation: true,
    noSlot: true,
    steps: [{ args: reply('att-1'), writes: 'none' }],
  },
  {
    name: 'no-slot',
    covers: '器が replyAttachments を持たない: isError の断りの文。置き場を呼ばない',
    attachments: [a('att-1', 10)],
    noSlot: true,
    steps: [{ args: reply('att-1'), writes: 'none' }],
  },
  // ---- 添付の検査で断る ----
  {
    name: 'missing',
    covers:
      '添付が無い（1つ・複数・一部だけ無い）・控えが読めない: 「何も添えていない。」の文（isError）。bind を呼ばない・slot へ足さない・添付も呼ぶ前と同じ。見つからない id は全部並べる。同じ id の重複は1件',
    attachments: [a('att-1', 10), a('att-mine', 15, NOW_CONV)],
    steps: [
      { args: reply('att-ghost'), writes: 'none' },
      { args: reply('att-1', 'att-ghost', 'att-ghost2'), writes: 'none' },
      { args: reply('att-mine', 'att-ghost'), writes: 'none' },
      { args: reply('att-ghost', 'att-ghost'), writes: 'none' },
      { args: reply('att-1'), writes: 'none', hooks: { getMetaFails: true } },
    ],
  },
  {
    name: 'limits',
    covers:
      '個数（maxPerMessage 3）・合計（maxTotalBytes 100）の上限: 断りの文に「今回の対象」が並ぶ。このターンですでに添えた分が無いので「合わせて数える」の文は出ない。bind を呼ばない・何も書かない',
    attachments: [
      a('att-1', 10),
      a('att-2', 10),
      a('att-3', 10),
      a('att-4', 10),
      a('att-big1', 50),
      a('att-big2', 50),
    ],
    steps: [
      { args: reply('att-1', 'att-2', 'att-3', 'att-4'), writes: 'none' },
      { args: reply('att-big1', 'att-big2', 'att-1'), writes: 'none' },
    ],
  },
  {
    name: 'limits-small',
    covers:
      'context.attachmentLimits の渡し方: 個数の上限 1・合計の上限 20 で、2件・合計超過を断る。上限の中なら通る',
    attachments: [a('att-1', 10), a('att-2', 12), a('att-3', 8)],
    limits: { ...LIMITS, maxPerMessage: 1, maxTotalBytes: 20 },
    steps: [
      { args: reply('att-1', 'att-2'), writes: 'none' },
      { args: reply('att-2'), writes: 'some' },
    ],
  },
  {
    name: 'limits-total',
    covers: '合計の上限（maxTotalBytes）だけを超える: 個数は上限の中',
    attachments: [a('att-1', 10), a('att-2', 12)],
    limits: { ...LIMITS, maxTotalBytes: 20 },
    steps: [{ args: reply('att-1', 'att-2'), writes: 'none' }],
  },
  {
    name: 'already-limits',
    covers:
      'このターンですでに添えた分（alreadyAttached）と合わせて上限を超える: 個数（すでに 2 個＋新しく 2 個）・合計（すでに 80 バイト＋新しく 30 バイト）。断りの文に「このターンですでに添えた 2 個と合わせて数える。」が付く。slot・添付は呼ぶ前と同じ。すでに添えた分の getMeta は呼ばない',
    attachments: [
      a('att-s1', 40, NOW_CONV),
      a('att-s2', 40, NOW_CONV),
      a('att-n1', 10),
      a('att-n2', 10),
      a('att-n3', 30),
    ],
    slotSeed: ['att-s1', 'att-s2'],
    steps: [
      { args: reply('att-n1', 'att-n2'), writes: 'none' },
      { args: reply('att-n3'), writes: 'none' },
    ],
  },
  // ---- すでに添えてある分 ----
  {
    name: 'already-only',
    covers:
      '渡した id がすべて alreadyAttached と重なる: 置き場を呼ばず（getMeta も bind も無い）「指された添付はすでにこの返信に添えてある。」を返す（isError なし）。slot・添付は呼ぶ前と同じ。同じ id の重複・空の ids も同じ文',
    attachments: [a('att-s1', 10, NOW_CONV), a('att-s2', 10, NOW_CONV)],
    slotSeed: ['att-s1', 'att-s2'],
    steps: [
      { args: reply('att-s1'), writes: 'none' },
      { args: reply('att-s2', 'att-s1', 'att-s1'), writes: 'none' },
      { args: reply(), writes: 'none' },
    ],
  },
  {
    name: 'already-partial',
    covers:
      '一部だけ alreadyAttached と重なる: 重ならない id だけ控えを読み・結び・slot へ足す（すでに添えた分は足さない）。応答の「添付 N 件」は新しく足した分・「合計」は slot の全件。続けて同じ id を渡すと「すでに添えてある」',
    attachments: [a('att-s1', 10, NOW_CONV), a('att-new', 10), a('att-new2', 10)],
    slotSeed: ['att-s1'],
    steps: [
      { args: reply('att-s1', 'att-new'), writes: 'some' },
      { args: reply('att-s1', 'att-new'), writes: 'none' },
      { args: reply('att-new2', 'att-new'), writes: 'some' },
    ],
  },
  // ---- 成功 ----
  {
    name: 'mixed',
    covers:
      '新しく結ぶ（att-new）・すでにこの会話へ結んである（att-mine）・別の会話へ結んである（att-other。結び直さず控えで指す）を混ぜる。bind は新しく結ぶ分だけ・slot へは3件とも足す。応答は添付の名前と id を並べ、合計は slot の件数',
    attachments: [
      a('att-new', 10),
      a('att-mine', 15, NOW_CONV),
      a('att-other', 5, 'conv-z', 'image/png'),
    ],
    steps: [{ args: reply('att-new', 'att-mine', 'att-other'), writes: 'some' }],
  },
  {
    name: 'mixed-dup',
    covers: '同じ新しい id を2回渡す: 1件として結ぶ（bind の引数・slot が1件）',
    attachments: [a('att-new', 10)],
    steps: [{ args: reply('att-new', 'att-new'), writes: 'some' }],
  },
  {
    name: 'turn-accumulates',
    covers:
      '同じターンで続けて呼ぶ（slot が積み上がる）: 1回目 att-1・2回目 att-2・att-3 で合計 3 件（上限どおり）・3回目 att-4 は個数の上限を「すでに添えた 3 個と合わせて数える」で断る。応答の合計が積み上がる。断った呼びは slot が変わらない',
    attachments: [a('att-1', 10), a('att-2', 10), a('att-3', 10), a('att-4', 10)],
    steps: [
      { args: reply('att-1'), writes: 'some' },
      { args: reply('att-2', 'att-3'), writes: 'some' },
      { args: reply('att-4'), writes: 'none' },
      { args: reply('att-1'), writes: 'none' },
    ],
  },
  {
    name: 'default-limits',
    covers:
      'context.attachmentLimits を渡さない器: 道具が readAttachmentLimits() で上限を環境から読む。小さな添付は通る',
    attachments: [a('att-new', 1)],
    limits: 'default',
    steps: [{ args: reply('att-new'), writes: 'some' }],
  },
  // ---- 結ぶ間に落ちる ----
  {
    name: 'bind-fails',
    covers:
      'attachments.bind が落ちる: 「添付を会話へ結べなかった」の断りの文（isError）。何も結ばず slot へ足さない',
    attachments: [a('att-1', 10)],
    steps: [{ args: reply('att-1'), writes: 'none', hooks: { bindFails: true } }],
  },
  {
    name: 'bind-race',
    covers:
      '結ぶ間に別の手が変える: 見つからなくなった（missing）・別の会話へ結ばれた（conflicts）。先に結べた分（newlyBound）は unbind で戻して断る。戻したあと添付は呼ぶ前と同じ・slot へ足さない。結べたものが無い（conflict だけ）なら unbind を呼ばない',
    attachments: [a('att-1', 10), a('att-2', 10), a('att-3', 10), a('att-4', 10)],
    steps: [
      {
        args: reply('att-1', 'att-2'),
        writes: 'none',
        hooks: { raceBeforeBind: { id: 'att-2', action: 'remove' } },
      },
      {
        args: reply('att-3', 'att-4'),
        writes: 'none',
        hooks: { raceBeforeBind: { id: 'att-4', action: 'conflict' } },
      },
      {
        args: reply('att-1'),
        writes: 'none',
        hooks: { raceBeforeBind: { id: 'att-1', action: 'conflict' } },
      },
    ],
  },
  {
    name: 'bind-race-unbind-fails',
    covers:
      '結ぶ間に別の手が変え、戻し（unbind）も落ちる: いまは握りつぶさず、道具が素の例外で終わる（応答の文ではなく例外・先に結べた分は結ばれたまま残る・slot へは足さない）。#6430 の2点目で直す前のいまの振る舞い',
    attachments: [a('att-1', 10), a('att-2', 10)],
    steps: [
      {
        args: reply('att-1', 'att-2'),
        writes: 'some',
        hooks: { raceBeforeBind: { id: 'att-2', action: 'remove' }, unbindFails: true },
      },
    ],
  },
  {
    name: 'bind-race-conflict-unbind-fails',
    covers:
      '別の会話へ結ばれた（conflicts）あとの戻しが落ちる: missing と同じく素の例外で終わる。先に結べた分は結ばれたまま残る',
    attachments: [a('att-3', 10), a('att-4', 10)],
    steps: [
      {
        args: reply('att-3', 'att-4'),
        writes: 'some',
        hooks: { raceBeforeBind: { id: 'att-4', action: 'conflict' }, unbindFails: true },
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
  /** 例外の名前（投げなかったときは null） */
  errorName: string | null;
}

interface PinnedCall {
  op:
    | 'attachments.getMeta'
    | 'attachments.bind'
    | 'attachments.unbind'
    | 'replyAttachments.current'
    | 'replyAttachments.add';
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの添付の行（置き場の全件。結び付いた会話 conversationId の有無を含む） */
  attachments: AttachmentMeta[];
  /** 呼んだあとの `replyAttachments.current()` の中身 */
  slot: AttachmentRef[];
  /** 呼びの並び */
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

/** id を固定した小さな添付の置き場。結び付けの判定は本物の attachment.ts の関数を使う。道具の呼びだけを calls へ記録する */
function createStubAttachments(
  seed: readonly SeedAttachment[],
  hooks: Hooks,
  calls: PinnedCall[],
): {
  store: Stores['attachments'];
  list: () => AttachmentMeta[];
  metaOf: (id: string) => AttachmentMeta;
} {
  const rows = new Map<string, AttachmentMeta>();
  for (const spec of seed) {
    rows.set(spec.id, {
      id: spec.id,
      name: `${spec.id}.txt`,
      mediaType: spec.mediaType ?? 'text/plain',
      size: spec.size,
      sha256: `sha-${spec.id}`,
      uploadedBy: 'clone',
      createdAt: ATTACHMENT_CREATED_ISO,
      ...(spec.conv === undefined ? {} : { conversationId: spec.conv }),
    });
  }
  const bindTo = (ids: readonly string[], target: AttachmentBindTarget): AttachmentBindResult => {
    const bound: string[] = [];
    const newlyBound: string[] = [];
    const missing: string[] = [];
    const conflicts: string[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined) missing.push(id);
      else if (!canBindAttachmentTo(row, target)) conflicts.push(id);
      else {
        if (!isAttachmentBound(row)) newlyBound.push(id);
        rows.set(id, { ...row, ...target });
        bound.push(id);
      }
    }
    return { bound, newlyBound, missing, conflicts };
  };
  const store = {
    getMeta: async (id: string) => {
      const args = { id };
      if (hooks.getMetaFails === true) {
        calls.push({
          op: 'attachments.getMeta',
          args,
          outcome: 'threw Error: 置き場が落ちた（getMeta）',
        });
        throw new Error('置き場が落ちた（getMeta）');
      }
      const found = rows.get(id);
      calls.push({
        op: 'attachments.getMeta',
        args,
        outcome:
          found === undefined
            ? 'undefined'
            : `found ${found.conversationId === undefined ? 'unbound' : `bound ${found.conversationId}`}`,
      });
      return found;
    },
    bind: async (ids: readonly string[], conversationId: string) => {
      const args = plain({ ids, conversationId });
      if (hooks.bindFails === true) {
        calls.push({
          op: 'attachments.bind',
          args,
          outcome: 'threw Error: 置き場が落ちた（bind）',
        });
        throw new Error('置き場が落ちた（bind）');
      }
      const race = hooks.raceBeforeBind;
      if (race !== undefined) {
        if (race.action === 'remove') rows.delete(race.id);
        else {
          const row = rows.get(race.id);
          if (row !== undefined) rows.set(race.id, { ...row, conversationId: 'conv-race' });
        }
      }
      const result = bindTo(ids, { conversationId });
      calls.push({ op: 'attachments.bind', args, outcome: JSON.stringify(result) });
      return result;
    },
    unbind: async (ids: readonly string[], target: AttachmentBindTarget) => {
      const args = plain({ ids, target });
      if (hooks.unbindFails === true) {
        calls.push({
          op: 'attachments.unbind',
          args,
          outcome: 'threw Error: 置き場が落ちた（unbind）',
        });
        throw new Error('置き場が落ちた（unbind）');
      }
      const unbound: string[] = [];
      for (const id of new Set(ids)) {
        const row = rows.get(id);
        if (row !== undefined && isBoundTo(row, target)) {
          const rest: { -readonly [K in keyof AttachmentMeta]: AttachmentMeta[K] } = { ...row };
          delete rest.conversationId;
          rows.set(id, rest);
          unbound.push(id);
        }
      }
      calls.push({ op: 'attachments.unbind', args, outcome: JSON.stringify(unbound) });
      return unbound;
    },
  };
  return {
    store: store as unknown as Stores['attachments'],
    list: () => plain([...rows.values()]),
    metaOf: (id: string) => {
      const row = rows.get(id);
      if (row === undefined) throw new Error(`seed に ${id} が無い`);
      return row;
    },
  };
}

function refOf(meta: AttachmentMeta): AttachmentRef {
  return {
    id: meta.id,
    name: meta.name,
    mediaType: meta.mediaType,
    size: meta.size,
    sha256: meta.sha256,
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  const hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const attachments = createStubAttachments(scenario.attachments, hooks, calls);
  const stores: Stores = { ...base, attachments: attachments.store };
  const slotRefs: AttachmentRef[] = (scenario.slotSeed ?? []).map((id) =>
    refOf(attachments.metaOf(id)),
  );
  const slot: ReplyAttachments = {
    current: () => {
      calls.push({
        op: 'replyAttachments.current',
        args: [],
        outcome: JSON.stringify(slotRefs.map((ref) => ref.id)),
      });
      return [...slotRefs];
    },
    add: (refs) => {
      calls.push({ op: 'replyAttachments.add', args: plain(refs), outcome: 'called' });
      slotRefs.push(...refs);
    },
  };
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => (scenario.noConversation === true ? undefined : NOW_CONV),
    ...(scenario.limits === 'default' ? {} : { attachmentLimits: scenario.limits ?? LIMITS }),
    ...(scenario.noSlot === true ? {} : { replyAttachments: slot }),
  });
  const found = tools.find((entry) => entry.name === 'reply_attach');
  if (!found) throw new Error('reply_attach が無い');

  const snapshot = (): { attachments: AttachmentMeta[]; slot: AttachmentRef[] } => ({
    attachments: attachments.list(),
    slot: plain(slotRefs),
  });

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const rawBefore = snapshot();
    // 結ぶ間の別の手の書き換え（口）は道具の書き込みではないので、比べる基準に先に織り込む
    const race = step.hooks?.raceBeforeBind;
    const before = {
      ...rawBefore,
      attachments: rawBefore.attachments.flatMap((row) =>
        race === undefined || row.id !== race.id
          ? [row]
          : race.action === 'remove'
            ? []
            : [{ ...row, conversationId: 'conv-race' }],
      ),
    };
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    Object.assign(hooks, step.hooks ?? {});
    calls.length = 0;
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
        errorName: error instanceof Error ? error.name : 'non-Error',
      };
    }
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    const after = snapshot();
    const wrote =
      JSON.stringify(before.attachments) !== JSON.stringify(after.attachments) ||
      JSON.stringify(before.slot) !== JSON.stringify(after.slot);
    results.push({
      output,
      wrote,
      attachments: after.attachments,
      slot: after.slot,
      calls: plain(calls),
    });
    const key = stepKey(scenario, index);
    if (step.writes === 'none') {
      expect(
        after.attachments,
        `場面 ${key} は書き込みが起きないはずだが、添付が呼ぶ前から変わった`,
      ).toEqual(before.attachments);
      expect(
        after.slot,
        `場面 ${key} は書き込みが起きないはずだが、返信の添付 slot が呼ぶ前から変わった`,
      ).toEqual(before.slot);
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

describe('reply_attach の出力と呼んだあとの状態の固定（場面ごとの出力の全文・添付の行・返信の添付 slot・呼びの並び）', () => {
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
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes === 'some',
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
          `場面 ${key} の出力の isError／例外で返ったか・例外の名前、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の呼んだあとの添付の行（結び付いた会話を含む）が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.attachments.map((row) => [row.id, row.conversationId ?? null]),
          `場面 ${key} の添付: 結び付いた会話が固定値からずれた（[id, 会話] の並び）`,
        ).toEqual(want?.attachments.map((row) => [row.id, row.conversationId ?? null]));
        expect(got?.attachments, `場面 ${key} の添付の行が固定値からずれた`).toEqual(
          want?.attachments,
        );
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} の呼んだあとの返信の添付 slot が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.slot.map((ref) => ref.id),
          `場面 ${key} の slot: current() の id の並びが固定値からずれた`,
        ).toEqual(want?.slot.map((ref) => ref.id));
        expect(got?.slot, `場面 ${key} の slot の中身が固定値からずれた`).toEqual(want?.slot);
      });

      it(`${key} の呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼び: 並び（attachments.*・replyAttachments.*）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} の呼び: 渡した引数（id・会話・控え）か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・添付・slot・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const call = (key: string, op: PinnedCall['op']): PinnedCall | undefined =>
      actual[key]?.calls.find((entry) => entry.op === op);
    const bound = (key: string, id: string): string | undefined =>
      actual[key]?.attachments.find((row) => row.id === id)?.conversationId;
    const slotIds = (key: string): string[] => (actual[key]?.slot ?? []).map((ref) => ref.id);
    const ALREADY_TEXT = '指された添付はすでにこの返信に添えてある。';

    // 道具の手前で断る
    expect(text('no-conversation')).toBe(
      'いまのターンには返信先の会話が無いので、返信には添えられない（何も添えていない）。人間へ渡すなら task_say の attachments に id を渡す。',
    );
    expect(actual['no-conversation']?.output.isError).toBe(true);
    expect(ops('no-conversation')).toEqual([]);
    expect(text('no-conversation-no-slot')).toBe(text('no-conversation'));
    expect(ops('no-conversation-no-slot')).toEqual([]);
    expect(text('no-slot')).toBe('この器では返信に添付を添えられない（何も添えていない）。');
    expect(actual['no-slot']?.output.isError).toBe(true);
    expect(ops('no-slot')).toEqual([]);
    // 添付の検査で断る
    expect(text('missing#1')).toContain('添付が見つからない');
    expect(text('missing#1')).toContain(': att-ghost。何も添えていない。');
    expect(text('missing#2')).toContain(': att-ghost, att-ghost2。何も添えていない。');
    expect(text('missing#3')).toContain(': att-ghost。何も添えていない。');
    expect(text('missing#4')).toContain(': att-ghost。何も添えていない。');
    expect(text('missing#5')).toBe(
      '添付 att-1 の控えを読めなかった: Error: 置き場が落ちた（getMeta）。何も添えていない。',
    );
    for (let n = 1; n <= 5; n += 1) {
      const key = `missing#${String(n)}`;
      expect(actual[key]?.output.isError, key).toBe(true);
      expect(ops(key)).not.toContain('attachments.bind');
      expect(ops(key)).not.toContain('replyAttachments.add');
    }
    expect(ops('missing#4')).toEqual(['replyAttachments.current', 'attachments.getMeta']);
    expect(text('limits#1')).toContain('今回の対象: att-1（att-1.txt, 10 バイト）');
    expect(text('limits#1')).not.toContain('合わせて数える');
    expect(text('limits#2')).toContain('今回の対象: att-big1');
    expect(text('limits#2')).not.toContain('合わせて数える');
    expect(text('limits-small#1')).toContain('今回の対象:');
    expect(actual['limits-small#1']?.output.isError).toBe(true);
    expect(text('limits-small#2')).toContain('この返信に添付 1 件を添えた');
    expect(text('limits-total')).toContain('今回の対象:');
    expect(text('already-limits#1')).toContain('このターンですでに添えた 2 個と合わせて数える。');
    expect(text('already-limits#2')).toContain('このターンですでに添えた 2 個と合わせて数える。');
    expect(call('already-limits#1', 'attachments.getMeta')?.args).toEqual({ id: 'att-n1' });
    expect(ops('already-limits#1')).not.toContain('attachments.bind');
    expect(slotIds('already-limits#1')).toEqual(['att-s1', 'att-s2']);
    expect(bound('already-limits#1', 'att-n1')).toBeUndefined();
    // すでに添えてある分
    for (let n = 1; n <= 3; n += 1) {
      const key = `already-only#${String(n)}`;
      expect(text(key), key).toBe(ALREADY_TEXT);
      expect(actual[key]?.output.isError, key).toBe(false);
      expect(ops(key), key).toEqual(['replyAttachments.current']);
    }
    expect(call('already-partial#1', 'attachments.getMeta')?.args).toEqual({ id: 'att-new' });
    expect(call('already-partial#1', 'attachments.bind')?.args).toEqual({
      ids: ['att-new'],
      conversationId: NOW_CONV,
    });
    expect(slotIds('already-partial#1')).toEqual(['att-s1', 'att-new']);
    expect(text('already-partial#1')).toContain(
      'この返信に添付 1 件を添えた: att-new.txt（id=att-new）',
    );
    expect(text('already-partial#1')).toContain('合計 2 件ついている。');
    expect(text('already-partial#2')).toBe(ALREADY_TEXT);
    expect(slotIds('already-partial#3')).toEqual(['att-s1', 'att-new', 'att-new2']);
    expect(text('already-partial#3')).toContain('合計 3 件ついている。');
    // 成功
    expect(call('mixed', 'attachments.bind')?.args).toEqual({
      ids: ['att-new'],
      conversationId: NOW_CONV,
    });
    expect(slotIds('mixed')).toEqual(['att-new', 'att-mine', 'att-other']);
    expect(text('mixed')).toContain('この返信に添付 3 件を添えた: ');
    expect(text('mixed')).toContain('att-other.txt（id=att-other）');
    expect(text('mixed')).toContain('合計 3 件ついている。');
    expect(bound('mixed', 'att-new')).toBe(NOW_CONV);
    expect(bound('mixed', 'att-other')).toBe('conv-z');
    expect(call('mixed-dup', 'attachments.bind')?.args).toEqual({
      ids: ['att-new'],
      conversationId: NOW_CONV,
    });
    expect(slotIds('mixed-dup')).toEqual(['att-new']);
    expect(slotIds('turn-accumulates#1')).toEqual(['att-1']);
    expect(slotIds('turn-accumulates#2')).toEqual(['att-1', 'att-2', 'att-3']);
    expect(text('turn-accumulates#2')).toContain('合計 3 件ついている。');
    expect(text('turn-accumulates#3')).toContain('このターンですでに添えた 3 個と合わせて数える。');
    expect(slotIds('turn-accumulates#3')).toEqual(['att-1', 'att-2', 'att-3']);
    expect(text('turn-accumulates#4')).toBe(ALREADY_TEXT);
    expect(text('default-limits')).toContain('この返信に添付 1 件を添えた');
    // 結ぶ間に落ちる
    expect(text('bind-fails')).toBe(
      '添付を会話へ結べなかった: Error: 置き場が落ちた（bind）。何も添えていない。',
    );
    expect(ops('bind-fails')).toEqual([
      'replyAttachments.current',
      'attachments.getMeta',
      'attachments.bind',
    ]);
    expect(text('bind-race#1')).toContain('添付が結ぶ間に見つからなくなった（保持期限）: att-2');
    expect(call('bind-race#1', 'attachments.unbind')?.args).toEqual({
      ids: ['att-1'],
      target: { conversationId: NOW_CONV },
    });
    expect(text('bind-race#2')).toContain('添付が結ぶ間に別の宛先へ結ばれた: att-4');
    expect(call('bind-race#2', 'attachments.unbind')?.args).toEqual({
      ids: ['att-3'],
      target: { conversationId: NOW_CONV },
    });
    expect(text('bind-race#3')).toContain('別の宛先へ結ばれた: att-1');
    expect(ops('bind-race#3')).not.toContain('attachments.unbind');
    for (let n = 1; n <= 3; n += 1) {
      const key = `bind-race#${String(n)}`;
      expect(actual[key]?.output.isError, key).toBe(true);
      expect(actual[key]?.output.thrown, key).toBe(false);
      expect(ops(key), key).not.toContain('replyAttachments.add');
    }
    // 戻しも落ちる: いまは素の例外で終わり、結んだ分が残る
    for (const key of ['bind-race-unbind-fails', 'bind-race-conflict-unbind-fails']) {
      expect(actual[key]?.output.thrown, key).toBe(true);
      expect(actual[key]?.output.errorName, key).toBe('Error');
      expect(text(key), key).toBe('置き場が落ちた（unbind）');
      expect(ops(key), key).toContain('attachments.unbind');
      expect(ops(key), key).not.toContain('replyAttachments.add');
      expect(slotIds(key), key).toEqual([]);
    }
    expect(bound('bind-race-unbind-fails', 'att-1')).toBe(NOW_CONV);
    expect(bound('bind-race-conflict-unbind-fails', 'att-3')).toBe(NOW_CONV);
  });
});
