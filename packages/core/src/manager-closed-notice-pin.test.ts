import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import { createManagerPool } from './manager.js';
import {
  EVENT_SETTLED,
  EVENT_SETTLED_LAG,
  trackEventSettled,
} from './manager-event-settled.test-support.js';
import type { ManagerRecord } from './manager.js';
import { ManagerClosedNotice } from './manager-closed-notice.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import type { RunnerEvent } from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job } from './schema.js';
import { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';
import { createMemoryStores } from './testing.js';
import { UsageWake } from './usage-wake.js';

// 出来事の処理の完了を `phases` へ記す: `#closeJob` の完了が何周で戻るかを数えるため（仕組みは test-support の注記）。
const phases: string[] = [];
let settledTracker: { restore(): void } | undefined;
beforeAll(() => {
  settledTracker = trackEventSettled(phases);
});
afterAll(() => {
  settledTracker?.restore();
});

// `Pool#handleEvent` の `case 'closed'` の段3（`#closeJob`）が呼ぶ、知らせの 3 本
// （peer の閉じの知らせ `#noticePeerCloseAtEnd`・report 無しの done の知らせ `#noticeSilentDone`・畳んでいた報告の在庫を配る `#flushWithheldAtClose`）を、
// 外から見える結果（受信箱の知らせの全文と印・台帳の `silentDoneNotifiedFor`・日誌の行・書き込みと知らせの順・像を外す周回）だけで縛る。
// 切り出し前は `Pool` の同名のメソッド、切り出し後は `manager-closed-notice.ts`。
// 期待の文字列と周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流してマイクロタスクを流しきる。合流窓のタイマーは fake timers で進める。時計は注入する。

const JOB_ID = 'mgr-closed-notice-pin';
const RUNNER_ID = 'runner-primary';
const T0 = '2026-11-01T00:00:00.000Z';
const T_NOW_MS = Date.parse('2026-11-01T01:00:00.000Z');
const T_PEER = '2026-11-01T00:30:00.000Z';
const WINDOW_MS = 1_000;
const QUOTA_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";
const HELD_BODY = '畳まれていた報告の本文ABC';

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

const PENDING_PEER_CLOSE: NonNullable<Job['pendingPeerCloseNotice']> = {
  reason: 'failed',
  peers: [
    { id: 'peer-zzz', provider: 'codex', interrupted: '調査の途中で止まった', reason: 'failed' },
  ],
  at: T_PEER,
};

interface OpenOptions {
  job?: Partial<Job>;
  /** 畳んだ報告の在庫を 1 本積んでおく（`awaitingBackground` 付きの done の報告）。 */
  withheld?: boolean;
}

async function open(options: OpenOptions = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // 合流窓のタイマー（窓の長さの `setTimeout`）が立った回数。`afterEach` の `useRealTimers` が元へ戻す。
  const windowTimers = { opened: 0 };
  const fakeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    if (ms === WINDOW_MS) windowTimers.opened += 1;
    return fakeSetTimeout(handler, ms);
  }) as typeof setTimeout;
  const clock = { ms: T_NOW_MS };
  let emit = null as ((event: RunnerEvent) => void) | null;
  const runner = fakeRunnerClient({
    runnerId: RUNNER_ID,
    async connect(onEvent) {
      emit = onEvent;
    },
    async list() {
      return [];
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const registry = fakeRunnerRegistry({
    list: () => Promise.resolve([runner]),
    get: (runnerId) => Promise.resolve(runnerId === RUNNER_ID ? runner : null),
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: T0,
    updatedAt: T0,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: RUNNER_ID,
    ...options.job,
  });
  // 台帳・日誌・知らせの書き込みを 1 本の列に残す
  const order: string[] = [];
  const journal = stores.journal;
  const append = journal.append.bind(journal);
  journal.append = (entry) => {
    if (entry.type === 'exchange') order.push(`journal:${entry.text.slice(0, 48)}`);
    return append(entry);
  };
  const jobs = stores.jobs;
  const putJob = jobs.putJob.bind(jobs);
  jobs.putJob = (row) => {
    order.push(`put:${row.status}${row.silentDoneNotifiedFor === undefined ? '' : '/marked'}`);
    return putJob(row);
  };
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    now: () => clock.ms,
    post: (event) => {
      if (event.type === 'manager_message')
        order.push(`post:${event.kind}:${event.text.slice(0, 24)}`);
      inbox.push(event);
    },
    runners: registry,
    synthesizedNoticeWindowMs: WINDOW_MS,
  });
  await pool.restore();
  await settle();
  // 像を畳む前に残る目印（拒否 1 件）を載せる。畳まれたかは `denials()` が空になるかで見る。
  emit?.({
    type: 'permission_denied',
    managerId: JOB_ID,
    toolUseId: 'tu-1',
    tool: 'Bash',
    via: 'result',
  });
  await settle();
  expect(pool.denials(JOB_ID)).toHaveLength(1);
  if (options.withheld === true) {
    emit?.({
      type: 'report',
      managerId: JOB_ID,
      reportId: 'rep-1',
      text: HELD_BODY,
      status: 'done',
      awaitingBackground: { count: 1, breakdown: 'shell×1' },
    } as RunnerEvent);
    await settle();
  }
  inbox.length = 0;
  order.length = 0;
  const exchangeBefore = (await stores.journal.list({ types: ['exchange'] })).length;
  const windowsBefore = windowTimers.opened;
  return {
    pool,
    stores,
    inbox,
    order,
    clock,
    async push(event: RunnerEvent): Promise<void> {
      emit?.(event);
      await settle();
    },
    /** 合流窓を閉じて配らせる（fake timers を窓の長さより先へ進める）。 */
    async closeWindows(): Promise<void> {
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
      await settle();
    },
    /** 出来事を流した直後から、各観測が初めて成り立つまでの microtask の周回数（`await Promise.resolve()` の回数）。 */
    async hops(event: RunnerEvent): Promise<string[]> {
      const seen: string[] = [];
      let seenLength = 0;
      let timer = false;
      let retired = false;
      let settled = false;
      phases.length = 0;
      emit?.(event);
      for (let i = 1; i <= 200; i += 1) {
        await Promise.resolve();
        while (seenLength < order.length) {
          seen.push(`${String(i)}: ${order[seenLength] ?? ''}`);
          seenLength += 1;
        }
        if (!timer && windowTimers.opened > windowsBefore) {
          timer = true;
          seen.push(`${String(i)}: window-timer`);
        }
        if (!retired && pool.denials(JOB_ID).length === 0) {
          retired = true;
          seen.push(`${String(i)}: retired`);
        }
        if (!settled && phases.includes(EVENT_SETTLED)) {
          settled = true;
          seen.push(`${String(i - EVENT_SETTLED_LAG)}: settled`);
        }
      }
      return seen;
    },
    windowsOpened(): number {
      return windowTimers.opened - windowsBefore;
    },
    async job(): Promise<Job | null> {
      return stores.jobs.getJob(JOB_ID);
    },
    async exchanges(): Promise<string[]> {
      const entries = await stores.journal.list({ types: ['exchange'] });
      return entries
        .flatMap((entry) => (entry.type === 'exchange' ? [entry.text] : []))
        .reverse()
        .slice(exchangeBefore);
    },
    messages(): { kind: string; text: string; flags: string }[] {
      return inbox.flatMap((event) =>
        event.type === 'manager_message'
          ? [
              {
                kind: event.kind,
                text: event.text,
                flags: [
                  event.synthesized === true ? 'synthesized' : '',
                  event.quotaStop === true ? 'quotaStop' : '',
                  event.foldWhenBack === undefined ? '' : 'foldWhenBack',
                ]
                  .filter((flag) => flag !== '')
                  .join('+'),
              },
            ]
          : [],
      );
    },
  };
}

function closed(
  status: 'done' | 'failed' | 'lost',
  reason = `${status} で畳んだ`,
): Extract<RunnerEvent, { type: 'closed' }> {
  return { type: 'closed', managerId: JOB_ID, status, reason };
}

// 報告を受け取ったあとの idle としての done（`reportSeenInSession` が 'seen'）にする台帳の欄。
// `closed` の写しがセッションの始まり・ターンの始まりを T_NOW に書くので、それより後の時刻を置く。
const REPORT_SEEN: Partial<Job> = { lastReportAt: '2026-11-01T02:00:00.000Z' };

describe('peer の閉じの知らせ（#noticePeerCloseAtEnd）', () => {
  it('failed: 台帳に残る peer の閉じの知らせを、受信箱へ即時に 1 件出す（窓を通さない）。台帳の知らせは消さない', async () => {
    const s = await open({ job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE } });

    await s.push(closed('failed'));

    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "synthesized+foldWhenBack",
          "kind": "report",
          "text": "failed で畳んだ
      （分類: 器の資源による落ち方かどうかは、この欄では判定できなかった。枠に当たった場合・セッションが切れた場合もこの欄には出ない —— 本文と lastFailure を見ること）
      （この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった）",
        },
        {
          "flags": "",
          "kind": "report",
          "text": "[mgr-closed-notice-pin] （alteroid より: peer 1 本を閉じた（担当のセッションが終わった（落ちた・失効した））。閉じた peer: codex[peer-zzz]。走っていた背景ターンは途中で終わった: codex[peer-zzz] 調査の途中で止まった。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）",
        },
      ]
    `);
    expect((await s.job())?.pendingPeerCloseNotice).toEqual(PENDING_PEER_CLOSE);
    await s.pool.stop();
  });

  it('lost: lost でも同じ知らせが 1 件出る', async () => {
    const s = await open({ job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE } });

    await s.push(closed('lost'));

    expect(s.messages().map((message) => message.text)).toMatchInlineSnapshot(`
      [
        "[mgr-closed-notice-pin] （alteroid より: peer 1 本を閉じた（担当のセッションが終わった（落ちた・失効した））。閉じた peer: codex[peer-zzz]。走っていた背景ターンは途中で終わった: codex[peer-zzz] 調査の途中で止まった。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）",
      ]
    `);
    await s.pool.stop();
  });

  it('done: done では出ない（台帳に知らせが在っても）。report を受け取った後の done は無音', async () => {
    const s = await open({ job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE, ...REPORT_SEEN } });

    await s.push(closed('done'));
    await s.closeWindows();

    expect(s.messages()).toEqual([]);
    expect((await s.job())?.pendingPeerCloseNotice).toEqual(PENDING_PEER_CLOSE);
    await s.pool.stop();
  });

  it('知らせが台帳に無い failed: peer の知らせは出ない（失敗の知らせだけ）', async () => {
    const s = await open();

    await s.push(closed('failed'));
    await s.closeWindows();

    expect(s.messages().map((message) => message.text)).toMatchInlineSnapshot(`
      [
        "failed で畳んだ
      （分類: 器の資源による落ち方かどうかは、この欄では判定できなかった。枠に当たった場合・セッションが切れた場合もこの欄には出ない —— 本文と lastFailure を見ること）
      （この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった）",
      ]
    `);
    await s.pool.stop();
  });

  it('同じ at の知らせは 1 回だけ。at が違えば（新しく積まれた知らせは）もう一度出る', async () => {
    const s = await open({ job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE, ...REPORT_SEEN } });
    const peerNotices = (): number =>
      s.messages().filter((message) => message.text.includes('codex[peer-zzz]')).length;

    await s.push(closed('failed'));
    expect(peerNotices()).toBe(1);

    // done へ戻してからもう一度 failed で閉じる（failed の重複は `closed` の段2が早く返すので、done を挟んで段3へ通す）。at は同じ。
    await s.push(closed('done'));
    await s.push(closed('failed'));
    expect(peerNotices()).toBe(1);

    // done の担当へ新しい peer の閉じが積まれる（終端の担当へは台帳に積まず直に知らせるので、done を挟む）。at が進むので、次の failed でもう一度出る。
    await s.push(closed('done'));
    s.clock.ms += 60_000;
    await s.push({
      type: 'parked_peers_closed',
      managerId: JOB_ID,
      reason: 'failed',
      peers: [{ id: 'peer-yyy', provider: 'codex', interrupted: '別の途中' }],
    });
    await s.push(closed('failed'));
    expect(peerNotices()).toBe(2);
    expect(
      s
        .messages()
        .filter((message) => message.text.includes('codex[peer-zzz]'))
        .map((message) => message.text),
    ).toMatchInlineSnapshot(`
      [
        "[mgr-closed-notice-pin] （alteroid より: peer 1 本を閉じた（担当のセッションが終わった（落ちた・失効した））。閉じた peer: codex[peer-zzz]。走っていた背景ターンは途中で終わった: codex[peer-zzz] 調査の途中で止まった。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）",
        "[mgr-closed-notice-pin] （alteroid より: peer 2 本を閉じた（担当のセッションが終わった（落ちた・失効した））。閉じた peer: codex[peer-zzz], codex[peer-yyy]。走っていた背景ターンは途中で終わった: codex[peer-zzz] 調査の途中で止まった / codex[peer-yyy] 別の途中。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）",
      ]
    `);
    await s.pool.stop();
  });
});

describe('peer の知らせと畳んだ報告の在庫が重なる failed（3 本の順の相互作用）', () => {
  it('peer の知らせの `emit` が先に窓を閉じて在庫を失敗の知らせへ運ぶので、在庫を配る 3 本目は何も足さない（在庫の本文は 1 回だけ届く）', async () => {
    const s = await open({ withheld: true, job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE } });

    await s.push(closed('failed', 'マネージャーのセッションが落ちた: Error: boom'));
    await s.closeWindows();

    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "synthesized",
          "kind": "report",
          "text": "マネージャーのセッションが落ちた: Error: boom
      （分類: 器の資源による落ち方かどうかは、この欄では判定できなかった。枠に当たった場合・セッションが切れた場合もこの欄には出ない —— 本文と lastFailure を見ること）
      （この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった）

      （この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 2026-11-01T01:00:00.000Z / 最後 2026-11-01T01:00:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-closed-notice-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      - 2026-11-01T01:00:00.000Z 畳まれていた報告の本文ABC
      ）",
        },
        {
          "flags": "",
          "kind": "report",
          "text": "[mgr-closed-notice-pin] （alteroid より: peer 1 本を閉じた（担当のセッションが終わった（落ちた・失効した））。閉じた peer: codex[peer-zzz]。走っていた背景ターンは途中で終わった: codex[peer-zzz] 調査の途中で止まった。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）",
        },
      ]
    `);
    expect(s.messages().filter((message) => message.text.includes(HELD_BODY))).toHaveLength(1);
    await s.pool.stop();
  });
});

describe('report 無しの closed(done) の知らせ（#noticeSilentDone）', () => {
  it('none（report を一度も受け取っていない）: 日誌へ先に書き、印を台帳へ書いてから、窓へ積む。窓が閉じると 1 通の知らせになる', async () => {
    const s = await open();

    await s.push(closed('done'));
    // 積んだだけではまだ配られない
    expect(s.messages()).toEqual([]);
    await s.closeWindows();

    expect(s.order).toMatchInlineSnapshot(`
      [
        "put:done",
        "journal:[判断] [mgr-closed-notice-pin] report 無しの closed(d",
        "put:done/marked",
        "post:report:この委譲 mgr-closed-notice-p",
        "journal:[間引き] [mgr-closed-notice-pin] 機構が合成した知らせを 1 件、1件",
      ]
    `);
    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "synthesized",
          "kind": "report",
          "text": "この委譲 mgr-closed-notice-pin は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。
      **成果が出ているとは限らない** — 成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。確かめるまで「終わった」とも「終わっていない」とも言わない。
      closed の reason: done で畳んだ",
        },
      ]
    `);
    expect((await s.exchanges()).filter((text) => text.includes('report 無しの closed(done)')))
      .toMatchInlineSnapshot(`
      [
        "[判断] [mgr-closed-notice-pin] report 無しの closed(done)（report は一度も受け取っていない）。クローンへ知らせる: この委譲 mgr-closed-notice-pin は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。
      **成果が出ているとは限らない** — 成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。確かめるまで「終わった」とも「終わっていない」とも言わない。
      closed の reason: done で畳んだ",
      ]
    `);
    expect((await s.job())?.silentDoneNotifiedFor).toMatchInlineSnapshot(
      `"2026-11-01T01:00:00.000Z"`,
    );
    await s.pool.stop();
  });

  it('unknown（report の時刻が日時として読めない）: 知らせる側へ倒し、本文に判定できなかった旨を足す', async () => {
    const s = await open({ job: { lastReportAt: 'not-a-date' } });

    await s.push(closed('done'));
    await s.closeWindows();

    expect(s.messages().map((message) => message.text)).toMatchInlineSnapshot(`
      [
        "この委譲 mgr-closed-notice-pin は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。
      **成果が出ているとは限らない** — 成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。確かめるまで「終わった」とも「終わっていない」とも言わない。
      このセッションで report を受け取ったかは判定できなかった（この欄を書く前の古い行などで比較する時刻が無い）ため、念のため知らせている。
      closed の reason: done で畳んだ",
      ]
    `);
    expect((await s.exchanges()).filter((text) => text.includes('report 無しの closed(done)')))
      .toMatchInlineSnapshot(`
      [
        "[判断] [mgr-closed-notice-pin] report 無しの closed(done)（判定できないので知らせる側へ倒した）。クローンへ知らせる: この委譲 mgr-closed-notice-pin は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。
      **成果が出ているとは限らない** — 成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。確かめるまで「終わった」とも「終わっていない」とも言わない。
      このセッションで report を受け取ったかは判定できなかった（この欄を書く前の古い行などで比較する時刻が無い）ため、念のため知らせている。
      closed の reason: done で畳んだ",
      ]
    `);
    await s.pool.stop();
  });

  it('seen（report を受け取った後の idle）: 何も知らせず、印も日誌も書かない', async () => {
    const s = await open({ job: REPORT_SEEN });

    await s.push(closed('done'));
    await s.closeWindows();

    expect(s.messages()).toEqual([]);
    expect(s.order.filter((entry) => entry.startsWith('journal:'))).toEqual([]);
    expect((await s.job())?.silentDoneNotifiedFor).toBeUndefined();
    await s.pool.stop();
  });

  it('alreadyNotified（同じセッションは知らせ済み）: 日誌へ「知らせ済み」だけを書き、受信箱へは出さず、印も書き直さない', async () => {
    const s = await open({ job: { silentDoneNotifiedFor: '2026-11-01T01:00:00.000Z' } });

    await s.push(closed('done'));
    await s.closeWindows();

    expect(s.messages()).toEqual([]);
    expect(s.order).toMatchInlineSnapshot(`
      [
        "put:done/marked",
        "journal:[判断] [mgr-closed-notice-pin] report 無しの closed(d",
      ]
    `);
    expect(await s.exchanges()).toMatchInlineSnapshot(`
      [
        "[判断] [mgr-closed-notice-pin] report 無しの closed(done)。同じセッション（2026-11-01T01:00:00.000Z）については知らせ済みなので重ねて知らせない: done で畳んだ",
      ]
    `);
    await s.pool.stop();
  });

  it('alreadyNotified でも seen なら日誌も書かない（seen が先に効く）', async () => {
    const s = await open({
      job: { silentDoneNotifiedFor: '2026-11-01T01:00:00.000Z', ...REPORT_SEEN },
    });

    await s.push(closed('done'));

    expect(s.order.filter((entry) => entry.startsWith('journal:'))).toEqual([]);
    await s.pool.stop();
  });

  it('畳んだ報告の在庫が在る done: 知らせを重ねない（在庫の配りだけ）。印も立てない', async () => {
    const s = await open({ withheld: true });

    await s.push(closed('done'));
    await s.closeWindows();

    expect(s.order).toMatchInlineSnapshot(`
      [
        "put:done",
        "put:done",
        "post:report:[mgr-closed-notice-pin] ",
      ]
    `);
    expect(s.messages().map((message) => message.text)).toMatchInlineSnapshot(`
      [
        "[mgr-closed-notice-pin] この委譲は終わった（status=done）。背景処理の完了待ちで畳んでいた報告をまとめて配る。

      （この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 2026-11-01T01:00:00.000Z / 最後 2026-11-01T01:00:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-closed-notice-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      - 2026-11-01T01:00:00.000Z 畳まれていた報告の本文ABC
      ）",
      ]
    `);
    expect((await s.job())?.silentDoneNotifiedFor).toBeUndefined();
    await s.pool.stop();
  });

  it('failed / lost では出ない（done のときだけ）', async () => {
    for (const status of ['failed', 'lost'] as const) {
      const s = await open();
      await s.push(closed(status));
      await s.closeWindows();
      expect(s.messages().map((message) => message.text.includes('report を出さないまま'))).toEqual(
        s.messages().map(() => false),
      );
      expect((await s.job())?.silentDoneNotifiedFor).toBeUndefined();
      await s.pool.stop();
    }
  });

  it('二度目の done（同じセッション）は印が台帳に在るので、重ねて知らせない', async () => {
    const s = await open();

    await s.push(closed('done'));
    await s.closeWindows();
    const first = s.messages().length;
    await s.push(closed('done'));
    await s.closeWindows();

    expect(first).toBe(1);
    expect(s.messages()).toHaveLength(1);
    await s.pool.stop();
  });
});

describe('畳んでいた報告の在庫を配る（#flushWithheldAtClose）', () => {
  it('在庫が無い closed: 何も配らない（done・seen）', async () => {
    const s = await open({ job: REPORT_SEEN });

    await s.push(closed('done'));
    await s.closeWindows();

    expect(s.messages()).toEqual([]);
    await s.pool.stop();
  });

  it('窓が開いていない（done）: 窓を使わず、その場で 1 通を配る（合成の印は付かない・窓のタイマーも立てない）', async () => {
    const s = await open({ withheld: true, job: REPORT_SEEN });

    await s.push(closed('done'));

    expect(s.windowsOpened()).toBe(0);
    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "",
          "kind": "report",
          "text": "[mgr-closed-notice-pin] この委譲は終わった（status=done）。背景処理の完了待ちで畳んでいた報告をまとめて配る。

      （この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 2026-11-01T01:00:00.000Z / 最後 2026-11-01T01:00:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-closed-notice-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      - 2026-11-01T01:00:00.000Z 畳まれていた報告の本文ABC
      ）",
        },
      ]
    `);
    await s.pool.stop();
  });

  it('窓が開いている（failed。closed_failed が先に窓を開ける）: 在庫を窓へ移し、1 通にまとめて窓が閉じたときに配る。枠の印は付かない', async () => {
    const s = await open({ withheld: true });

    await s.push(closed('failed', 'マネージャーのセッションが落ちた: Error: boom'));
    // 窓が閉じるまで配られない
    expect(s.messages()).toEqual([]);
    await s.closeWindows();

    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "synthesized",
          "kind": "report",
          "text": "（1つの出来事について 2 件の知らせをまとめた）

      --- 1/2（セッションが落ちた） ---
      マネージャーのセッションが落ちた: Error: boom
      （分類: 器の資源による落ち方かどうかは、この欄では判定できなかった。枠に当たった場合・セッションが切れた場合もこの欄には出ない —— 本文と lastFailure を見ること）
      （この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった）

      --- 2/2（委譲の終了と、背景処理の完了待ちで畳んでいた報告の配り） ---
      [mgr-closed-notice-pin] この委譲は終わった（status=failed）。背景処理の完了待ちで畳んでいた報告をまとめて配る。

      （この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 2026-11-01T01:00:00.000Z / 最後 2026-11-01T01:00:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-closed-notice-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      - 2026-11-01T01:00:00.000Z 畳まれていた報告の本文ABC
      ）",
        },
      ]
    `);
    await s.pool.stop();
  });

  it('枠で落ちた回（closed_failed に枠の印）: その印を closed_withheld_flush が受け継ぐので、束は quotaStop 付きで届く', async () => {
    const s = await open({ withheld: true });

    await s.push(
      closed(
        'failed',
        `マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${QUOTA_LIMIT}`,
      ),
    );
    await s.closeWindows();

    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "synthesized+quotaStop",
          "kind": "report",
          "text": "（1つの出来事について 2 件の知らせをまとめた）

      --- 1/2（セッションが落ちた） ---
      マネージャーのセッションが落ちた: Error: Claude Code returned an error result: You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue
      （分類: 器の資源による落ち方かどうかは、この欄では判定できなかった。枠に当たった場合・セッションが切れた場合もこの欄には出ない —— 本文と lastFailure を見ること）
      （この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった）

      --- 2/2（委譲の終了と、背景処理の完了待ちで畳んでいた報告の配り） ---
      [mgr-closed-notice-pin] この委譲は終わった（status=failed）。背景処理の完了待ちで畳んでいた報告をまとめて配る。

      （この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 2026-11-01T01:00:00.000Z / 最後 2026-11-01T01:00:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-closed-notice-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      - 2026-11-01T01:00:00.000Z 畳まれていた報告の本文ABC
      ）",
        },
      ]
    `);
    await s.pool.stop();
  });

  it('lost（窓なし）: closed_failed は failed のときだけ積むので窓は開かず、lost の在庫の知らせもその場で配る', async () => {
    const s = await open({ withheld: true });

    await s.push(closed('lost'));
    await s.closeWindows();

    expect(s.messages()).toMatchInlineSnapshot(`
      [
        {
          "flags": "",
          "kind": "report",
          "text": "[mgr-closed-notice-pin] この委譲は終わった（status=lost）。背景処理の完了待ちで畳んでいた報告をまとめて配る。

      （この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 2026-11-01T01:00:00.000Z / 最後 2026-11-01T01:00:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-closed-notice-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      - 2026-11-01T01:00:00.000Z 畳まれていた報告の本文ABC
      ）",
        },
      ]
    `);
    await s.pool.stop();
  });
});

describe('microtask の周回数（`#closeJob` の中の 3 本の位置を数える歯）', () => {
  // 協力者へ移したあと、呼び元で `await` を足す・外す・口を `async` の皮で包む・3 本の順を入れ替えると、ここの数や並びが変わる。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('done・report 無し（none）: 台帳の書き込み → 日誌 → 印の書き込み → 窓 → 像の畳み → 完了の周回', async () => {
    const s = await open();
    expect(await s.hops(closed('done'))).toMatchInlineSnapshot(`
      [
        "1: put:done",
        "3: journal:[判断] [mgr-closed-notice-pin] report 無しの closed(d",
        "5: put:done/marked",
        "8: window-timer",
        "9: retired",
        "12: settled",
      ]
    `);
    await s.pool.stop();
  });

  it('done・seen: 3 本とも何も配らないときの、像の畳み・完了の周回', async () => {
    const s = await open({ job: REPORT_SEEN });
    expect(await s.hops(closed('done'))).toMatchInlineSnapshot(`
      [
        "1: put:done",
        "4: retired",
        "7: settled",
      ]
    `);
    await s.pool.stop();
  });

  it('done・alreadyNotified: 日誌 1 本だけを書く分岐の周回', async () => {
    const s = await open({ job: { silentDoneNotifiedFor: '2026-11-01T01:00:00.000Z' } });
    expect(await s.hops(closed('done'))).toMatchInlineSnapshot(`
      [
        "1: put:done/marked",
        "3: journal:[判断] [mgr-closed-notice-pin] report 無しの closed(d",
        "6: retired",
        "9: settled",
      ]
    `);
    await s.pool.stop();
  });

  it('done・在庫あり: 在庫をその場で配る周回（silent done を呼ばない）', async () => {
    const s = await open({ withheld: true });
    expect(await s.hops(closed('done'))).toMatchInlineSnapshot(`
      [
        "1: put:done",
        "3: put:done",
        "3: post:report:[mgr-closed-notice-pin] ",
        "3: retired",
        "6: settled",
      ]
    `);
    await s.pool.stop();
  });

  it('failed・peer の知らせあり・在庫あり（窓あり）: 失敗の知らせ → peer の知らせ → 在庫の窓への積み → 像の畳み → 完了の周回', async () => {
    const s = await open({ withheld: true, job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE } });
    expect(await s.hops(closed('failed', 'マネージャーのセッションが落ちた: Error: boom')))
      .toMatchInlineSnapshot(`
      [
        "1: put:failed",
        "3: journal:[障害] [mgr-closed-notice-pin] マネージャーのセッションが落ちた: E",
        "5: window-timer",
        "6: put:failed",
        "6: post:report:マネージャーのセッションが落ちた: Error:",
        "6: journal:[間引き] [mgr-closed-notice-pin] 機構が合成した知らせを 1 件、1件",
        "6: post:report:[mgr-closed-notice-pin] ",
        "6: retired",
        "9: settled",
      ]
    `);
    await s.pool.stop();
  });

  it('lost・peer の知らせあり: peer の知らせ → 像の畳み → 完了の周回', async () => {
    const s = await open({ job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE } });
    expect(await s.hops(closed('lost'))).toMatchInlineSnapshot(`
      [
        "1: put:lost",
        "3: post:report:[mgr-closed-notice-pin] ",
        "3: retired",
        "6: settled",
      ]
    `);
    await s.pool.stop();
  });
});

// 口（`emit`・`queueSynthesizedNotice`）が同期で throw したときの伝わり方。
// 切り出し前（`Pool` の同名のメソッド）は、同期の段の throw はそのまま `#closeJob` の拒否になり、`#closeJob` は途中で止まる。
// 口を `async` の皮で包むと、throw は捨てられた Promise の拒否へ移り、`#closeJob` は止まらずに最後まで走る（等価ではない）。
// 期待の値は、今の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの（仕様を先に書いたものではない）。
// 実時間では待たない（`setImmediate` で 2 回譲るだけ。`unhandledRejection` は microtask が尽きたあとに届くため）。
// 口の差し替えは `SynthesizedNoticeWindows` のプロトタイプ（`Pool` が持つ実物の口の先）で行い、条件に合う呼び出しだけ投げる。
describe('口が同期で throw したときの伝わり方（#closeJob の拒否）', () => {
  const BOOM = 'boom-sync';

  async function yieldMacrotask(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  type Throwing = 'emit' | 'queue';

  /**
   * 条件に合う口の呼び出しだけ投げさせ、`closed` を流して、`#handleEvent` の経路から見えることを集める。
   * 未処理の拒否を捕まえる処理（vitest 自身の受け手を一時的に外す）は `finally` で必ず元へ戻す。
   */
  async function probe(options: {
    open: OpenOptions;
    event: Extract<RunnerEvent, { type: 'closed' }>;
    throwing: Throwing;
    when: (args: readonly unknown[]) => boolean;
  }) {
    const s = await open(options.open);
    const unhandled: string[] = [];
    const stderrLines: string[] = [];
    let settleUsageWake = 0;
    const originalEmit = SynthesizedNoticeWindows.prototype.emit;
    const originalQueue = SynthesizedNoticeWindows.prototype.queue;
    const originalSettle = UsageWake.prototype.settleUsageWake;
    const thrown: unknown[][] = [];
    const maybeThrow = (args: unknown[]): void => {
      if (options.when(args)) {
        thrown.push(args);
        throw new Error(BOOM);
      }
    };
    if (options.throwing === 'emit') {
      SynthesizedNoticeWindows.prototype.emit = function (
        this: SynthesizedNoticeWindows,
        ...args: Parameters<SynthesizedNoticeWindows['emit']>
      ): void {
        maybeThrow(args);
        originalEmit.apply(this, args);
      };
    } else {
      SynthesizedNoticeWindows.prototype.queue = function (
        this: SynthesizedNoticeWindows,
        ...args: Parameters<SynthesizedNoticeWindows['queue']>
      ): void {
        maybeThrow(args);
        originalQueue.apply(this, args);
      };
    }
    UsageWake.prototype.settleUsageWake = function (
      this: UsageWake,
      ...args: Parameters<UsageWake['settleUsageWake']>
    ): Promise<void> {
      settleUsageWake += 1;
      return originalSettle.apply(this, args);
    };
    const savedListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on('unhandledRejection', onUnhandled);
    setStderrSinkForTesting((line) => {
      if (line.includes('runner からの合図の処理'))
        stderrLines.push(line.replace(/^\S+: \S+ /, ''));
    });
    try {
      phases.length = 0;
      await s.push(options.event);
      await yieldMacrotask();
      await s.closeWindows();
      await yieldMacrotask();
      return {
        s,
        thrownCount: thrown.length,
        unhandled,
        stderrLines,
        settled: phases.includes(EVENT_SETTLED),
        retired: s.pool.denials(JOB_ID).length === 0,
        settleUsageWake,
      };
    } finally {
      setStderrSinkForTesting(null);
      process.off('unhandledRejection', onUnhandled);
      for (const listener of savedListeners) process.on('unhandledRejection', listener);
      SynthesizedNoticeWindows.prototype.emit = originalEmit;
      SynthesizedNoticeWindows.prototype.queue = originalQueue;
      UsageWake.prototype.settleUsageWake = originalSettle;
    }
  }

  const peerNotice = (args: readonly unknown[]): boolean =>
    typeof args[2] === 'string' && args[2].includes('alteroid より');
  const flushNote = (args: readonly unknown[]): boolean =>
    typeof args[2] === 'string' && args[2].includes('背景処理の完了待ちで畳んでいた報告');

  it('emit（peer の閉じの知らせ）が throw: #closeJob は同期の throw で途中で止まる（在庫の flush・像の畳み・枠の起こし直しは走らない）。拒否は #onEvent から呼び元へ戻り、握られず未処理の拒否になる', async () => {
    const r = await probe({
      open: { withheld: true, job: { pendingPeerCloseNotice: PENDING_PEER_CLOSE } },
      event: closed('failed', 'マネージャーのセッションが落ちた: Error: boom'),
      throwing: 'emit',
      when: peerNotice,
    });
    expect({
      thrownCount: r.thrownCount,
      unhandled: r.unhandled,
      stderrLines: r.stderrLines,
      settled: r.settled,
      retired: r.retired,
      settleUsageWake: r.settleUsageWake,
      messages: r.s.messages().map((message) => message.text.slice(0, 20)),
    }).toMatchInlineSnapshot(`
      {
        "messages": [
          "マネージャーのセッションが落ちた: Er",
        ],
        "retired": false,
        "settleUsageWake": 0,
        "settled": true,
        "stderrLines": [
          "runner からの合図の処理が例外で終わりました（type=closed managerId=mgr-closed-notice-pin）: Error: boom-sync
      ",
        ],
        "thrownCount": 1,
        "unhandled": [
          "boom-sync",
        ],
      }
    `);
    await r.s.pool.stop();
  });

  it('emit（在庫の flush・窓なし）が throw: 同じく #closeJob は途中で止まり（像は畳まれない・枠の起こし直しも走らない）、未処理の拒否になる', async () => {
    const r = await probe({
      open: { withheld: true, job: REPORT_SEEN },
      event: closed('done'),
      throwing: 'emit',
      when: flushNote,
    });
    expect({
      thrownCount: r.thrownCount,
      unhandled: r.unhandled,
      stderrLines: r.stderrLines,
      settled: r.settled,
      retired: r.retired,
      settleUsageWake: r.settleUsageWake,
      messages: r.s.messages().map((message) => message.text.slice(0, 20)),
    }).toMatchInlineSnapshot(`
      {
        "messages": [],
        "retired": false,
        "settleUsageWake": 0,
        "settled": true,
        "stderrLines": [
          "runner からの合図の処理が例外で終わりました（type=closed managerId=mgr-closed-notice-pin）: Error: boom-sync
      ",
        ],
        "thrownCount": 1,
        "unhandled": [
          "boom-sync",
        ],
      }
    `);
    await r.s.pool.stop();
  });

  it('queueSynthesizedNotice（silent done の closed_done_silent）が throw: async の noticeSilentDone の拒否が #closeJob の拒否になり、以降の段は走らない。未処理の拒否になる', async () => {
    const r = await probe({
      open: {},
      event: closed('done'),
      throwing: 'queue',
      when: (args) => args[1] === 'closed_done_silent',
    });
    expect({
      thrownCount: r.thrownCount,
      unhandled: r.unhandled,
      stderrLines: r.stderrLines,
      settled: r.settled,
      retired: r.retired,
      settleUsageWake: r.settleUsageWake,
      marked: (await r.s.job())?.silentDoneNotifiedFor,
      messages: r.s.messages().map((message) => message.text.slice(0, 20)),
    }).toMatchInlineSnapshot(`
      {
        "marked": "2026-11-01T01:00:00.000Z",
        "messages": [],
        "retired": false,
        "settleUsageWake": 0,
        "settled": true,
        "stderrLines": [
          "runner からの合図の処理が例外で終わりました（type=closed managerId=mgr-closed-notice-pin）: Error: boom-sync
      ",
        ],
        "thrownCount": 1,
        "unhandled": [
          "boom-sync",
        ],
      }
    `);
    await r.s.pool.stop();
  });

  it('queueSynthesizedNotice（flush の窓あり closed_withheld_flush）が throw: 同期の flushWithheldAtClose の throw が #closeJob の拒否になり、像の畳み・枠の起こし直しは走らない', async () => {
    const r = await probe({
      open: { withheld: true },
      event: closed('failed', 'マネージャーのセッションが落ちた: Error: boom'),
      throwing: 'queue',
      when: (args) => args[1] === 'closed_withheld_flush',
    });
    expect({
      thrownCount: r.thrownCount,
      unhandled: r.unhandled,
      stderrLines: r.stderrLines,
      settled: r.settled,
      retired: r.retired,
      settleUsageWake: r.settleUsageWake,
      messages: r.s.messages().map((message) => message.text.slice(0, 20)),
    }).toMatchInlineSnapshot(`
      {
        "messages": [
          "マネージャーのセッションが落ちた: Er",
        ],
        "retired": false,
        "settleUsageWake": 0,
        "settled": true,
        "stderrLines": [
          "runner からの合図の処理が例外で終わりました（type=closed managerId=mgr-closed-notice-pin）: Error: boom-sync
      ",
        ],
        "thrownCount": 1,
        "unhandled": [
          "boom-sync",
        ],
      }
    `);
    await r.s.pool.stop();
  });

  it('対照（throw しない）: 同じ場面で口が投げなければ、像は畳まれ、枠の起こし直しまで走り、未処理の拒否は出ない', async () => {
    const r = await probe({
      open: { withheld: true, job: REPORT_SEEN },
      event: closed('done'),
      throwing: 'emit',
      when: () => false,
    });
    expect({
      thrownCount: r.thrownCount,
      unhandled: r.unhandled,
      stderrLines: r.stderrLines,
      settled: r.settled,
      retired: r.retired,
      settleUsageWake: r.settleUsageWake,
    }).toMatchInlineSnapshot(`
      {
        "retired": true,
        "settleUsageWake": 1,
        "settled": true,
        "stderrLines": [],
        "thrownCount": 0,
        "unhandled": [],
      }
    `);
    await r.s.pool.stop();
  });

  describe('協力者を直に呼んだとき（同期の段は同期のまま throw し、async の段は拒否で返る）', () => {
    function makeNotice(overrides: {
      emit?: () => void;
      queue?: () => void;
      withheld?: boolean;
      hasWindow?: boolean;
    }): ManagerClosedNotice {
      return new ManagerClosedNotice({
        persist: () => Promise.resolve(),
        journalExchange: () => Promise.resolve(),
        emit:
          overrides.emit ??
          (() => {
            /* 何もしない */
          }),
        queueSynthesizedNotice:
          overrides.queue ??
          (() => {
            /* 何もしない */
          }),
        withheld: {
          get: () => (overrides.withheld === true ? ({} as never) : undefined),
          carryToWindow: () => undefined,
        },
        synthesized: {
          hasWindow: () => overrides.hasWindow === true,
          quotaOfFragment: () => undefined,
        },
      });
    }
    const record = (job: Partial<Job>): ManagerRecord => ({ job: { id: JOB_ID, ...job } }) as never;
    const boom = (): void => {
      throw new Error(BOOM);
    };

    it('noticePeerCloseAtEnd: emit が throw すると、Promise の拒否ではなく同期の throw として呼び元へ出る', () => {
      const notice = makeNotice({ emit: boom });
      let result: unknown;
      expect(() => {
        result = notice.noticePeerCloseAtEnd(
          record({ pendingPeerCloseNotice: PENDING_PEER_CLOSE }),
          closed('failed'),
        );
      }).toThrow(BOOM);
      expect(result).toBeUndefined();
    });

    it('flushWithheldAtClose: emit（窓なし）・queueSynthesizedNotice（窓あり）が throw すると、同期の throw として呼び元へ出る', () => {
      expect(() => {
        makeNotice({ emit: boom, withheld: true }).flushWithheldAtClose(closed('done'));
      }).toThrow(BOOM);
      expect(() => {
        makeNotice({ queue: boom, withheld: true, hasWindow: true }).flushWithheldAtClose(
          closed('failed'),
        );
      }).toThrow(BOOM);
    });

    it('noticeSilentDone: queueSynthesizedNotice が throw しても同期には throw せず、返した Promise が拒否される', async () => {
      const notice = makeNotice({ queue: boom });
      let returned: Promise<void> | undefined;
      expect(() => {
        returned = notice.noticeSilentDone(record({}), closed('done'));
      }).not.toThrow();
      expect(returned).toBeInstanceOf(Promise);
      await expect(returned).rejects.toThrow(BOOM);
    });
  });
});
