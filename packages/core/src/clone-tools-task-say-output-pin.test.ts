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
import type { Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

// `task_say` の出力（全文と字数）と、呼んだあとの状態（日誌へ足された行・添付の行と結び付き）・呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-task-say-output-pin.json）と丸ごと比べる。
// `clone-tools-attach.ts` の `tool('task_say', …)`（ハンドラ約 94 行・入れ子 6 段の式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の本文・添付の控え）を固定して毎回同じにする。
// この道具は日誌に1行書き、添付を会話へ結ぶので、出力だけでなく「呼んだあとの状態」と「呼びの順」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・添付の控え・id・at をそのまま。書けなかった行は含まない）
//   - attachments: 呼んだあとの添付の行を、置き場から読んだ形のまま（結び付いた会話 conversationId の有無を含む全件）
//   - calls: 呼びの並び（tasks.get・attachments.getMeta / bind / unbind・journal.append・context.noteTaskSaid・
//     context.postToConversation を1本の並びで。引数ごと。postToConversation は渡した引数の個数も区別できる）
//   - wrote: 日誌か添付のどちらかが呼ぶ前から変わったか。断った・当たらなかった場面は false で、日誌・添付が呼ぶ前と同じであることも別に確かめる。
//     task の行はどの場面でも変わらない（task_say は task を書き換えない）ので、全呼びで呼ぶ前と同じであることも確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_SAY_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-say-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-say-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、日誌・添付・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番で、場面ごとにストアを作り直すので毎回同じ。
// 添付の置き場は、id を固定するため場面ごとに作る小さな置き場（結び付けの判定は本物の attachment.ts の関数を使う）で差し替える。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
// 結ぶ間に別の手が変える・結び戻しが落ちる・日誌が落ちる、は口（Hooks）で作る。呼びの記録（calls）には道具の呼びだけが残り、口の書き換えは残らない。
//
// 作れない分岐（理由）:
//   - `checkAndBindOutboundAttachments` の `alreadyAttached`（このターンですでに添えた分）: task_say は渡さないので、
//     「このターンですでに添えた N 個と合わせて数える」の文は出ない（reply_attach の側の分岐）。
//   - `validateAttachmentBatch` 以外の `AttachmentRejectedError` でない例外（`throw error` の行）: 純関数で、上限の2つ以外を投げない。
//   - 起点の会話の一致が `getConversationId()` の undefined と起点なしの task で重なる分岐: 起点なしを先に断るので、一致の検査に届かない
//     （起点の会話を持つ task と getConversationId() が undefined の組は、いまのターンの会話ではない扱いで成功の場面に含める）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（日誌か添付）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

type Failure = 'unreadable' | 'plain';

interface SeedTask {
  id: string;
  /** 起点の会話。省略すると起点を持たない古い task */
  conv?: string;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる */
  status?: 'queued' | 'waiting' | 'done' | 'cancelled';
}

interface SeedAttachment {
  id: string;
  size: number;
  mediaType?: string;
  /** すでに結ばれている会話 */
  conv?: string;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** tasks.get が落ちる */
  getFails?: Failure;
  /** attachments.getMeta が落ちる */
  getMetaFails?: boolean;
  /** attachments.bind が落ちる（口の書き換えより前） */
  bindFails?: boolean;
  /** attachments.bind の直前に、別の手が id を消す（remove）・別の会話へ結ぶ（conflict） */
  raceBeforeBind?: { id: string; action: 'remove' | 'conflict' };
  /** attachments.unbind が落ちる */
  unbindFails?: boolean;
  /** journal.append が落ちる */
  journalFails?: boolean;
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
  tasks: SeedTask[];
  attachments?: SeedAttachment[];
  /** 省略すると LIMITS。'default' は context.attachmentLimits を渡さない（道具が環境から読む） */
  limits?: 'default' | AttachmentLimits;
  /** noteTaskSaid・postToConversation を渡さない器 */
  noCallbacks?: boolean;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const TASK_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const SEED_CLOSED_ISO = '2026-10-03T00:00:00.000Z';
const ATTACHMENT_CREATED_ISO = '2026-10-28T00:00:00.000Z';
const NOW_CONV = 'conv-now';
const PIN_URL = new URL('./clone-tools-task-say-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_SAY_PIN === '1';

const LIMITS: AttachmentLimits = {
  maxImageBytes: 100,
  maxFileBytes: 50,
  maxLargeFileBytes: 0,
  maxPerMessage: 3,
  maxTotalBytes: 100,
  retentionDays: 30,
};

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function t(id: string, conv?: string, status?: SeedTask['status']): SeedTask {
  return {
    id,
    ...(conv === undefined ? {} : { conv }),
    ...(status === undefined ? {} : { status }),
  };
}

function a(id: string, size: number, conv?: string, mediaType?: string): SeedAttachment {
  return {
    id,
    size,
    ...(conv === undefined ? {} : { conv }),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function say(taskId: string, text?: string, attachments?: string[]): Args {
  return {
    taskId,
    ...(text === undefined ? {} : { text }),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査（ストアを呼ぶ前に断る） ----
  {
    name: 'args-invalid',
    covers:
      '添付が無い（undefined・空配列）のとき text が無い・空・NUL だけ: 断りの文。taskId が空: 断りの文（text の検査が先。添付があっても taskId の検査が先で、置き場も task も呼ばない）。ストア・context は一切呼ばない',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10)],
    steps: [
      { args: say('q-1'), writes: 'none' },
      { args: say('q-1', ''), writes: 'none' },
      { args: say('q-1', undefined, []), writes: 'none' },
      { args: say('q-1', '', []), writes: 'none' },
      { args: say('q-1', '\u0000'), writes: 'none' },
      { args: say('', 'こんにちは'), writes: 'none' },
      { args: say(''), writes: 'none' },
      { args: say('', undefined, ['att-1']), writes: 'none' },
      { args: say('', '', ['att-1']), writes: 'none' },
    ],
  },
  // ---- task を読む ----
  {
    name: 'get-fails',
    covers:
      'tasks.get が落ちる: 読めない形（UnreadableTaskError）は isError の断りの文・ほかの例外はそのまま投げる。添付つきでも置き場を呼ばない',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10)],
    steps: [
      { args: say('q-1', 'こんにちは'), writes: 'none', hooks: { getFails: 'unreadable' } },
      { args: say('q-1', 'こんにちは'), writes: 'none', hooks: { getFails: 'plain' } },
      { args: say('q-1', '', ['att-1']), writes: 'none', hooks: { getFails: 'unreadable' } },
      { args: say('q-1', '', ['att-1']), writes: 'none', hooks: { getFails: 'plain' } },
    ],
  },
  {
    name: 'task-missing',
    covers: '無い task（tasks.get が null）: isError の断りの文。添付つきでも置き場を呼ばない',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10)],
    steps: [
      { args: say('ghost', 'こんにちは'), writes: 'none' },
      { args: say('ghost', '', ['att-1']), writes: 'none' },
    ],
  },
  {
    name: 'task-no-origin',
    covers:
      '起点の会話を持たない古い task（開いている・閉じた）: isError の断りの文。添付つきでも置き場を呼ばない',
    tasks: [t('old-1'), t('old-2', undefined, 'done')],
    attachments: [a('att-1', 10)],
    steps: [
      { args: say('old-1', 'こんにちは'), writes: 'none' },
      { args: say('old-2', 'こんにちは'), writes: 'none' },
      { args: say('old-1', '', ['att-1']), writes: 'none' },
    ],
  },
  {
    name: 'current-turn',
    covers:
      '起点の会話がいまのターンの会話（getConversationId() と一致）: isError の断りの文。添付なしは「このターンの返答として書けば」・添付ありは「reply_attach を使う」で文言が変わる。閉じた task も同じ。添付は結ばない',
    tasks: [t('q-1', NOW_CONV), t('d-1', NOW_CONV, 'done')],
    attachments: [a('att-1', 10)],
    steps: [
      { args: say('q-1', 'こんにちは'), writes: 'none' },
      { args: say('q-1', '', ['att-1']), writes: 'none' },
      { args: say('q-1', 'こんにちは', ['att-1']), writes: 'none' },
      { args: say('d-1', 'こんにちは'), writes: 'none' },
      { args: say('d-1', undefined, ['att-1']), writes: 'none' },
    ],
  },
  // ---- 添付なしの成功 ----
  {
    name: 'say-open',
    covers:
      '開いている task（queued・waiting）へ添付なしで書く: 日誌へ1行（outbound・起点の会話）・postToConversation は2引数・応答に task_set_status の促しが付く。空配列の添付は添付なしと同じ。同じ task へ続けて書くと日誌が積み上がる。本文は複数行・前後の空白・途中の NUL をそのまま通す（NUL だけは断る）',
    tasks: [t('q-1', 'conv-a'), t('w-1', 'conv-b', 'waiting')],
    steps: [
      { args: say('q-1', 'こんにちは'), writes: 'some' },
      { args: say('q-1', '二通目\n改行つき\n  前後に空白  '), writes: 'some' },
      { args: say('w-1', '待ちの task へ', []), writes: 'some' },
      { args: say('q-1', 'x'), writes: 'some' },
      { args: say('q-1', 'こん\u0000にちは'), writes: 'some' },
    ],
  },
  {
    name: 'say-closed',
    covers:
      '閉じた task（done・cancelled）へ添付なしで書く: 書ける（報告を後から出すため）。応答に task_set_status の促しが付かない。task は閉じたまま',
    tasks: [t('d-1', 'conv-a', 'done'), t('c-1', 'conv-b', 'cancelled')],
    steps: [
      { args: say('d-1', '後から報告'), writes: 'some' },
      { args: say('c-1', 'やめた件の報告'), writes: 'some' },
    ],
  },
  {
    name: 'say-no-callbacks',
    covers:
      'noteTaskSaid・postToConversation を持たない器: 呼ばずに（`?.`）日誌だけ書いて成功の文を返す。添付ありでも同じ',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10)],
    noCallbacks: true,
    steps: [
      { args: say('q-1', 'こんにちは'), writes: 'some' },
      { args: say('q-1', '', ['att-1']), writes: 'some' },
    ],
  },
  // ---- 添付ありの成功 ----
  {
    name: 'say-attach-open',
    covers:
      '開いている task へ添付つきで書く: 新しく結ぶ（att-new）・すでに起点の会話へ結んである（att-mine）・別の会話へ結んである（att-other。結び直さず控えで指す）を混ぜる。日誌の行に添付の控え・postToConversation は3引数・応答に「添付 N 件つき」と促し。text が空・無いときの本文は空。同じ id を2回渡すと1件。いま結んだ添付を続けて渡すと「すでに結んである」側で通り bind を呼ばない',
    tasks: [t('q-1', 'conv-a')],
    attachments: [
      a('att-new', 10),
      a('att-new2', 20, undefined, 'image/png'),
      a('att-mine', 15, 'conv-a'),
      a('att-other', 5, 'conv-z'),
    ],
    steps: [
      { args: say('q-1', '添付つき', ['att-new']), writes: 'some' },
      { args: say('q-1', '', ['att-mine']), writes: 'some' },
      { args: say('q-1', undefined, ['att-new2', 'att-mine', 'att-other']), writes: 'some' },
      { args: say('q-1', '混ぜた', ['att-new', 'att-new2']), writes: 'some' },
      { args: say('q-1', '重複', ['att-other', 'att-other']), writes: 'some' },
    ],
  },
  {
    name: 'say-attach-dup-new',
    covers: '同じ未結び付けの id を2回渡す: 1件として結ぶ（bind の引数・refs・日誌の添付が1件）',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-new', 10)],
    steps: [{ args: say('q-1', '重複', ['att-new', 'att-new']), writes: 'some' }],
  },
  {
    name: 'say-attach-closed',
    covers:
      '閉じた task へ添付つきで書く: 新しく結ぶ・すでに結んである・別の会話へ結んであるを混ぜる。応答に促しが付かず、「添付 N 件つき」だけ付く',
    tasks: [t('d-1', 'conv-a', 'done'), t('c-1', 'conv-b', 'cancelled')],
    attachments: [a('att-new', 10), a('att-mine', 15, 'conv-a'), a('att-other', 5, 'conv-z')],
    steps: [
      { args: say('d-1', '報告', ['att-new', 'att-mine', 'att-other']), writes: 'some' },
      { args: say('c-1', '', ['att-mine']), writes: 'some' },
    ],
  },
  {
    name: 'say-attach-default-limits',
    covers:
      'context.attachmentLimits を渡さない器: 道具が readAttachmentLimits() で上限を読む。小さな添付は通る',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-new', 1)],
    limits: 'default',
    steps: [{ args: say('q-1', '既定の上限', ['att-new']), writes: 'some' }],
  },
  // ---- 添付の検査で断る ----
  {
    name: 'attach-rejected',
    covers:
      '添付の検査（存在・個数・合計の上限・控えの読み出し）で断る: 「会話へは書かなかった。…何も添えていない。」の文（isError は付かない）。日誌も添付も呼ぶ前と同じ・bind を呼ばない・noteTaskSaid / postToConversation を呼ばない。見つからない id は全部並べる。すでに結んであるものだけでも、見つからなければ断る',
    tasks: [t('q-1', 'conv-a'), t('d-1', 'conv-b', 'done')],
    attachments: [
      a('att-1', 10),
      a('att-2', 10),
      a('att-3', 10),
      a('att-4', 10),
      a('att-big1', 50),
      a('att-big2', 50),
      a('att-mine', 15, 'conv-a'),
    ],
    steps: [
      { args: say('q-1', 'こんにちは', ['att-ghost']), writes: 'none' },
      { args: say('q-1', '', ['att-1', 'att-ghost', 'att-ghost2']), writes: 'none' },
      { args: say('q-1', 'こんにちは', ['att-1', 'att-2', 'att-3', 'att-4']), writes: 'none' },
      { args: say('q-1', 'こんにちは', ['att-big1', 'att-big2', 'att-1']), writes: 'none' },
      { args: say('d-1', 'こんにちは', ['att-mine', 'att-ghost']), writes: 'none' },
      {
        args: say('q-1', 'こんにちは', ['att-1']),
        writes: 'none',
        hooks: { getMetaFails: true },
      },
    ],
  },
  {
    name: 'attach-rejected-small-limits',
    covers:
      'context.attachmentLimits の渡し方: 個数の上限 1・合計の上限 20 で、2件・合計超過を断る。上限の中なら通る',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10), a('att-2', 12)],
    limits: { ...LIMITS, maxPerMessage: 1, maxTotalBytes: 20 },
    steps: [
      { args: say('q-1', 'こんにちは', ['att-1', 'att-2']), writes: 'none' },
      { args: say('q-1', 'こんにちは', ['att-2']), writes: 'some' },
    ],
  },
  {
    name: 'attach-total-limit',
    covers:
      '合計の上限（maxTotalBytes）だけを超える: 個数は上限の中。断りの文に対象の名前とバイト数が並ぶ',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10), a('att-2', 12)],
    limits: { ...LIMITS, maxTotalBytes: 20 },
    steps: [{ args: say('q-1', 'こんにちは', ['att-1', 'att-2']), writes: 'none' }],
  },
  // ---- 結ぶ間に落ちる ----
  {
    name: 'attach-bind-fails',
    covers:
      'attachments.bind が落ちる: 「添付を会話へ結べなかった」の断りの文。何も結ばず日誌も書かない',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10)],
    steps: [
      { args: say('q-1', 'こんにちは', ['att-1']), writes: 'none', hooks: { bindFails: true } },
    ],
  },
  {
    name: 'attach-bind-race',
    covers:
      '結ぶ間に別の手が変える: 見つからなくなった（missing）・別の会話へ結ばれた（conflicts）。先に結べた分（newlyBound）は unbind で戻して断る。戻したあと添付は呼ぶ前と同じ・日誌は書かない。最初の id が先に結べているので、戻しの引数に入る',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10), a('att-2', 10), a('att-3', 10), a('att-4', 10)],
    steps: [
      {
        args: say('q-1', 'こんにちは', ['att-1', 'att-2']),
        writes: 'none',
        hooks: { raceBeforeBind: { id: 'att-2', action: 'remove' } },
      },
      {
        args: say('q-1', 'こんにちは', ['att-3', 'att-4']),
        writes: 'none',
        hooks: { raceBeforeBind: { id: 'att-4', action: 'conflict' } },
      },
      {
        args: say('q-1', 'こんにちは', ['att-1']),
        writes: 'none',
        hooks: { raceBeforeBind: { id: 'att-1', action: 'conflict' } },
      },
    ],
  },
  {
    name: 'attach-bind-race-unbind-fails',
    covers:
      '結ぶ間に別の手が変え、戻し（unbind）も落ちる: ここは握りつぶさず、道具が例外で終わる（日誌は書かない。先に結べた分は結ばれたまま残る）',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-1', 10), a('att-2', 10)],
    steps: [
      {
        args: say('q-1', 'こんにちは', ['att-1', 'att-2']),
        writes: 'some',
        hooks: { raceBeforeBind: { id: 'att-2', action: 'remove' }, unbindFails: true },
      },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails',
    covers:
      '日誌が書けない（act-not-performed）: 添付なしは「未記録・行為は起きていない」の例外・noteTaskSaid / postToConversation は呼ばない・unbind は呼ばない。閉じた task も同じ',
    tasks: [t('q-1', 'conv-a'), t('d-1', 'conv-b', 'done')],
    steps: [
      { args: say('q-1', 'こんにちは'), writes: 'none', hooks: { journalFails: true } },
      { args: say('d-1', 'こんにちは'), writes: 'none', hooks: { journalFails: true } },
    ],
  },
  {
    name: 'journal-fails-release',
    covers:
      '日誌が書けず、この呼びで新しく結んだ添付を戻す（unbind は新しく結んだ id だけ・起点の会話を指定）: 戻しが成功すると添付は呼ぶ前と同じ・元の例外を投げる。すでに結んであった添付・別の会話へ結んであった添付は戻さない。新しく結んだものが無ければ unbind を呼ばない',
    tasks: [t('q-1', 'conv-a'), t('d-1', 'conv-b', 'done')],
    attachments: [
      a('att-new', 10),
      a('att-new2', 10),
      a('att-mine', 15, 'conv-a'),
      a('att-other', 5, 'conv-z'),
    ],
    steps: [
      {
        args: say('q-1', 'こんにちは', ['att-new']),
        writes: 'none',
        hooks: { journalFails: true },
      },
      {
        args: say('q-1', '', ['att-new2', 'att-mine', 'att-other']),
        writes: 'none',
        hooks: { journalFails: true },
      },
      {
        args: say('q-1', 'こんにちは', ['att-mine', 'att-other']),
        writes: 'none',
        hooks: { journalFails: true },
      },
      {
        args: say('d-1', 'こんにちは', ['att-new', 'att-new2']),
        writes: 'none',
        hooks: { journalFails: true },
      },
    ],
  },
  {
    name: 'journal-fails-release-fails',
    covers:
      '日誌が書けず、戻し（unbind）も落ちる: 戻しの失敗は握りつぶし、元の例外（日誌の失敗）を投げる。添付は結ばれたまま残る（書き込みあり）。新しく結んだものが無ければ unbind を呼ばないので、落ちる口があっても関係しない',
    tasks: [t('q-1', 'conv-a')],
    attachments: [a('att-new', 10), a('att-new2', 10), a('att-mine', 15, 'conv-a')],
    steps: [
      {
        args: say('q-1', 'こんにちは', ['att-new']),
        writes: 'some',
        hooks: { journalFails: true, unbindFails: true },
      },
      {
        args: say('q-1', '', ['att-new2', 'att-mine']),
        writes: 'some',
        hooks: { journalFails: true, unbindFails: true },
      },
      {
        args: say('q-1', '', ['att-mine']),
        writes: 'none',
        hooks: { journalFails: true, unbindFails: true },
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
    | 'tasks.get'
    | 'attachments.getMeta'
    | 'attachments.bind'
    | 'attachments.unbind'
    | 'journal.append'
    | 'context.noteTaskSaid'
    | 'context.postToConversation';
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの添付の行（置き場の全件。結び付いた会話 conversationId の有無を含む） */
  attachments: AttachmentMeta[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
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

function failureOf(error: unknown): string {
  const kind = error instanceof UnreadableTaskError ? 'UnreadableTaskError' : 'Error';
  return `threw ${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

/** id を固定した小さな添付の置き場。結び付けの判定は本物の attachment.ts の関数を使う。道具の呼びだけを calls へ記録する */
function createStubAttachments(
  seed: readonly SeedAttachment[],
  hooks: Hooks,
  calls: PinnedCall[],
): { store: Stores['attachments']; list: () => AttachmentMeta[] } {
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
  };
}

async function seedTasks(base: Stores, seed: readonly SeedTask[]): Promise<void> {
  for (const [index, spec] of seed.entries()) {
    const minute = new Date(TASK_BASE + (index + 1) * 60_000).toISOString();
    const task: Task = {
      id: spec.id,
      createdAt: minute,
      updatedAt: minute,
      status: spec.status === 'waiting' ? 'waiting' : 'queued',
      origin: 'external',
      title: `仕事 ${spec.id}`,
      body: `本文 ${spec.id}`,
      ...(spec.conv === undefined ? {} : { originConversationId: spec.conv }),
    };
    await base.tasks.add(task);
    if (spec.status === 'done' || spec.status === 'cancelled') {
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
  vi.setSystemTime(new Date(BASE_ISO));
  await seedTasks(base, scenario.tasks);
  const hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const attachments = createStubAttachments(scenario.attachments ?? [], hooks, calls);
  const stores: Stores = {
    ...base,
    attachments: attachments.store,
    tasks: {
      ...base.tasks,
      get: async (id) => {
        try {
          if (hooks.getFails === 'unreadable')
            throw new UnreadableTaskError('読めない行（テスト用）');
          if (hooks.getFails === 'plain') throw new Error('ストアが落ちた（get）');
          const found = await base.tasks.get(id);
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
    },
    journal: {
      ...base.journal,
      append: async (entry) => {
        const args = plain(entry);
        if (hooks.journalFails === true) {
          calls.push({ op: 'journal.append', args, outcome: 'threw Error: 日誌が落ちた' });
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(entry);
        calls.push({ op: 'journal.append', args, outcome: `ok ${written.id}` });
        return written;
      },
    },
  };
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => NOW_CONV,
    ...(scenario.limits === 'default' ? {} : { attachmentLimits: scenario.limits ?? LIMITS }),
    ...(scenario.noCallbacks === true
      ? {}
      : {
          noteTaskSaid: (taskId: string) => {
            calls.push({ op: 'context.noteTaskSaid', args: [taskId], outcome: 'called' });
          },
          postToConversation: (
            ...args: Parameters<NonNullable<ToolContext['postToConversation']>>
          ) => {
            calls.push({
              op: 'context.postToConversation',
              args: plain(args),
              outcome: 'called',
            });
          },
        }),
  });
  const found = tools.find((entry) => entry.name === 'task_say');
  if (!found) throw new Error('task_say が無い');

  const snapshot = async (): Promise<{
    tasks: unknown[];
    journal: unknown[];
    attachments: AttachmentMeta[];
  }> => ({
    tasks: plain((await base.tasks.list({ includeClosed: true })).entries),
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown[],
    attachments: attachments.list(),
  });

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const rawBefore = await snapshot();
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
        errorName: error instanceof Error ? error.name : 'non-Error',
      };
    }
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    const after = await snapshot();
    const wrote =
      JSON.stringify(before.attachments) !== JSON.stringify(after.attachments) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      attachments: after.attachments,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
    });
    const key = stepKey(scenario, index);
    expect(after.tasks, `場面 ${key} は task を書き換えないはずだが、task が変わった`).toEqual(
      before.tasks,
    );
    if (step.writes === 'none') {
      expect(
        after.attachments,
        `場面 ${key} は書き込みが起きないはずだが、添付が呼ぶ前から変わった`,
      ).toEqual(before.attachments);
      expect(
        after.journal.length,
        `場面 ${key} は書き込みが起きないはずだが、日誌に行が足された`,
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

describe('task_say の出力と呼んだあとの状態の固定（場面ごとの出力の全文・日誌の行・添付の行・呼びの並び）', () => {
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
          `場面 ${key} の日誌: 足された行（種類・本文・添付の控え・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
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

      it(`${key} の呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼び: 並び（tasks.get・attachments.*・journal.append・context.*）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} の呼び: 渡した引数（id・会話・日誌の行・本文・添付の控え・引数の個数）か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・日誌・添付・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const call = (key: string, op: PinnedCall['op']): PinnedCall | undefined =>
      actual[key]?.calls.find((entry) => entry.op === op);
    const bound = (key: string, id: string): string | undefined =>
      actual[key]?.attachments.find((row) => row.id === id)?.conversationId;
    const refsOf = (key: string): { id: string }[] =>
      (journal(key)[0]?.attachments as { id: string }[] | undefined) ?? [];
    const SAID_PREFIX = 'task q-1 の起点の会話 conv-a へ書いた';
    const REMINDER = '知らせるだけの task なら task_set_status で done にすること。';

    // 引数の検査（呼びは一切無い）
    for (let n = 1; n <= 9; n += 1) expect(ops(`args-invalid#${String(n)}`)).toEqual([]);
    expect(text('args-invalid#1')).toBe(
      'text か attachments のどちらかが要る（どちらも空の発言は書かない）。',
    );
    expect(text('args-invalid#2')).toContain('text');
    expect(text('args-invalid#3')).toBe(text('args-invalid#1'));
    expect(text('args-invalid#6')).toContain('taskId');
    expect(text('args-invalid#7')).toBe(text('args-invalid#1'));
    expect(text('args-invalid#8')).toContain('taskId');
    // task を読む
    expect(ops('get-fails#1')).toEqual(['tasks.get']);
    expect(text('get-fails#1')).toBe('task q-1 は読めない形で入っている。何も書かなかった。');
    expect(actual['get-fails#1']?.output.isError).toBe(true);
    expect(actual['get-fails#2']?.output.thrown).toBe(true);
    expect(text('get-fails#2')).toBe('ストアが落ちた（get）');
    expect(ops('get-fails#3')).toEqual(['tasks.get']);
    expect(text('task-missing#1')).toContain('task ghost は無いので、何も書かなかった');
    expect(ops('task-missing#2')).toEqual(['tasks.get']);
    expect(text('task-no-origin#1')).toContain('は起点の会話を持たない古い task');
    expect(text('task-no-origin#2')).toContain('は起点の会話を持たない古い task');
    expect(ops('task-no-origin#3')).toEqual(['tasks.get']);
    // いまのターンの会話
    expect(text('current-turn#1')).toContain(
      'はいまのターンの会話なので、この道具では書かなかった。',
    );
    expect(text('current-turn#1')).toContain('このターンの返答として書けば、その会話へ届く。');
    expect(text('current-turn#2')).toContain(
      'このターンの返答に添付を添えるなら reply_attach を使う。',
    );
    expect(text('current-turn#3')).toContain('reply_attach');
    expect(text('current-turn#4')).toContain('このターンの返答として書けば');
    expect(text('current-turn#5')).toContain('reply_attach');
    for (let n = 1; n <= 5; n += 1) expect(ops(`current-turn#${String(n)}`)).toEqual(['tasks.get']);
    // 添付なしの成功（開いている・閉じた）
    expect(ops('say-open#1')).toEqual([
      'tasks.get',
      'journal.append',
      'context.noteTaskSaid',
      'context.postToConversation',
    ]);
    expect(text('say-open#1')).toBe(`${SAID_PREFIX}（id-1）。\n${REMINDER}`);
    expect(call('say-open#1', 'context.postToConversation')?.args).toEqual([
      'conv-a',
      'こんにちは',
    ]);
    expect(call('say-open#1', 'context.noteTaskSaid')?.args).toEqual(['q-1']);
    expect(call('say-open#3', 'context.postToConversation')?.args).toEqual([
      'conv-b',
      '待ちの task へ',
    ]);
    expect(text('say-open#3')).toContain(REMINDER);
    expect(text('say-closed#1')).not.toContain('task_set_status');
    expect(text('say-closed#1')).toContain('へ書いた（');
    expect(text('say-closed#2')).not.toContain('task_set_status');
    expect(journal('say-closed#1')[0]).toMatchObject({
      role: 'outbound',
      conversationId: 'conv-a',
    });
    expect(ops('say-no-callbacks#1')).toEqual(['tasks.get', 'journal.append']);
    expect(ops('say-no-callbacks#2')).toEqual([
      'tasks.get',
      'attachments.getMeta',
      'attachments.bind',
      'journal.append',
    ]);
    // 添付つきの成功
    expect(text('say-attach-open#1')).toBe(
      `${SAID_PREFIX}（添付 1 件つき）（id-1）。\n${REMINDER}`,
    );
    expect(ops('say-attach-open#1')).toEqual([
      'tasks.get',
      'attachments.getMeta',
      'attachments.bind',
      'journal.append',
      'context.noteTaskSaid',
      'context.postToConversation',
    ]);
    expect(call('say-attach-open#1', 'context.postToConversation')?.args).toHaveLength(3);
    expect(bound('say-attach-open#1', 'att-new')).toBe('conv-a');
    // すでに結んである添付だけなら bind を呼ばない
    expect(ops('say-attach-open#2')).not.toContain('attachments.bind');
    expect(refsOf('say-attach-open#2').map((r) => r.id)).toEqual(['att-mine']);
    expect(text('say-attach-open#2')).toContain('（添付 1 件つき）');
    expect(
      (call('say-attach-open#2', 'context.postToConversation')?.args as unknown[]).slice(0, 2),
    ).toEqual(['conv-a', '']);
    // 新しく結ぶ分と別の会話の分: 結び直さない
    expect(refsOf('say-attach-open#3').map((r) => r.id)).toEqual([
      'att-new2',
      'att-mine',
      'att-other',
    ]);
    expect(call('say-attach-open#3', 'attachments.bind')?.args).toEqual({
      ids: ['att-new2'],
      conversationId: 'conv-a',
    });
    expect(bound('say-attach-open#3', 'att-other')).toBe('conv-z');
    expect(bound('say-attach-open#3', 'att-new2')).toBe('conv-a');
    expect(text('say-attach-open#3')).toContain('（添付 3 件つき）');
    // 上のあとなので att-new・att-new2 はすでに結ばれている
    expect(ops('say-attach-open#4')).not.toContain('attachments.bind');
    expect(refsOf('say-attach-open#5').map((r) => r.id)).toEqual(['att-other']);
    expect(call('say-attach-dup-new', 'attachments.bind')?.args).toEqual({
      ids: ['att-new'],
      conversationId: 'conv-a',
    });
    expect(refsOf('say-attach-dup-new')).toHaveLength(1);
    expect(text('say-attach-closed#1')).toBe(
      'task d-1 の起点の会話 conv-a へ書いた（添付 3 件つき）（id-1）。',
    );
    expect(text('say-attach-closed#2')).toContain(
      'task c-1 の起点の会話 conv-b へ書いた（添付 1 件つき）',
    );
    expect(text('say-attach-closed#2')).toContain('（id-2）');
    expect(text('say-attach-closed#2')).not.toContain('task_set_status');
    expect(text('say-attach-default-limits')).toContain('（添付 1 件つき）');
    // 添付の検査で断る
    expect(text('attach-rejected#1')).toMatch(/^会話へは書かなかった。添付が見つからない/);
    expect(text('attach-rejected#1')).toContain('att-ghost');
    expect(text('attach-rejected#1')).toContain('何も添えていない。');
    expect(text('attach-rejected#2')).toContain('att-ghost, att-ghost2');
    expect(text('attach-rejected#3')).toContain('今回の対象:');
    expect(text('attach-rejected#4')).toContain('今回の対象: att-big1');
    expect(text('attach-rejected#5')).toContain('att-ghost');
    expect(text('attach-rejected#6')).toContain('添付 att-1 の控えを読めなかった');
    for (let n = 1; n <= 6; n += 1) {
      const key = `attach-rejected#${String(n)}`;
      expect(actual[key]?.output.isError, key).toBe(false);
      expect(ops(key)).not.toContain('attachments.bind');
      expect(ops(key)).not.toContain('journal.append');
      expect(ops(key)).not.toContain('context.postToConversation');
    }
    expect(text('attach-rejected-small-limits#1')).toContain('会話へは書かなかった。');
    expect(text('attach-rejected-small-limits#2')).toContain('（添付 1 件つき）');
    expect(text('attach-total-limit')).toContain('会話へは書かなかった。');
    // 結ぶ間に落ちる
    expect(text('attach-bind-fails')).toBe(
      '会話へは書かなかった。添付を会話へ結べなかった: Error: 置き場が落ちた（bind）。何も添えていない。',
    );
    expect(ops('attach-bind-fails')).toEqual([
      'tasks.get',
      'attachments.getMeta',
      'attachments.bind',
    ]);
    expect(text('attach-bind-race#1')).toContain(
      '添付が結ぶ間に見つからなくなった（保持期限）: att-2',
    );
    expect(ops('attach-bind-race#1')).toContain('attachments.unbind');
    expect(call('attach-bind-race#1', 'attachments.unbind')?.args).toEqual({
      ids: ['att-1'],
      target: { conversationId: 'conv-a' },
    });
    expect(text('attach-bind-race#2')).toContain('添付が結ぶ間に別の宛先へ結ばれた: att-4');
    expect(call('attach-bind-race#2', 'attachments.unbind')?.args).toEqual({
      ids: ['att-3'],
      target: { conversationId: 'conv-a' },
    });
    // 結べたものが無い（conflict だけ）なら unbind を呼ばない
    expect(text('attach-bind-race#3')).toContain('別の宛先へ結ばれた: att-1');
    expect(ops('attach-bind-race#3')).not.toContain('attachments.unbind');
    expect(actual['attach-bind-race-unbind-fails']?.output.thrown).toBe(true);
    expect(text('attach-bind-race-unbind-fails')).toBe('置き場が落ちた（unbind）');
    expect(ops('attach-bind-race-unbind-fails')).not.toContain('journal.append');
    expect(bound('attach-bind-race-unbind-fails', 'att-1')).toBe('conv-a');
    // 日誌が書けない
    expect(actual['journal-fails#1']?.output.thrown).toBe(true);
    expect(actual['journal-fails#1']?.output.errorName).toBe('JournalNotRecordedError');
    expect(text('journal-fails#1')).toContain('⚠⚠ 未記録・行為は起きていない・やり直してよい');
    expect(ops('journal-fails#1')).toEqual(['tasks.get', 'journal.append']);
    expect(ops('journal-fails#2')).toEqual(['tasks.get', 'journal.append']);
    expect(ops('journal-fails-release#1')).toEqual([
      'tasks.get',
      'attachments.getMeta',
      'attachments.bind',
      'journal.append',
      'attachments.unbind',
    ]);
    expect(call('journal-fails-release#1', 'attachments.unbind')?.args).toEqual({
      ids: ['att-new'],
      target: { conversationId: 'conv-a' },
    });
    expect(bound('journal-fails-release#1', 'att-new')).toBeUndefined();
    // すでに結んであった・別の会話の添付は戻さない
    expect(call('journal-fails-release#2', 'attachments.unbind')?.args).toEqual({
      ids: ['att-new2'],
      target: { conversationId: 'conv-a' },
    });
    expect(bound('journal-fails-release#2', 'att-mine')).toBe('conv-a');
    expect(bound('journal-fails-release#2', 'att-other')).toBe('conv-z');
    expect(ops('journal-fails-release#3')).not.toContain('attachments.unbind');
    expect(ops('journal-fails-release#4')).toContain('attachments.unbind');
    expect(actual['journal-fails-release#1']?.output.thrown).toBe(true);
    // 戻しが落ちても、元の例外（日誌の失敗）を投げる。添付は結ばれたまま
    expect(actual['journal-fails-release-fails#1']?.output.errorName).toBe(
      'JournalNotRecordedError',
    );
    expect(text('journal-fails-release-fails#1')).toContain(
      '⚠⚠ 未記録・行為は起きていない・やり直してよい',
    );
    expect(text('journal-fails-release-fails#1')).not.toContain('置き場が落ちた');
    expect(ops('journal-fails-release-fails#1')).toContain('attachments.unbind');
    expect(bound('journal-fails-release-fails#1', 'att-new')).toBe('conv-a');
    expect(ops('journal-fails-release-fails#3')).not.toContain('attachments.unbind');
  });
});
