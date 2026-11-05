import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AttachmentLimits, AttachmentMeta, AttachmentStore } from './attachment.js';
import type { ManagerPool, ManagerSendResult } from './manager.js';
import type { Job, Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_send` の出力（全文・字数・エラーか・例外で返ったか）と、日誌に足された行・ストア・pool・コールバックへの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-manager-send-output-pin.json）と丸ごと比べる。
// `clone-tools-manager-send.ts` の `managerSendTool`（ハンドラ約 106 行・入れ子 8 段の式）を小さな関数へ分けるとき、
// 出力・日誌・呼びが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MANAGER_SEND_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-manager-send-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-manager-send-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// pool は偽物（`send` だけを持つ）。本物の pool が返す「届けた・預かった・断った」の言い分けは、`sendOutcome` と `detail` を
// 場面ごとに与えて道具の側の振る舞いだけを縛る（pool 側の判定はそれぞれの既存の試験が持つ）。
// 各場面の `calls` は、道具が出した呼びの並び:
//   - `pool.send(<引数を key 順で並べた JSON>)`: 送る口。managerId・message・options（decision・requestId・attachments。beforeAnswer は "function" と書く）
//   - `pool.send.beforeAnswer(<確認の JSON>)` / `pool.send.beforeAnswer:returned`: 偽の pool が答える直前に道具のコールバックを呼んだ印と、その戻り（投げたら returned は出ない）
//   - `stores.journal.append()`: 日誌の追記の試み（書けなかった回も数える。書けた行は `journal`）
//   - `stores.tasks.get(<id>)` / `stores.tasks.setStatus(<id>)`: `closes` の読みと書き
//   - `stores.jobs.listJobs()`: 委譲に結び付いた task の探し（`noteDelegationStarted` が無ければ引かない）
//   - `stores.attachments.getMeta(<id>)` / `stores.attachments.get(<id>)`: 添付の読み（大きい添付は get しない）
//   - `context.noteDelegationStarted(<taskId>)` / `context.isSubagentCall()`: 文脈の口
// `journal` は呼んだあとに日誌へ足された行（種類・本文・grounds・id・at）。`tasksAfter` は呼んだあとの task の状態、
// `tasksUnchanged` / `jobsUnchanged` は task・委譲の台帳が呼ぶ前と同じか。`sendOutcome` は偽の pool が返した outcome（呼ばれなければ null）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。

type Args = Record<string, unknown>;

interface Pending {
  requestId: string;
  summary: string;
}

/** 偽の pool の `send` の振る舞い。`pending` が在れば、答える直前に道具の `beforeAnswer` を呼ぶ（本物の pool が回答として扱う回と同じ） */
type SendFake =
  { pending?: Pending; returns: ManagerSendResult } | { pending?: Pending; throws: unknown };

interface SeedAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  args: Args;
  /** 真なら pool を渡さない */
  noPool?: boolean;
  tasks?: Task[];
  jobs?: Job[];
  /** `tasks.get` が投げる値 */
  taskGetThrows?: 'unreadable' | 'plain';
  /** `tasks.setStatus` が投げる値 */
  setStatusThrows?: 'unreadable' | 'plain';
  /** `jobs.listJobs` が投げる */
  listJobsThrows?: boolean;
  attachments?: SeedAttachment[];
  /** 添付の読みの失敗: getMeta が投げる id・get が投げる id・get が undefined を返す id（読む間に消えた） */
  attachFail?: { getMetaThrows?: string; getThrows?: string; vanishes?: string };
  limits?: Partial<AttachmentLimits>;
  /** 真なら attachmentLimits を文脈に渡さない（既定の上限を読む） */
  defaultLimits?: boolean;
  /** `journal.append` の n 回目（1 から。書けなかった回も数える）を投げさせる */
  journalFailsAt?: number[];
  send?: SendFake;
  /** `isSubagentCall` の渡し方。'none'＝口なし・'subagent'＝口は在り、呼びがサブエージェント */
  fold?: 'none' | 'subagent';
  /** 真なら `noteDelegationStarted` を渡さない */
  noNote?: boolean;
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const PIN_URL = new URL('./clone-tools-manager-send-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MANAGER_SEND_PIN === '1';
const AT = '2026-10-27T00:00:00.000Z';

const BASE_LIMITS: AttachmentLimits = {
  maxImageBytes: 1024,
  maxFileBytes: 64,
  maxLargeFileBytes: 4096,
  maxPerMessage: 3,
  maxTotalBytes: 100,
  retentionDays: 30,
};

function task(id: string, status: Task['status'] = 'queued', closed = false): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    origin: 'human',
    title: `${id} の仕事`,
    body: `${id} の本文`,
    ...(closed ? { closedAt: AT, closedReason: '先に閉じた' } : {}),
  };
}

function job(id: string, status: Job['status'], taskId?: string): Job {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-1',
    ...(taskId === undefined ? {} : { taskId }),
    ...(status === 'running' || status === 'waiting_human' ? {} : { endedAt: AT }),
  };
}

const file = (id: string, size: number, name = `${id}.txt`): SeedAttachment => ({
  id,
  name,
  mediaType: 'text/plain',
  size,
});

const MSG = '続きを調べて。結果は報告に書く。';
const ID = 'mgr-001';
const a = (extra: Args = {}): Args => ({ managerId: ID, message: MSG, ...extra });
const PENDING: Pending = { requestId: 'req-1', summary: 'Bash を許可するか' };

const delivered: SendFake = {
  returns: { outcome: 'delivered', detail: `${ID} へ追加指示として届けた。` },
};
const answered = (pending: Pending = PENDING): SendFake => ({
  pending,
  returns: { outcome: 'answered', detail: `${pending.summary} に回答した。` },
});
const returnsOf = (
  outcome: ManagerSendResult['outcome'],
  detail: string,
  pending?: Pending,
): SendFake => ({
  ...(pending === undefined ? {} : { pending }),
  returns: { outcome, detail },
});
const closes = (...ids: string[]) => ids.map((id) => ({ id, reason: `${id} は片付いた` }));
const HELD_DETAIL = `${ID} は世代が食い違う done で、背景処理が 2 本残っているので畳めない。伝言は預かった（届けられるようになったら自動で届ける）。`;
const DECLINED_DETAIL = `${ID} は世代が食い違う done で、確認待ちが残っているので畳めない。旧セッションへも送っていない（添付付きは預からない）。`;

const SCENARIOS: Scenario[] = [
  // --- closes の検査（pool の有無・message より先に断る）
  {
    name: 'closes-too-many',
    covers: 'closes が 6 件（上限 5 を超える。何もしていない）',
    args: a({ closes: closes('t-1', 't-2', 't-3', 't-4', 't-5', 't-6') }),
    send: delivered,
  },
  {
    name: 'closes-reason-empty',
    covers: 'closes[0].reason が空文字',
    args: a({ closes: [{ id: 't-1', reason: '' }] }),
    send: delivered,
  },
  {
    name: 'closes-reason-nul-only',
    covers: 'closes[0].reason が NUL だけ（NUL を除くと空）',
    args: a({ closes: [{ id: 't-1', reason: '\u0000' }] }),
    send: delivered,
  },
  {
    name: 'closes-reason-blank',
    covers: 'closes[0].reason が空白だけ（長さは通り、空白の検査で断る）',
    args: a({ closes: [{ id: 't-1', reason: ' \n ' }] }),
    send: delivered,
  },
  {
    name: 'closes-second-reason-blank',
    covers: 'closes[1].reason が空白だけ（添字の付いた文）',
    args: a({
      closes: [
        { id: 't-1', reason: '済んだ' },
        { id: 't-2', reason: '　' },
      ],
    }),
    send: delivered,
  },
  {
    name: 'closes-bad-with-no-pool',
    covers: 'closes の違反と pool 無しが両方（closes が先。NO_POOL にならない）',
    args: a({ closes: [{ id: 't-1', reason: '' }] }),
    noPool: true,
  },
  {
    name: 'closes-bad-with-empty-message',
    covers: 'closes の違反と message 空が両方（closes が先）',
    args: a({ message: '', closes: [{ id: 't-1', reason: '' }] }),
  },
  // --- pool が無い
  { name: 'no-pool', covers: 'pool が無い（NO_POOL）', args: a(), noPool: true },
  {
    name: 'no-pool-with-closes',
    covers: 'pool が無く closes も付く（notDone の1行が末尾に付く。task は閉じない）',
    args: a({ closes: closes('t-1') }),
    noPool: true,
    tasks: [task('t-1')],
  },
  {
    name: 'no-pool-empty-message',
    covers: 'pool が無く message も空（pool の有無が先）',
    args: a({ message: '' }),
    noPool: true,
  },
  // --- message の検査
  { name: 'message-empty', covers: 'message が空文字', args: a({ message: '' }) },
  {
    name: 'message-nul-only',
    covers: 'message が NUL だけ（NUL を除くと空）',
    args: a({ message: '\u0000\u0000' }),
  },
  {
    name: 'message-empty-with-closes',
    covers: 'message が空で closes も付く（notDone の1行）',
    args: a({ message: '', closes: closes('t-1') }),
    tasks: [task('t-1')],
  },
  {
    name: 'message-empty-with-attachments',
    covers: 'message が空で添付も渡す（添付の読みに行く前に断る）',
    args: a({ message: '', attachments: ['att-1'] }),
    attachments: [file('att-1', 5)],
  },
  {
    name: 'message-whitespace-passes',
    covers: 'message が空白だけ（断らない。HTTP も通す。そのまま pool へ渡す）',
    args: a({ message: '  \n\t ' }),
    send: delivered,
  },
  {
    name: 'message-nul-inside',
    covers: 'message の途中に NUL（検査は通る。pool へは素の message を渡す）',
    args: a({ message: '前\u0000後' }),
    send: delivered,
  },
  // --- 添付
  {
    name: 'attach-empty-array',
    covers: 'attachments が空配列（options に attachments 欄を載せない）',
    args: a({ attachments: [] }),
    send: delivered,
  },
  {
    name: 'attach-one-small',
    covers: '添付1件（中身を読んで base64 で pool へ渡す）',
    args: a({ attachments: ['att-1'] }),
    attachments: [file('att-1', 5, 'build.log')],
    send: delivered,
  },
  {
    name: 'attach-dup-ids',
    covers: '同じ id を2回渡す（重複を畳む。getMeta・get は1回）',
    args: a({ attachments: ['att-1', 'att-1'] }),
    attachments: [file('att-1', 5, 'build.log')],
    send: delivered,
  },
  {
    name: 'attach-large-staged',
    covers: '大きい添付（maxFileBytes 超え。中身を読まず staged: true で渡す）',
    args: a({ attachments: ['att-big'] }),
    attachments: [file('att-big', 200, 'big.bin')],
    send: delivered,
  },
  {
    name: 'attach-default-limits',
    covers: 'attachmentLimits を文脈に渡さない（既定の上限を読む。小さい添付は通る）',
    args: a({ attachments: ['att-1'] }),
    attachments: [file('att-1', 5)],
    defaultLimits: true,
    send: delivered,
  },
  {
    name: 'attach-answer-refused-by-pool',
    covers: '確認への回答に添付を付けた（道具は渡し、pool が断る。beforeAnswer へ入らず日誌なし）',
    args: a({ attachments: ['att-1'], requestId: 'req-1', decision: 'allow' }),
    attachments: [file('att-1', 5)],
    send: returnsOf('unknown', '確認への回答には添付を載せられない（何も送っていない）'),
  },
  {
    name: 'attach-missing',
    covers: '添付が見つからない（ほかの id も getMeta まで読む・pool へ送らない）',
    args: a({ attachments: ['att-1', 'att-gone', 'att-gone-2'] }),
    attachments: [file('att-1', 5)],
    send: delivered,
  },
  {
    name: 'attach-missing-with-closes',
    covers: '添付が見つからず closes も付く（notDone の1行）',
    args: a({ attachments: ['att-gone'], closes: closes('t-1') }),
    tasks: [task('t-1')],
    send: delivered,
  },
  {
    name: 'attach-getmeta-throws',
    covers: '添付の控えの読みが失敗（文で返す。例外にしない）',
    args: a({ attachments: ['att-1'] }),
    attachments: [file('att-1', 5)],
    attachFail: { getMetaThrows: 'att-1' },
    send: delivered,
  },
  {
    name: 'attach-get-throws',
    covers: '添付の中身の読みが失敗',
    args: a({ attachments: ['att-1'] }),
    attachments: [file('att-1', 5)],
    attachFail: { getThrows: 'att-1' },
    send: delivered,
  },
  {
    name: 'attach-vanishes-while-reading',
    covers: '控えは在るが中身を読む間に消えた',
    args: a({ attachments: ['att-1'] }),
    attachments: [file('att-1', 5)],
    attachFail: { vanishes: 'att-1' },
    send: delivered,
  },
  {
    name: 'attach-too-many',
    covers: '個数の上限超え（maxPerMessage 3 に 4 件）',
    args: a({ attachments: ['a1', 'a2', 'a3', 'a4'] }),
    attachments: [file('a1', 1), file('a2', 1), file('a3', 1), file('a4', 1)],
    send: delivered,
  },
  {
    name: 'attach-total-too-large',
    covers: '合計の上限超え（小さい添付 60 + 50 > 100）',
    args: a({ attachments: ['a1', 'a2'] }),
    attachments: [file('a1', 60), file('a2', 50)],
    send: delivered,
  },
  // --- 伝言（確認に答えない送信）
  {
    name: 'deliver-plain',
    covers: '届いた（delivered・decision も requestId も無い・口なしの脚注は全文）',
    args: a(),
    send: delivered,
  },
  {
    name: 'deliver-fold-subagent',
    covers: '届いた・サブエージェントの呼び（呼び手の判定の口が在っても全文のまま）',
    args: a(),
    fold: 'subagent',
    send: delivered,
  },
  {
    name: 'deliver-decision-unused',
    covers: '届いた・requestId 無しの decision=allow（回答に当たらなかった警告が付く）',
    args: a({ decision: 'allow' }),
    send: delivered,
  },
  {
    name: 'deliver-deny-unused',
    covers: '届いた・requestId 無しの decision=deny（警告の decision が deny）',
    args: a({ decision: 'deny' }),
    send: delivered,
  },
  {
    name: 'deliver-requestid-only',
    covers: '届いた・requestId だけ（decision 無し。警告なし。pool へは requestId だけ渡す）',
    args: a({ requestId: 'req-1' }),
    send: delivered,
  },
  {
    name: 'deliver-decision-with-requestid',
    covers:
      '届いた・decision も requestId も付く（警告なし。確認が既に無く追加指示として届いた回）',
    args: a({ decision: 'allow', requestId: 'req-9' }),
    send: delivered,
  },
  {
    name: 'deliver-session-resumed',
    covers: '届いた・resume から入り直した（detail は pool の文のまま）',
    args: a(),
    send: returnsOf(
      'delivered',
      `${ID} へ追加指示として届けた（runner にこの委譲のセッションが無かったので、resume から入り直した）。`,
    ),
  },
  {
    name: 'held-plain',
    covers: '預かった（held・脚注も通常の末尾も付けない。task は閉じない）',
    args: a(),
    send: returnsOf('held', HELD_DETAIL),
  },
  {
    name: 'held-decision-unused',
    covers: '預かった・requestId 無しの decision=deny（「預かった」の警告）',
    args: a({ decision: 'deny' }),
    send: returnsOf('held', HELD_DETAIL),
  },
  {
    name: 'held-decision-with-requestid',
    covers: '預かった・decision と requestId が付く（警告なし）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: returnsOf('held', HELD_DETAIL),
  },
  {
    name: 'held-with-closes',
    covers:
      '預かった・closes も付く（notDone の1行。task は閉じない・noteDelegationStarted も呼ばない）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    jobs: [job(ID, 'running', 't-1')],
    send: returnsOf('held', HELD_DETAIL),
  },
  {
    name: 'stale-token-declined',
    covers: '鍵が古い done の委譲を畳めず断られた（declined。detail をそのまま返す。預からない）',
    args: a(),
    send: returnsOf('declined', DECLINED_DETAIL),
  },
  {
    name: 'stale-token-declined-with-closes',
    covers:
      '鍵が古く declined・closes 付き（sent でないので閉じず、「本来の作業が通っていない」の1行）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    send: returnsOf('declined', DECLINED_DETAIL),
  },
  {
    name: 'stale-token-declined-decision-no-note',
    covers:
      '鍵が古く declined・requestId 無しの decision（警告は delivered／held だけなので付かない）',
    args: a({ decision: 'allow' }),
    send: returnsOf('declined', DECLINED_DETAIL),
  },
  {
    name: 'stale-token-held-with-attachments',
    covers: '鍵が古く held・添付付き（pool へ添付を渡す。預かった文がそのまま返る）',
    args: a({ attachments: ['att-1'] }),
    attachments: [file('att-1', 5)],
    send: returnsOf('held', HELD_DETAIL),
  },
  // --- 宛先が居ない・読めない・入れない
  {
    name: 'target-unknown',
    covers: '宛先が居ない（unknown。detail をそのまま返す。警告なし）',
    args: a({ managerId: 'mgr-ghost' }),
    send: returnsOf('unknown', 'mgr-ghost というマネージャーは居ない。'),
  },
  {
    name: 'target-unknown-with-decision',
    covers: '宛先が居ない・requestId 無しの decision（unknown には警告を付けない）',
    args: a({ managerId: 'mgr-ghost', decision: 'allow' }),
    send: returnsOf('unknown', 'mgr-ghost というマネージャーは居ない。'),
  },
  {
    name: 'target-unknown-with-closes',
    covers: '宛先が居ない・closes 付き（閉じない）',
    args: a({ managerId: 'mgr-ghost', closes: closes('t-1') }),
    tasks: [task('t-1')],
    send: returnsOf('unknown', 'mgr-ghost というマネージャーは居ない。'),
  },
  {
    name: 'target-unreadable',
    covers: '台帳の行が読めない形（unreadable。送っていない）',
    args: a(),
    send: returnsOf('unreadable', `委譲 ${ID} の行は在るが読めない形で入っている。送っていない。`),
  },
  {
    name: 'target-runner-not-open',
    covers: '宛先の runner が名簿に開いていない（unknown）',
    args: a(),
    send: returnsOf(
      'unknown',
      `${ID} の runner（runner-1）は名簿に開いていない。届けられたか確かめられない。`,
    ),
  },
  {
    name: 'target-session-missing',
    covers: 'セッションが無い（session_missing。「委譲そのものは台帳に在る」の言い足しが付く）',
    args: a(),
    send: returnsOf('session_missing', 'runner にセッションが無く、resume でも入り直せなかった。'),
  },
  {
    name: 'target-session-missing-with-closes',
    covers: 'セッションが無く closes 付き（言い足しの後ろに notDone の1行。task は閉じない）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    jobs: [job(ID, 'running', 't-1')],
    send: returnsOf('session_missing', 'runner にセッションが無く、resume でも入り直せなかった。'),
  },
  // --- 許可確認への答え
  {
    name: 'answer-allow',
    covers: '許可確認に allow で答えた（先に答えの日誌→答えた。task は閉じず note も呼ぶ）',
    args: a({ decision: 'allow', requestId: 'req-1', message: 'いいよ。進めて' }),
    send: answered(),
  },
  {
    name: 'answer-deny',
    covers: '許可確認に deny で答えた',
    args: a({ decision: 'deny', requestId: 'req-1', message: '駄目。理由は本番だから' }),
    send: answered(),
  },
  {
    name: 'answer-decision-only-no-requestid',
    covers:
      'requestId 無しの decision が待ち1件に当たった（日誌の確認は pool が選んだ req-1。警告なし）',
    args: a({ decision: 'allow', message: 'いいよ' }),
    send: answered(),
  },
  {
    name: 'answer-requestid-only-no-decision',
    covers: 'requestId だけで答えた（日誌は「指定なし（runner が本文から読む）」）',
    args: a({ requestId: 'req-1', message: '進めて' }),
    send: answered(),
  },
  {
    name: 'answer-toolu-requestid',
    covers: '分類器の拒否の確認（requestId が toolu_… の形）に答えた',
    args: a({ decision: 'allow', requestId: 'toolu_01ABC', message: '許可する' }),
    send: answered({ requestId: 'toolu_01ABC', summary: 'Bash(rm -rf build) を分類器が拒否した' }),
  },
  {
    name: 'answer-long-summary-and-message',
    covers: '確認の要約が 120 字超・本文が 200 字超（日誌の抜粋が切れる。改行は畳まれる）',
    args: a({
      decision: 'allow',
      requestId: 'req-1',
      message: `長い本文。\n${'あ'.repeat(260)}`,
    }),
    send: answered({ requestId: 'req-1', summary: `長い要約 ${'い'.repeat(200)}` }),
  },
  {
    name: 'answer-unreadable-decision-text',
    covers:
      '答えは届いたが decision が読み取れず安全側で拒否（detail は pool の文のまま・answered 扱い）',
    args: a({ requestId: 'req-1', message: 'うーん' }),
    send: {
      pending: PENDING,
      returns: {
        outcome: 'answered',
        detail: `${PENDING.summary} への回答が読み取れず、安全側で拒否した（decision が無く、承認とも拒否とも読めなかった）。許可するなら decision: 'allow' を付けて答え直すこと。`,
      },
    },
  },
  {
    name: 'answer-with-closes',
    covers: '答えた・closes 付き（答えの日誌の後に task を done にする日誌）',
    args: a({ decision: 'allow', requestId: 'req-1', closes: closes('t-1') }),
    tasks: [task('t-1')],
    jobs: [job(ID, 'waiting_human', 't-1')],
    send: answered(),
  },
  {
    name: 'answer-with-note-task',
    covers: '答えた・委譲が task に結び付く（noteDelegationStarted(t-1)）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    jobs: [job(ID, 'waiting_human', 't-1')],
    send: answered(),
  },
  {
    name: 'answer-requestid-mismatch',
    covers: 'requestId が待っていない（unknown。beforeAnswer へ入らず日誌なし。警告なし）',
    args: a({ decision: 'allow', requestId: 'req-ghost' }),
    send: returnsOf(
      'unknown',
      `req-ghost という確認は ${ID} で待っていない（既に解けたか、別のマネージャーのもの）。`,
    ),
  },
  {
    name: 'answer-ambiguous-without-requestid',
    covers: '複数を待っていて requestId が無い（unknown。beforeAnswer へ入らず日誌なし）',
    args: a({ decision: 'allow' }),
    send: returnsOf(
      'unknown',
      `${ID} は複数の確認を同時に待っている。requestId を指定して答えること: req-1（Bash を許可するか） / req-2（Edit を許可するか）`,
    ),
  },
  {
    name: 'answer-already-resolved-retracts',
    covers: '先に答えの日誌を書いたが runner が既に解いていた（unknown → 打ち消しの日誌）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: returnsOf(
      'unknown',
      'req-1 は runner 側で既に解けている。台帳の待ちからも外した。',
      PENDING,
    ),
  },
  {
    name: 'answer-already-resolved-retract-fails',
    covers: '打ち消しの日誌も書けない（落とす。出力は変わらない）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    journalFailsAt: [2],
    send: returnsOf('unknown', 'req-1 は runner 側で既に解けている。', PENDING),
  },
  {
    name: 'answer-retract-long-detail',
    covers: '打ち消しの理由が 200 字超（抜粋が切れる）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: returnsOf('unknown', `解けている。${'う'.repeat(260)}`, PENDING),
  },
  {
    name: 'answer-then-session-missing-retracts',
    covers: '日誌のあと session_missing（打ち消す。言い足しも付く）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: returnsOf('session_missing', 'runner にセッションが無かった。', PENDING),
  },
  {
    name: 'answer-then-held-retracts',
    covers: '日誌のあと held（打ち消す。「預かった」の警告は requestId 付きなので無し）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: returnsOf('held', HELD_DETAIL, PENDING),
  },
  {
    name: 'answer-then-delivered-retracts',
    covers: '日誌のあと delivered（answered でないので打ち消す。closes は閉じる）',
    args: a({ decision: 'allow', requestId: 'req-1', closes: closes('t-1') }),
    tasks: [task('t-1')],
    send: returnsOf('delivered', `${ID} へ追加指示として届けた。`, PENDING),
  },
  {
    name: 'answer-journal-fails',
    covers:
      '答えの日誌が書けない（beforeAnswer が投げ、pool は答えない。JournalNotRecordedError で例外・打ち消しは行が無いので書かない・note も呼ばない）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    journalFailsAt: [1],
    send: answered(),
  },
  {
    name: 'answer-journal-fails-with-closes',
    covers: '答えの日誌が書けず closes 付き（例外。task は閉じない）',
    args: a({ decision: 'allow', requestId: 'req-1', closes: closes('t-1') }),
    tasks: [task('t-1')],
    journalFailsAt: [1],
    send: answered(),
  },
  // --- 送る口が例外
  {
    name: 'send-throws-no-pending',
    covers: '送る口が例外（確認に当たらず日誌なし。打ち消さず、そのまま例外）',
    args: a(),
    send: { throws: new Error('runner が落ちた') },
  },
  {
    name: 'send-throws-string',
    covers: '送る口が Error でない値（文字列）を投げる',
    args: a(),
    send: { throws: '文字列で投げた' },
  },
  {
    name: 'send-throws-with-closes',
    covers: '送る口が例外・closes 付き（閉じない。例外がそのまま返る）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    send: { throws: new Error('runner が落ちた') },
  },
  {
    name: 'send-throws-after-answer-journal',
    covers: '答えの日誌のあと送る口が例外（理由付きで打ち消してから例外を投げ直す）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: { pending: PENDING, throws: new Error('runner.answer が落ちた') },
  },
  {
    name: 'send-throws-after-answer-journal-string',
    covers: '答えの日誌のあと文字列が投げられる（打ち消しの理由は reasonOf の文字列）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    send: { pending: PENDING, throws: '切れた' },
  },
  {
    name: 'send-throws-after-answer-journal-retract-fails',
    covers: '打ち消しも書けない（落として、元の例外を投げる）',
    args: a({ decision: 'allow', requestId: 'req-1' }),
    journalFailsAt: [2],
    send: { pending: PENDING, throws: new Error('runner.answer が落ちた') },
  },
  // --- noteDelegationStarted（委譲の task を引く）
  {
    name: 'note-job-with-task',
    covers: '届いた・委譲が task に結び付く（noteDelegationStarted(t-1)。他の委譲は見ない）',
    args: a(),
    jobs: [job('mgr-other', 'running', 't-9'), job(ID, 'running', 't-1')],
    send: delivered,
  },
  {
    name: 'note-job-without-task',
    covers: '届いた・委譲に task が結び付いていない（noteDelegationStarted(undefined)）',
    args: a(),
    jobs: [job(ID, 'running')],
    send: delivered,
  },
  {
    name: 'note-job-missing',
    covers: '届いた・台帳に委譲の行が無い（noteDelegationStarted(undefined)）',
    args: a(),
    send: delivered,
  },
  {
    name: 'note-list-jobs-throws',
    covers: '届いた・台帳が読めない（握って noteDelegationStarted(undefined)。出力は通常どおり）',
    args: a(),
    listJobsThrows: true,
    send: delivered,
  },
  {
    name: 'note-missing',
    covers: '届いた・noteDelegationStarted が無い（listJobs も引かない）',
    args: a(),
    noNote: true,
    jobs: [job(ID, 'running', 't-1')],
    send: delivered,
  },
  // --- closes
  {
    name: 'closes-empty-array',
    covers: 'closes が空配列（何も足さない。通常の出力）',
    args: a({ closes: [] }),
    send: delivered,
  },
  {
    name: 'closes-one-ok',
    covers: '届いた・closes 1件（task を done にし、末尾に1行。日誌1行）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    send: delivered,
  },
  {
    name: 'closes-two-and-note',
    covers: '届いた・closes 2件（日誌2行・末尾に2行・note は委譲の task）',
    args: a({ closes: closes('t-1', 't-2') }),
    tasks: [task('t-1'), task('t-2', 'waiting')],
    jobs: [job(ID, 'running', 't-1')],
    send: delivered,
  },
  {
    name: 'closes-duplicate-id',
    covers: '同じ id を2回（2回目は「既に閉じてある」）',
    args: a({ closes: closes('t-1', 't-1') }),
    tasks: [task('t-1')],
    send: delivered,
  },
  {
    name: 'closes-task-missing',
    covers: 'closes の task が無い（その行の言い分。送信は届いた扱い）',
    args: a({ closes: closes('t-ghost') }),
    send: delivered,
  },
  {
    name: 'closes-already-closed',
    covers: 'closes の task が既に閉じている',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1', 'done', true)],
    send: delivered,
  },
  {
    name: 'closes-already-done-status',
    covers:
      'closes の task が done だが closedAt 無し（setStatus が unchanged か rejected。その行の言い分）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1', 'done')],
    send: delivered,
  },
  {
    name: 'closes-get-unreadable',
    covers: 'closes の task の読みが UnreadableTaskError（その行の言い分。isError にしない）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    taskGetThrows: 'unreadable',
    send: delivered,
  },
  {
    name: 'closes-get-throws-plain',
    covers: 'closes の task の読みがほかの例外（その行は「閉じる処理が失敗した」・isError）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    taskGetThrows: 'plain',
    send: delivered,
  },
  {
    name: 'closes-setstatus-unreadable',
    covers: 'closes の setStatus が UnreadableTaskError',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    setStatusThrows: 'unreadable',
    send: delivered,
  },
  {
    name: 'closes-setstatus-throws-plain',
    covers: 'closes の setStatus がほかの例外（isError。後ろの行は続ける）',
    args: a({ closes: closes('t-1', 't-2') }),
    tasks: [task('t-1'), task('t-2')],
    setStatusThrows: 'plain',
    send: delivered,
  },
  {
    name: 'closes-journal-fails',
    covers:
      'task は done になったが日誌が書けない（「task は done にしている」の行・isError。送信の結果は先頭に残る）',
    args: a({ closes: closes('t-1') }),
    tasks: [task('t-1')],
    journalFailsAt: [1],
    send: delivered,
  },
  {
    name: 'closes-after-answer-journal-fails',
    covers: '答えた・closes の日誌が書けない（答えの日誌は書けた・isError）',
    args: a({ decision: 'allow', requestId: 'req-1', closes: closes('t-1') }),
    tasks: [task('t-1')],
    journalFailsAt: [2],
    send: answered(),
  },
];

const ALL_KEYS: string[] = SCENARIOS.map((scenario) => scenario.name);

interface PinnedOutput {
  length: number;
  isError: boolean;
  thrown: boolean;
  errorName: string | null;
  sendOutcome: string | null;
  calls: string[];
  journal: Record<string, unknown>[];
  tasksAfter: { id: string; status: string; closedReason: string | null }[];
  tasksUnchanged: boolean;
  jobsUnchanged: boolean;
  text: string;
}

interface PinFile {
  /** 場面ごとの字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
}

function fakeAttachmentStore(scenario: Scenario): AttachmentStore {
  const seeded = new Map((scenario.attachments ?? []).map((item) => [item.id, item]));
  const metaOf = (item: SeedAttachment): AttachmentMeta => ({
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    size: item.size,
    sha256: `sha-${item.id}`,
    createdAt: AT,
  });
  const fail = scenario.attachFail ?? {};
  return {
    async getMeta(id: string) {
      if (fail.getMetaThrows === id) throw new Error('控えのストアが落ちた');
      const item = seeded.get(id);
      return item === undefined ? undefined : metaOf(item);
    },
    async get(id: string) {
      if (fail.getThrows === id) throw new Error('中身のストアが落ちた');
      if (fail.vanishes === id) return undefined;
      const item = seeded.get(id);
      if (item === undefined) return undefined;
      return { meta: metaOf(item), bytes: new TextEncoder().encode('a'.repeat(item.size)) };
    },
  } as unknown as AttachmentStore;
}

function labelOf(storeName: string, method: string, args: unknown[]): string {
  const detail =
    (storeName === 'tasks' && (method === 'get' || method === 'setStatus')) ||
    (storeName === 'attachments' && (method === 'getMeta' || method === 'get'))
      ? JSON.stringify(args[0])
      : '';
  return `stores.${storeName}.${method}(${detail})`;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)),
    );
  });
}

async function runScenario(scenario: Scenario): Promise<PinnedOutput> {
  const calls: string[] = [];
  const base = createMemoryStores();
  for (const seeded of scenario.tasks ?? []) await base.tasks.add(seeded);
  for (const seeded of scenario.jobs ?? []) await base.jobs.putJob(seeded);
  const tasksBefore = JSON.stringify(await base.tasks.list({ includeClosed: true }));
  const jobsBefore = JSON.stringify(await base.jobs.listJobs());
  const journalBefore = (await base.journal.list({ order: 'asc' })).length;

  let appendCount = 0;
  const failAt = scenario.journalFailsAt ?? [];
  const composed = {
    ...base,
    attachments: fakeAttachmentStore(scenario),
    tasks: {
      ...base.tasks,
      get: async (id: string) => {
        if (scenario.taskGetThrows === 'unreadable')
          throw new UnreadableTaskError('行が壊れている');
        if (scenario.taskGetThrows === 'plain') throw new Error('task のストアが落ちた');
        return base.tasks.get(id);
      },
      setStatus: async (...args: Parameters<typeof base.tasks.setStatus>) => {
        if (scenario.setStatusThrows === 'unreadable')
          throw new UnreadableTaskError('行が壊れている');
        if (scenario.setStatusThrows === 'plain') throw new Error('task の書き込みが落ちた');
        return base.tasks.setStatus(...args);
      },
    },
    jobs: {
      ...base.jobs,
      listJobs: async () => {
        if (scenario.listJobsThrows === true) throw new Error('委譲の台帳が読めない');
        return base.jobs.listJobs();
      },
    },
    journal: {
      ...base.journal,
      append: async (entry: Parameters<typeof base.journal.append>[0]) => {
        appendCount += 1;
        if (failAt.includes(appendCount)) throw new Error('日誌のストアが落ちた');
        return base.journal.append(entry);
      },
    },
  } as unknown as ReturnType<typeof createMemoryStores>;
  const stores = new Proxy(composed, {
    get(target, storeName) {
      const store = Reflect.get(target, storeName) as unknown;
      if (typeof store !== 'object' || store === null) return store;
      return new Proxy(store, {
        get(storeTarget, method) {
          const member = Reflect.get(storeTarget, method) as unknown;
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            if (storeName === 'tasks' || storeName === 'jobs' || storeName === 'attachments') {
              calls.push(labelOf(String(storeName), String(method), args));
            } else if (storeName === 'journal' && method === 'append') {
              calls.push('stores.journal.append()');
            }
            return (member as (...a: unknown[]) => unknown).apply(storeTarget, args);
          };
        },
      });
    },
  });

  let sendOutcome: string | null = null;
  const sendFake: SendFake = scenario.send ?? delivered;
  const pool = {
    async send(
      managerId: string,
      message: string,
      options: { beforeAnswer?: (pending: Pending) => Promise<void> } & Record<
        string,
        unknown
      > = {},
    ) {
      const { beforeAnswer, ...rest } = options;
      calls.push(
        `pool.send(${sortedJson({ managerId, message, options: { ...rest, beforeAnswer: typeof beforeAnswer } })})`,
      );
      if (sendFake.pending !== undefined && beforeAnswer !== undefined) {
        calls.push(`pool.send.beforeAnswer(${sortedJson(sendFake.pending)})`);
        await beforeAnswer(sendFake.pending);
        calls.push('pool.send.beforeAnswer:returned');
      }
      if ('throws' in sendFake) {
        sendOutcome = 'throws';
        throw sendFake.throws;
      }
      sendOutcome = sendFake.returns.outcome;
      return sendFake.returns;
    },
  } as unknown as ManagerPool;

  const fold = scenario.fold ?? 'none';
  const tools = createCloneTools({
    stores,
    emit: () => {
      calls.push('emit');
    },
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.defaultLimits === true
      ? {}
      : { attachmentLimits: { ...BASE_LIMITS, ...scenario.limits } }),
    ...(scenario.noNote === true
      ? {}
      : {
          noteDelegationStarted: (taskId: string | undefined) => {
            calls.push(`context.noteDelegationStarted(${String(taskId)})`);
          },
        }),
    ...(fold === 'none'
      ? {}
      : {
          isSubagentCall: () => {
            calls.push('context.isSubagentCall()');
            return fold === 'subagent';
          },
        }),
    ...(scenario.noPool === true ? {} : { managers: pool }),
  });
  const found = tools.find((entry) => entry.name === 'manager_send');
  if (!found) throw new Error('manager_send が無い');

  const finish = async (
    output: Pick<PinnedOutput, 'text' | 'isError' | 'thrown' | 'errorName'>,
  ): Promise<PinnedOutput> => {
    const journal = (await base.journal.list({ order: 'asc' })).slice(journalBefore);
    const tasksAfter = (await base.tasks.list({ includeClosed: true })).entries
      .map((item) => ({
        id: item.id,
        status: item.status,
        closedReason: item.closedReason ?? null,
      }))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    return {
      length: output.text.length,
      isError: output.isError,
      thrown: output.thrown,
      errorName: output.errorName,
      sendOutcome,
      calls,
      journal: JSON.parse(JSON.stringify(journal)) as Record<string, unknown>[],
      tasksAfter,
      tasksUnchanged:
        JSON.stringify(await base.tasks.list({ includeClosed: true })) === tasksBefore,
      jobsUnchanged: JSON.stringify(await base.jobs.listJobs()) === jobsBefore,
      text: output.text,
    };
  };
  try {
    const result = await found.handler(scenario.args as never, {} as never);
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    return await finish({ text, isError: result.isError === true, thrown: false, errorName: null });
  } catch (error) {
    return await finish({
      text: error instanceof Error ? error.message : String(error),
      isError: true,
      thrown: true,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function runAll(): Promise<Record<string, PinnedOutput>> {
  const out: Record<string, PinnedOutput> = {};
  for (const scenario of SCENARIOS) {
    out[scenario.name] = await runScenario(scenario);
  }
  return out;
}

describe('manager_send の出力の固定（場面ごとの全文・字数・日誌・呼びの並び）', () => {
  let actual: Record<string, PinnedOutput> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    actual = await runAll();
    if (UPDATE) {
      const out: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(out, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(new Set(ALL_KEYS).size, '場面の名前が重複している').toBe(ALL_KEYS.length);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1]));
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.length);
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    const key = scenario.name;
    it(`${key} の出力・日誌・呼びが固定値と同じ（${scenario.covers}）`, () => {
      const want = pinned.scenarios[key];
      const got = actual[key];
      expect(want, `${key} が固定値に無い`).toBeDefined();
      expect(got, `${key} が実際の出力に無い`).toBeDefined();
      // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
      expect(
        got?.text.length,
        `場面 ${key} の字数が変わった: 固定値 ${String(want?.length)} 字 → いま ${String(got?.text.length)} 字`,
      ).toBe(want?.length);
      expect(
        got?.text,
        `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.text.length)} 字で同じ）`,
      ).toBe(want?.text);
      expect(
        { isError: got?.isError, thrown: got?.thrown, errorName: got?.errorName },
        `場面 ${key} の isError／例外で返ったか／例外の名前が変わった`,
      ).toEqual({
        isError: want?.isError,
        thrown: want?.thrown,
        errorName: want?.errorName,
      });
      expect(
        got?.journal.length,
        `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
      ).toBe(want?.journal.length);
      expect(got?.journal, `場面 ${key} の日誌に足された行の中身がずれた`).toEqual(want?.journal);
      expect(got?.calls, `場面 ${key} のストア・pool・コールバックへの呼びの並びがずれた`).toEqual(
        want?.calls,
      );
      expect(got?.sendOutcome, `場面 ${key} の偽の pool が返した outcome が変わった`).toBe(
        want?.sendOutcome,
      );
      expect(got?.tasksAfter, `場面 ${key} の呼んだあとの task の状態がずれた`).toEqual(
        want?.tasksAfter,
      );
      expect(
        { tasksUnchanged: got?.tasksUnchanged, jobsUnchanged: got?.jobsUnchanged },
        `場面 ${key} の task／委譲の台帳の書き込みの有無が変わった`,
      ).toEqual({ tasksUnchanged: want?.tasksUnchanged, jobsUnchanged: want?.jobsUnchanged });
    });
  });

  it('同じ入力で2回回すと、全場面で同じ出力・日誌・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('この道具は委譲の台帳へ書かず、emit もしない（全場面）', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.jobsUnchanged, `${key}: 委譲の台帳が変わった`).toBe(true);
      expect(actual[key]?.calls, `${key}: emit した`).not.toContain('emit');
    }
  });

  it('送る口を呼ばない場面（断る場面）では、日誌もストアも呼ぶ前と同じで、送る口も note も呼ばれない', () => {
    const refusals = ALL_KEYS.filter(
      (key) => !(actual[key]?.calls ?? []).some((call) => call.startsWith('pool.send(')),
    );
    expect(refusals.length).toBeGreaterThanOrEqual(18);
    for (const key of refusals) {
      const calls = actual[key]?.calls ?? [];
      expect(
        actual[key]?.sendOutcome,
        `${key}: 送る口を呼んでいないのに outcome が在る`,
      ).toBeNull();
      expect(actual[key]?.journal, `${key}: 送らないのに日誌に行が足された`).toEqual([]);
      expect(actual[key]?.tasksUnchanged, `${key}: 送らないのに task が変わった`).toBe(true);
      expect(
        calls.some((call) => call.includes('journal.append') || call.includes('setStatus')),
        `${key}: 送らないのに日誌・task の書きを試みた`,
      ).toBe(false);
      expect(
        calls.some((call) => call.startsWith('context.noteDelegationStarted')),
        `${key}: 送らないのに note を呼んだ`,
      ).toBe(false);
    }
  });

  it('task を書く（closes が効く）のは、送る口が delivered／answered を返した場面だけ', () => {
    for (const key of ALL_KEYS) {
      const outcome = actual[key]?.sendOutcome;
      const calls = actual[key]?.calls ?? [];
      if (calls.some((call) => call.startsWith('stores.tasks.setStatus('))) {
        expect(
          ['delivered', 'answered'],
          `${key}: ${String(outcome)} なのに task を書いた`,
        ).toContain(outcome);
      }
      if (outcome !== 'delivered' && outcome !== 'answered') {
        expect(actual[key]?.tasksUnchanged, `${key}: 送れていないのに task が変わった`).toBe(true);
        expect(
          calls.some((call) => call.startsWith('context.noteDelegationStarted')),
          `${key}: 送れていないのに note を呼んだ`,
        ).toBe(false);
      }
    }
  });

  it('答えの日誌は答える口（beforeAnswer）の中で書かれ、答えられなかった回は打ち消しが続く', () => {
    const retractMark = '効いていない（答えは届いていない）';
    for (const key of ALL_KEYS) {
      const calls = actual[key]?.calls ?? [];
      const journal = actual[key]?.journal ?? [];
      const sendAt = calls.findIndex((call) => call.startsWith('pool.send('));
      const hookAt = calls.findIndex((call) => call.startsWith('pool.send.beforeAnswer('));
      const decisions = journal.map((entry) => String(entry.decision));
      const retracts = decisions.filter((line) => line.includes(retractMark));
      if (hookAt < 0) {
        expect(
          journal.length === 0 || key.startsWith('closes-'),
          `${key}: 確認に当たらないのに日誌が足された`,
        ).toBe(true);
        expect(retracts, `${key}: 答えの日誌が無いのに打ち消した`).toEqual([]);
        continue;
      }
      expect(hookAt, `${key}: beforeAnswer が送る口の前に呼ばれた`).toBeGreaterThan(sendAt);
      expect(calls[hookAt + 1], `${key}: beforeAnswer の直後が日誌の追記でない`).toBe(
        'stores.journal.append()',
      );
      const answerWritten = calls.includes('pool.send.beforeAnswer:returned');
      const outcome = actual[key]?.sendOutcome;
      // 答えの日誌が書けたうえで、答えが届かなかった（answered 以外・例外）ときだけ打ち消す
      expect(retracts.length, `${key}: 打ち消しの数が合わない`).toBeLessThanOrEqual(
        answerWritten && outcome !== 'answered' ? 1 : 0,
      );
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    const calls = (key: string): string[] => actual[key]?.calls ?? [];
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const sendCall = (key: string): string =>
      calls(key).find((call) => call.startsWith('pool.send(')) ?? '';
    const sent = (key: string): boolean => sendCall(key) !== '';
    const decisions = (key: string): string[] =>
      journal(key).map((entry) => String(entry.decision));
    const RETRACT = '効いていない（答えは届いていない）';
    const NOT_DONE = '本来の作業が通っていないので、closes の行は1行も閉じていない。';
    const UNUSED = '回答としては使っていない';
    // closes の検査
    for (const key of [
      'closes-too-many',
      'closes-reason-empty',
      'closes-reason-nul-only',
      'closes-reason-blank',
      'closes-second-reason-blank',
      'closes-bad-with-no-pool',
      'closes-bad-with-empty-message',
    ]) {
      expect(text(key), `${key}`).toContain('何もしていない。');
      expect(calls(key), `${key}`).toEqual([]);
    }
    expect(text('closes-too-many')).toContain('closes は使えない（5件以下）');
    expect(text('closes-second-reason-blank')).toContain('closes[1].reason');
    expect(text('closes-bad-with-no-pool')).not.toContain('委譲できない場面');
    // pool・message
    expect(text('no-pool')).toContain('いまは委譲できない場面');
    expect(calls('no-pool')).toEqual([]);
    expect(text('no-pool-with-closes')).toContain('委譲できない場面');
    expect(text('no-pool-with-closes')).toContain(NOT_DONE);
    expect(text('no-pool-empty-message')).toContain('いまは委譲できない場面');
    expect(text('message-empty')).toContain('message は使えない');
    expect(text('message-nul-only')).toBe(text('message-empty'));
    expect(text('message-empty-with-closes')).toContain(NOT_DONE);
    expect(calls('message-empty-with-attachments')).toEqual([]);
    expect(sent('message-whitespace-passes')).toBe(true);
    expect(sendCall('message-whitespace-passes')).toContain('"message":"  \\n\\t "');
    expect(sendCall('message-nul-inside')).toContain('前\\u0000後');
    // 添付
    expect(sendCall('attach-empty-array')).not.toContain('"attachments"');
    expect(sendCall('attach-one-small')).toContain('"data":"YWFhYWE="');
    expect(
      calls('attach-dup-ids').filter((call) => call.startsWith('stores.attachments.')),
    ).toEqual(['stores.attachments.getMeta("att-1")', 'stores.attachments.get("att-1")']);
    expect(sendCall('attach-large-staged')).toContain('"staged":true');
    expect(calls('attach-large-staged')).not.toContain('stores.attachments.get("att-big")');
    expect(sent('attach-default-limits')).toBe(true);
    expect(sendCall('attach-answer-refused-by-pool')).toContain('"attachments"');
    expect(sendCall('attach-answer-refused-by-pool')).toContain('"requestId":"req-1"');
    expect(text('attach-missing')).toContain('att-gone, att-gone-2');
    expect(calls('attach-missing')).toContain('stores.attachments.getMeta("att-gone-2")');
    expect(text('attach-missing-with-closes')).toContain(NOT_DONE);
    expect(text('attach-getmeta-throws')).toContain('添付 att-1 の控えを読めなかった');
    expect(text('attach-get-throws')).toContain('添付 att-1 の中身を読めなかった');
    expect(text('attach-vanishes-while-reading')).toContain('読む間に消えた');
    expect(text('attach-too-many')).toContain('1 発言に添えられるのは 3 個まで');
    expect(text('attach-total-too-large')).toContain('合計');
    for (const key of [
      'attach-missing',
      'attach-getmeta-throws',
      'attach-get-throws',
      'attach-vanishes-while-reading',
      'attach-too-many',
      'attach-total-too-large',
    ]) {
      expect(sent(key), `${key}: 添付を断ったのに送った`).toBe(false);
    }
    // 伝言
    expect(text('deliver-plain')).toContain(`[${ID}] ${ID} へ追加指示として届けた。`);
    expect(text('deliver-plain')).toContain('（「届けた」は resume の口が成功を返したところまで。');
    expect(calls('deliver-plain')).not.toContain('context.isSubagentCall()');
    expect(text('deliver-fold-subagent')).toBe(text('deliver-plain'));
    // 呼び手の計器を外したので、口が在っても道具は呼ばない（以前はここで `toContain` だった）
    expect(calls('deliver-fold-subagent')).not.toContain('context.isSubagentCall()');
    expect(text('deliver-decision-unused')).toContain('decision（allow）を付けたが');
    expect(text('deliver-decision-unused')).toContain(UNUSED);
    expect(text('deliver-decision-unused')).toContain('本文は追加指示として届けた。');
    expect(text('deliver-deny-unused')).toContain('decision（deny）');
    expect(text('deliver-requestid-only')).not.toContain(UNUSED);
    expect(text('deliver-decision-with-requestid')).not.toContain(UNUSED);
    expect(sendCall('deliver-requestid-only')).toContain(
      '"options":{"beforeAnswer":"function","requestId":"req-1"}',
    );
    expect(text('deliver-session-resumed')).toContain('resume から入り直した');
    // 預かり・断り
    expect(text('held-plain')).toContain('伝言は預かった');
    expect(text('held-plain')).not.toContain('resume の口');
    expect(text('held-decision-unused')).toContain('本文は追加指示として預かった。');
    expect(text('held-decision-with-requestid')).not.toContain(UNUSED);
    expect(text('held-with-closes')).toContain(NOT_DONE);
    expect(text('stale-token-declined')).toBe(
      `${ID} は世代が食い違う done で、確認待ちが残っているので畳めない。旧セッションへも送っていない（添付付きは預からない）。`,
    );
    expect(text('stale-token-declined-with-closes')).toContain(NOT_DONE);
    expect(text('stale-token-declined-decision-no-note')).not.toContain(UNUSED);
    expect(sendCall('stale-token-held-with-attachments')).toContain('"attachments"');
    expect(text('stale-token-held-with-attachments')).toContain('預かった');
    // 宛先
    expect(text('target-unknown')).toBe('mgr-ghost というマネージャーは居ない。');
    expect(text('target-unknown-with-decision')).toBe(text('target-unknown'));
    expect(text('target-unknown-with-closes')).toContain(NOT_DONE);
    expect(text('target-unreadable')).toContain('読めない形で入っている');
    expect(text('target-runner-not-open')).toContain('名簿に開いていない');
    expect(text('target-session-missing')).toContain('**この委譲そのものは台帳に在る**');
    expect(text('target-session-missing')).toContain(`[${ID}] runner にセッションが無く`);
    expect(text('target-session-missing-with-closes')).toContain(NOT_DONE);
    expect(calls('target-session-missing-with-closes')).not.toContain('stores.jobs.listJobs()');
    // 答え
    expect(sendCall('answer-allow')).toContain(
      '"options":{"beforeAnswer":"function","decision":"allow","requestId":"req-1"}',
    );
    expect(calls('answer-allow').slice(0, 5)).toEqual([
      expect.stringContaining('pool.send('),
      expect.stringContaining('pool.send.beforeAnswer('),
      'stores.journal.append()',
      'pool.send.beforeAnswer:returned',
      'stores.jobs.listJobs()',
    ]);
    expect(text('answer-allow')).toBe('Bash を許可するか に回答した。');
    expect(decisions('answer-allow')[0]).toContain(
      `クローンが担当 ${ID} の確認（req-1: Bash を許可するか）に自分で答える（decision=allow。抜粋: いいよ。進めて）`,
    );
    expect(journal('answer-allow')[0]?.grounds).toContain('人間に聞かずに答えた');
    expect(decisions('answer-deny')[0]).toContain('decision=deny');
    expect(decisions('answer-decision-only-no-requestid')[0]).toContain('req-1: Bash を許可するか');
    expect(sendCall('answer-decision-only-no-requestid')).not.toContain('"requestId"');
    expect(text('answer-decision-only-no-requestid')).not.toContain(UNUSED);
    expect(decisions('answer-requestid-only-no-decision')[0]).toContain(
      'decision=指定なし（runner が本文から読む）',
    );
    expect(decisions('answer-toolu-requestid')[0]).toContain('確認（toolu_01ABC: ');
    expect(decisions('answer-long-summary-and-message')[0]).not.toContain('\n');
    expect(decisions('answer-long-summary-and-message')[0]).toContain('…');
    expect(text('answer-unreadable-decision-text')).toContain('安全側で拒否した');
    expect(journal('answer-with-closes')).toHaveLength(2);
    expect(actual['answer-with-closes']?.tasksAfter[0]?.status).toBe('done');
    expect(text('answer-with-closes')).toContain('closes t-1: t-1 を done にした。');
    expect(calls('answer-with-note-task')).toContain('context.noteDelegationStarted(t-1)');
    expect(calls('answer-requestid-mismatch')).not.toContain('stores.journal.append()');
    expect(journal('answer-requestid-mismatch')).toEqual([]);
    expect(text('answer-requestid-mismatch')).toContain('待っていない');
    expect(journal('answer-ambiguous-without-requestid')).toEqual([]);
    expect(text('answer-ambiguous-without-requestid')).toContain('複数の確認を同時に待っている');
    // 打ち消し
    expect(journal('answer-already-resolved-retracts')).toHaveLength(2);
    expect(decisions('answer-already-resolved-retracts')[1]).toContain(RETRACT);
    expect(decisions('answer-already-resolved-retracts')[1]).toContain('（req-1）へ答えるとした');
    expect(text('answer-already-resolved-retracts')).toBe(
      'req-1 は runner 側で既に解けている。台帳の待ちからも外した。',
    );
    expect(journal('answer-already-resolved-retract-fails')).toHaveLength(1);
    expect(
      calls('answer-already-resolved-retract-fails').filter((c) => c === 'stores.journal.append()'),
    ).toHaveLength(2);
    expect(decisions('answer-retract-long-detail')[1]).toContain('…');
    expect(decisions('answer-then-session-missing-retracts')[1]).toContain(RETRACT);
    expect(text('answer-then-session-missing-retracts')).toContain(
      '**この委譲そのものは台帳に在る**',
    );
    expect(decisions('answer-then-held-retracts')[1]).toContain(RETRACT);
    expect(text('answer-then-held-retracts')).not.toContain(UNUSED);
    expect(decisions('answer-then-delivered-retracts')[1]).toContain(RETRACT);
    expect(text('answer-then-delivered-retracts')).toContain('closes t-1: t-1 を done にした。');
    expect(actual['answer-journal-fails']?.errorName).toBe('JournalNotRecordedError');
    expect(calls('answer-journal-fails')).not.toContain('pool.send.beforeAnswer:returned');
    expect(
      calls('answer-journal-fails').filter((c) => c === 'stores.journal.append()'),
    ).toHaveLength(1);
    expect(journal('answer-journal-fails')).toEqual([]);
    expect(actual['answer-journal-fails-with-closes']?.tasksUnchanged).toBe(true);
    expect(text('answer-journal-fails')).toContain('やり直してよい');
    // 例外
    expect(actual['send-throws-no-pending']?.thrown).toBe(true);
    expect(actual['send-throws-no-pending']?.text).toBe('runner が落ちた');
    expect(journal('send-throws-no-pending')).toEqual([]);
    expect(actual['send-throws-string']?.errorName).toBe('string');
    expect(actual['send-throws-with-closes']?.tasksUnchanged).toBe(true);
    expect(actual['send-throws-after-answer-journal']?.thrown).toBe(true);
    expect(decisions('send-throws-after-answer-journal')[1]).toContain(
      '理由: 送信が例外で終わった: Error: runner.answer が落ちた',
    );
    expect(decisions('send-throws-after-answer-journal-string')[1]).toContain('切れた');
    expect(actual['send-throws-after-answer-journal-retract-fails']?.text).toBe(
      'runner.answer が落ちた',
    );
    expect(journal('send-throws-after-answer-journal-retract-fails')).toHaveLength(1);
    // note
    expect(calls('note-job-with-task')).toContain('context.noteDelegationStarted(t-1)');
    expect(calls('note-job-without-task')).toContain('context.noteDelegationStarted(undefined)');
    expect(calls('note-job-missing')).toContain('context.noteDelegationStarted(undefined)');
    expect(calls('note-list-jobs-throws')).toContain('context.noteDelegationStarted(undefined)');
    expect(calls('note-missing')).not.toContain('stores.jobs.listJobs()');
    // closes
    expect(text('closes-empty-array')).toBe(text('deliver-plain'));
    expect(text('closes-one-ok')).toContain('\ncloses t-1: t-1 を done にした。');
    expect(journal('closes-one-ok')).toHaveLength(1);
    expect(text('closes-two-and-note')).toContain('closes t-2: t-2 を done にした。');
    expect(calls('closes-two-and-note')).toContain('context.noteDelegationStarted(t-1)');
    expect(text('closes-duplicate-id')).toContain('closes t-1: t-1 は既に');
    expect(text('closes-task-missing')).toContain('closes t-ghost: task t-ghost は無い');
    expect(text('closes-already-closed')).toContain('既に');
    expect(text('closes-already-closed')).toContain('先に閉じた');
    expect(actual['closes-already-closed']?.isError).toBe(false);
    expect(text('closes-get-unreadable')).toContain('読めない形で入っている');
    expect(actual['closes-get-unreadable']?.isError).toBe(false);
    expect(text('closes-get-throws-plain')).toContain('閉じる処理が失敗した（');
    expect(actual['closes-get-throws-plain']?.isError).toBe(true);
    expect(text('closes-setstatus-unreadable')).toContain('読めない形で入っている');
    expect(text('closes-setstatus-throws-plain')).toContain('closes t-2: 閉じる処理が失敗した（');
    expect(actual['closes-setstatus-throws-plain']?.isError).toBe(true);
    expect(text('closes-journal-fails')).toContain(
      '**task は done にしている**が、日誌に残せていない',
    );
    expect(actual['closes-journal-fails']?.isError).toBe(true);
    expect(text('closes-journal-fails')).toContain(`[${ID}] ${ID} へ追加指示として届けた。`);
    expect(text('closes-after-answer-journal-fails')).toContain('日誌に残せていない');
    expect(journal('closes-after-answer-journal-fails')).toHaveLength(1);
  });
});
