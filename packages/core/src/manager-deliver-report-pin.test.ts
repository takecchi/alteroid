import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from './auth.js';
import { createManagerPool } from './manager.js';
import {
  EVENT_SETTLED,
  EVENT_SETTLED_LAG,
  trackEventSettled,
} from './manager-event-settled.test-support.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';
import { createMemoryStores } from './testing.js';
import { WithheldReportsStore } from './withheld-reports-store.js';

// 出来事の処理の完了を `phases` へ記す: 処理の完了が何周で戻るかを数えるため（仕組みは test-support の注記）。
const phases: string[] = [];
let settledTracker: { restore(): void } | undefined;
beforeAll(() => {
  settledTracker = trackEventSettled(phases);
});
afterAll(() => {
  settledTracker?.restore();
});

/*
 * `Pool#handleEvent` の `case 'report'` の段4（`Pool#deliverReport`: 報告をクローンへ配るか畳むかを決めて配る）を、
 * 純関数へ切り出す前に外から縛る試験。
 *
 * **この試験の期待値は「仕様を先に書いたもの」ではない。** 今の出力を `toMatchInlineSnapshot` で取り（`-u`）、目で読んで確かめたもので、
 * 動きを変えずに切り出すための「いまの振る舞い」の写しである。食い違いを見つけたらここを直すのではなく、先に本体を疑うこと。
 *
 * 見るもの（段4が外へ出す全部）:
 *   - 日誌へ書いた `decision`（`decision`・`grounds`・`routine` の全欄）
 *   - `SynthesizedNoticeWindows#emit` へ渡った引数の全欄（`#emit` の先）・`#queue` へ渡った引数の全欄（`quota` の中身つき）
 *   - `WithheldReportsStore#withhold` へ渡った引数
 *   - それらと `now()` の呼び出しの順序、microtask の周回数
 * 協力者の3つは `prototype` の差し替えで引数を控えて何もしない（受信箱への配りと在庫は他の試験が縛る）。
 * 時計は注入（`now`）。実時間・実 I/O・固定の少ない tick での待ちは使わない（microtask の周回は `Promise.resolve()` を上限つきで流して数える）。
 */

const ID = 'mgr-deliver-pin';
const NOW_MS = Date.parse('2026-09-14T20:19:00.000Z');
const OLD_ISO = '2026-09-14T00:00:00.000Z';
const NOTICE = "You've hit your session limit · resets 9:30am (Asia/Tokyo)";
const QUOTA_FAILURE = { code: 'success/429', via: 'result_is_error', status: 429 };
const CRASH_FAILURE = { code: 'error_during_execution', via: 'result_subtype', status: 500 };
const AWAITING = { count: 2, breakdown: 'bash x2' };
const FOLD_DECISION = '背景処理の完了待ちで畳んだターンの報告なので';

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;
type EmitArgs = Parameters<SynthesizedNoticeWindows['emit']>;
type QueueArgs = Parameters<SynthesizedNoticeWindows['queue']>;
type WithholdArgs = Parameters<WithheldReportsStore['withhold']>;

const opened: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  phases.length = 0;
  for (const pool of opened.splice(0)) await pool.stop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

function report(fields: Partial<ReportEvent> = {}): ReportEvent {
  return {
    type: 'report',
    managerId: ID,
    text: '調べ終えた',
    status: 'done',
    ...fields,
  } as ReportEvent;
}

const FILE_ID = 'f'.repeat(32);
const FILE_BYTES = new TextEncoder().encode('成果物の中身');
const FILE = {
  fileId: FILE_ID,
  name: 'result.txt',
  mediaType: 'text/plain',
  size: FILE_BYTES.length,
  sha256: sha256Hex(FILE_BYTES),
};
const REJECTED = [{ name: 'link.txt', reason: 'symlink は送れない' }];

interface Spec {
  /** `tokenSavingExcerpt`（既定 true） */
  excerpt?: boolean;
  /** 畳む判断の `decision` の日誌だけ、開けるまで止める（畳む前の `await` の中に報告を居させる） */
  gate?: boolean;
  /** 台帳の `status` */
  job?: Partial<Job>;
}

async function open(spec: Spec = {}) {
  vi.restoreAllMocks();
  let emitEvent = null as ((event: RunnerEvent) => void) | null;
  const alive: RunnerManagerState[] = [
    {
      liveBackgroundTasks: 0,
      managerId: ID,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-1',
    },
  ];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emitEvent = onEvent;
      onEvent({
        type: 'hello',
        runnerId: 'runner-primary',
        capabilities: [RUNNER_CAPABILITY_MANAGER_OUTBOX],
      } as RunnerEvent);
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async openPickupFile(_kind, _managerId, fileId) {
      if (fileId !== FILE_ID) return undefined;
      return {
        size: FILE_BYTES.length,
        body: (async function* () {
          yield FILE_BYTES;
        })(),
      };
    },
    async deletePickupFile() {},
    async setProfile() {
      return { ok: true as const };
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: ID,
    createdAt: OLD_ISO,
    updatedAt: OLD_ISO,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...spec.job,
  });

  // 順序つきの記録。`recording` が立つのは、報告の「台帳＋日誌の exchange」が済んだ後（段4 の入り口）から
  const log: { kind: string; hop: number }[] = [];
  const decisions: unknown[] = [];
  const emits: EmitArgs[] = [];
  const queues: QueueArgs[] = [];
  const withholds: WithholdArgs[] = [];
  const state = { recording: false, hop: 0, nowCalls: 0 };
  const note = (kind: string): void => {
    if (state.recording) log.push({ kind, hop: state.hop });
  };
  let release!: () => void;
  const gateOpen = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const append = stores.journal.append.bind(stores.journal);
  stores.journal.append = async (entry) => {
    if (entry.type === 'exchange' && entry.role === 'inbound') {
      const written = await append(entry);
      state.recording = true;
      return written;
    }
    if (entry.type === 'decision' && state.recording) {
      note('journal:decision');
      decisions.push(structuredClone(entry));
      if (spec.gate === true && JSON.stringify(entry).includes(FOLD_DECISION)) {
        markReached();
        await gateOpen;
      }
    }
    return append(entry);
  };
  vi.spyOn(SynthesizedNoticeWindows.prototype, 'emit').mockImplementation((...args) => {
    note('emit');
    emits.push(args);
  });
  vi.spyOn(SynthesizedNoticeWindows.prototype, 'queue').mockImplementation((...args) => {
    note('queue');
    queues.push(args);
  });
  vi.spyOn(WithheldReportsStore.prototype, 'withhold').mockImplementation((...args) => {
    note('withhold');
    withholds.push(args);
  });
  const pool = createManagerPool({
    stores,
    now: () => {
      if (state.recording) state.nowCalls += 1;
      return NOW_MS;
    },
    post: () => {},
    runners: createRunnerRegistry([runner]),
    tokenSavingExcerpt: spec.excerpt ?? true,
  });
  opened.push(pool);
  await pool.restore();
  await settle();

  /** 台帳の更新・添付の id は毎回変わるので落とし、中身を見る欄だけ残す */
  const normalize = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'id' ? '<id>' : v))) as unknown;
  const observed = () => ({
    decisions: normalize(decisions),
    emits: normalize(emits),
    queues: normalize(queues),
    withholds: normalize(withholds),
  });
  const order = () => log.map((entry) => entry.kind);
  return {
    /** 日誌の exchange の後（段3 と段4）で `now()` が呼ばれた回数。段4 の `quotaMarkOf` の `this.#now()` は枠の失敗の回だけ 1 回増やす */
    nowCalls: () => state.nowCalls,
    pool,
    stores,
    reached,
    release,
    observed,
    order,
    log,
    /** 報告を 1 件流して流しきる */
    async report(event: ReportEvent) {
      emitEvent?.(event);
      await settle();
      return observed();
    },
    /** 出来事をそのまま流す（closed など） */
    push(event: RunnerEvent) {
      emitEvent?.(event);
    },
    /** 関門を開けた直後から、協力者が呼ばれる周回数と、処理の完了までの周回数（畳む decision の後ろの await の位置を見る歯） */
    async hopsAfterRelease() {
      phases.length = 0;
      state.hop = 0;
      release();
      let settled = -1;
      for (let i = 1; i <= 200; i += 1) {
        state.hop = i;
        await Promise.resolve();
        if (settled < 0 && phases.includes(EVENT_SETTLED)) settled = i - EVENT_SETTLED_LAG;
      }
      return {
        calls: log.filter((e) => e.hop > 0).map((e) => `${e.kind}@${String(e.hop)}`),
        settled,
      };
    },
    /** 報告を流した直後から、各協力者が呼ばれるまでの microtask の周回数と、処理の完了までの周回数 */
    async hops(event: ReportEvent) {
      phases.length = 0;
      emitEvent?.(event);
      let settled = -1;
      for (let i = 1; i <= 200; i += 1) {
        state.hop = i;
        await Promise.resolve();
        if (settled < 0 && phases.includes(EVENT_SETTLED)) settled = i - EVENT_SETTLED_LAG;
      }
      return {
        calls: log.map((entry) => `${entry.kind}@${String(entry.hop)}`),
        settled,
      };
    },
  };
}

describe('段4: 中身の無い報告の早い return（contentless かつ files 無し）', () => {
  it('contentless で files も rejectedFiles も無い: 何も配らず日誌の decision も書かない（now も呼ばない）', async () => {
    const s = await open();
    const r = await s.report(report({ contentless: true }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [],
        "withholds": [],
      }
    `);
    expect({ order: s.order(), nowCalls: s.nowCalls() }).toMatchInlineSnapshot(`
      {
        "nowCalls": 2,
        "order": [],
      }
    `);
  });

  it('contentless でも files / rejectedFiles が空の配列: 取りに行かず（carriesFiles は偽）、同じく何も配らない', async () => {
    const s = await open();
    const r = await s.report(report({ contentless: true, files: [], rejectedFiles: [] }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('contentless で rejectedFiles だけ: carriesFiles が真なので返らずに配る（reportFiles 付きの emit・foldedTurn 偽）', async () => {
    const s = await open();
    const r = await s.report(report({ contentless: true, rejectedFiles: REJECTED }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            {
              "attachments": [],
              "rejected": [
                {
                  "name": "link.txt",
                  "reason": "symlink は送れない",
                },
              ],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('contentless で files だけ（取れた）: 添付つきで配る', async () => {
    const s = await open();
    const r = await s.report(report({ contentless: true, files: [FILE] }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            {
              "attachments": [
                {
                  "id": "<id>",
                  "mediaType": "text/plain",
                  "name": "result.txt",
                  "sha256": "d448d1dcbecd286df80275880ea5b65cdde995cc6568ad5eacbab6249c137d44",
                  "size": 18,
                },
              ],
              "rejected": [],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('contentless で files と rejectedFiles の両方: 両方を運ぶ', async () => {
    const s = await open();
    const r = await s.report(report({ contentless: true, files: [FILE], rejectedFiles: REJECTED }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            {
              "attachments": [
                {
                  "id": "<id>",
                  "mediaType": "text/plain",
                  "name": "result.txt",
                  "sha256": "d448d1dcbecd286df80275880ea5b65cdde995cc6568ad5eacbab6249c137d44",
                  "size": 18,
                },
              ],
              "rejected": [
                {
                  "name": "link.txt",
                  "reason": "symlink は送れない",
                },
              ],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('contentless が真でない（欄が無い）なら中身の有無で畳まない: text が空でも配る', async () => {
    const s = await open();
    const r = await s.report(report({ text: '' }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });
});

describe('段4: 背景処理の完了待ち（awaitingBackground）の畳み', () => {
  it('awaitingBackground のみ（outwardActions・files 無し）: 畳む decision（routine）を書き、withhold へ text と awaitingBackground を渡す。emit も queue もしない', async () => {
    const s = await open();
    const r = await s.report(report({ awaitingBackground: AWAITING, text: '背景で走らせた' }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 背景で走らせた",
            "routine": true,
            "type": "decision",
          },
        ],
        "emits": [],
        "queues": [],
        "withholds": [
          [
            "mgr-deliver-pin",
            "背景で走らせた",
            {
              "breakdown": "bash x2",
              "count": 2,
            },
          ],
        ],
      }
    `);
    expect({ order: s.order(), nowCalls: s.nowCalls() }).toMatchInlineSnapshot(`
      {
        "nowCalls": 2,
        "order": [
          "journal:decision",
          "withhold",
        ],
      }
    `);
  });

  it('畳む decision の本文冒頭は excerptLine（長い本文は切り詰め・改行は畳む）、withhold へは text を丸ごと渡す', async () => {
    const s = await open();
    const long = `一行目\n二行目 ${'あ'.repeat(400)}`;
    const r = await s.report(report({ awaitingBackground: AWAITING, text: long }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 一行目 二行目 ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（168 文字省略。全 408 文字）",
            "routine": true,
            "type": "decision",
          },
        ],
        "emits": [],
        "queues": [],
        "withholds": [
          [
            "mgr-deliver-pin",
            "一行目
      二行目 ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ",
            {
              "breakdown": "bash x2",
              "count": 2,
            },
          ],
        ],
      }
    `);
  });

  it('fullText が在っても withhold へは text（最後の発言）を渡し、decision の冒頭も text から作る', async () => {
    const s = await open();
    const r = await s.report(
      report({ awaitingBackground: AWAITING, text: '結論', fullText: '途中の発言\n結論' }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 結論",
            "routine": true,
            "type": "decision",
          },
        ],
        "emits": [],
        "queues": [],
        "withholds": [
          [
            "mgr-deliver-pin",
            "結論",
            {
              "breakdown": "bash x2",
              "count": 2,
            },
          ],
        ],
      }
    `);
  });

  it('畳む前に status が stopped（#5504）: decision は残るが withhold も emit もしない', async () => {
    const s = await open({ gate: true });
    s.push(report({ awaitingBackground: AWAITING, text: '止めた後に畳み終わる報告' }));
    await s.reached;
    const stopped = await s.pool.abort(ID, '人間が止めた');
    expect(stopped.outcome).toBe('stopped');
    s.release();
    await settle();
    expect(s.observed()).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 止めた後に畳み終わる報告",
            "routine": true,
            "type": "decision",
          },
        ],
        "emits": [],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('畳む前に同じ担当の closed に追い越された: 畳まず emit（full・foldedTurn 偽）し、追加の decision（routine）を書く。withhold はしない', async () => {
    const s = await open({ gate: true });
    s.push(report({ awaitingBackground: AWAITING, text: '追い越される報告' }));
    await s.reached;
    s.push({ type: 'closed', managerId: ID, status: 'done', reason: '背景処理が終わった' });
    await settle();
    s.release();
    await settle();
    const r = s.observed();
    expect(r.withholds).toEqual([]);
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 追い越される報告",
            "routine": true,
            "type": "decision",
          },
          {
            "decision": "[mgr-deliver-pin] 同じ担当の closed に追い越されたので、畳まずに受信箱へ配った",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 本文冒頭: 追い越される報告",
            "routine": true,
            "type": "decision",
          },
        ],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "追い越される報告",
            null,
            null,
            "full",
            false,
          ],
        ],
        "queues": [
          [
            "mgr-deliver-pin",
            "closed_done_silent",
            "この委譲 mgr-deliver-pin は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。
      **成果が出ているとは限らない** — 成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。確かめるまで「終わった」とも「終わっていない」とも言わない。
      このセッションで report を受け取ったかは判定できなかった（この欄を書く前の古い行などで比較する時刻が無い）ため、念のため知らせている。
      closed の reason: 背景処理が終わった",
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('追い越された報告: 関門を開けてから、追加の decision と処理の完了までの周回数（decision の await の位置の歯）', async () => {
    const s = await open({ gate: true });
    s.push(report({ awaitingBackground: AWAITING, text: '追い越される報告' }));
    await s.reached;
    s.push({ type: 'closed', managerId: ID, status: 'done', reason: '背景処理が終わった' });
    await settle();
    expect(await s.hopsAfterRelease()).toMatchInlineSnapshot(`
      {
        "calls": [
          "emit@5",
          "journal:decision@5",
        ],
        "settled": 12,
      }
    `);
  });

  it('追い越された報告の追加 decision の本文冒頭は text から作る（fullText ではない）', async () => {
    const s = await open({ gate: true });
    s.push(
      report({ awaitingBackground: AWAITING, text: '結論だけ', fullText: '途中の発言\n結論だけ' }),
    );
    await s.reached;
    s.push({ type: 'closed', managerId: ID, status: 'done', reason: '背景処理が終わった' });
    await settle();
    s.release();
    await settle();
    expect(s.observed().decisions).toMatchInlineSnapshot(`
      [
        {
          "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
          "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 結論だけ",
          "routine": true,
          "type": "decision",
        },
        {
          "decision": "[mgr-deliver-pin] 同じ担当の closed に追い越されたので、畳まずに受信箱へ配った",
          "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 本文冒頭: 結論だけ",
          "routine": true,
          "type": "decision",
        },
      ]
    `);
  });

  it('追い越された報告の foldedTurn: unreported が在れば真（failure でも真）、無ければ偽。fullText と excerpt の組み合わせで配る text が変わる', async () => {
    const seen: Record<string, unknown> = {};
    const cases: Record<string, { excerpt: boolean; fields: Partial<ReportEvent> }> = {
      'excerpt 有効・fullText 無し・unreported': {
        excerpt: true,
        fields: { unreported: { reason: '畳む直前の書き出し' } },
      },
      'excerpt 有効・fullText 有り・failure': {
        excerpt: true,
        fields: { fullText: '途中\n結論', text: '結論', failure: CRASH_FAILURE },
      },
      'excerpt 無効・fullText 有り・どちらも無し': {
        excerpt: false,
        fields: { fullText: '途中\n結論', text: '結論' },
      },
    };
    for (const [label, c] of Object.entries(cases)) {
      const s = await open({ gate: true, excerpt: c.excerpt });
      s.push(report({ awaitingBackground: AWAITING, ...c.fields }));
      await s.reached;
      s.push({ type: 'closed', managerId: ID, status: 'done', reason: '背景処理が終わった' });
      await settle();
      s.release();
      await settle();
      seen[label] = s.observed().emits;
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "excerpt 有効・fullText 有り・failure": [
          [
            "mgr-deliver-pin",
            "report",
            "結論

      （途中の発言を含む全文 5 字は manager_report managerId=mgr-deliver-pin で読める。これはターンの最後の発言だけである）",
            null,
            null,
            "full",
            true,
          ],
        ],
        "excerpt 有効・fullText 無し・unreported": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            true,
          ],
        ],
        "excerpt 無効・fullText 有り・どちらも無し": [
          [
            "mgr-deliver-pin",
            "report",
            "途中
      結論",
            null,
            null,
            "full",
            false,
          ],
        ],
      }
    `);
  });
});

describe('段4: 外へ出した成果を含む報告（outwardActions）は畳まず受信箱へ回す', () => {
  it('awaitingBackground と outwardActions: 「外へ出した成果を含むので受信箱へ回す」decision を書き（routine 無し）、emit で配る', async () => {
    const s = await open();
    const r = await s.report(
      report({ awaitingBackground: AWAITING, outwardActions: ['gh pr merge', 'git push'] }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちのターンだが、外へ出した成果を含むので受信箱へ回す",
            "grounds": "managerId=mgr-deliver-pin outwardActions=gh pr merge, git push awaitingBackground.count=2",
            "type": "decision",
          },
        ],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
    expect({ order: s.order(), nowCalls: s.nowCalls() }).toMatchInlineSnapshot(`
      {
        "nowCalls": 2,
        "order": [
          "journal:decision",
          "emit",
        ],
      }
    `);
  });

  it('outwardActions だけ（awaitingBackground 無し）: decision は書かず、普通に配る', async () => {
    const s = await open();
    const r = await s.report(report({ outwardActions: ['gh pr merge'] }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('awaitingBackground と outwardActions と synthesized: decision の後、synthesized の枝（queue）へ進む', async () => {
    const s = await open();
    const r = await s.report(
      report({
        awaitingBackground: AWAITING,
        outwardActions: ['gh pr create'],
        synthesized: 'turn_failed',
        failure: CRASH_FAILURE,
      }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちのターンだが、外へ出した成果を含むので受信箱へ回す",
            "grounds": "managerId=mgr-deliver-pin outwardActions=gh pr create awaitingBackground.count=2",
            "type": "decision",
          },
        ],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "調べ終えた",
            null,
          ],
        ],
        "withholds": [],
      }
    `);
  });
});

describe('段4: 添付つきの背景待ち（成果物を握り潰さない）', () => {
  it('awaitingBackground と rejectedFiles: 畳まず decision も書かず、reportFiles つきで emit する', async () => {
    const s = await open();
    const r = await s.report(report({ awaitingBackground: AWAITING, rejectedFiles: REJECTED }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            {
              "attachments": [],
              "rejected": [
                {
                  "name": "link.txt",
                  "reason": "symlink は送れない",
                },
              ],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('awaitingBackground と files（取れた）: 畳まず、添付つきで emit する', async () => {
    const s = await open();
    const r = await s.report(report({ awaitingBackground: AWAITING, files: [FILE] }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            {
              "attachments": [
                {
                  "id": "<id>",
                  "mediaType": "text/plain",
                  "name": "result.txt",
                  "sha256": "d448d1dcbecd286df80275880ea5b65cdde995cc6568ad5eacbab6249c137d44",
                  "size": 18,
                },
              ],
              "rejected": [],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('awaitingBackground と files / rejectedFiles が空の配列: carriesFiles は偽なので畳む', async () => {
    const s = await open();
    const r = await s.report(
      report({ awaitingBackground: AWAITING, files: [], rejectedFiles: [] }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [
          {
            "decision": "[mgr-deliver-pin] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない",
            "grounds": "managerId=mgr-deliver-pin awaitingBackground.count=2 breakdown=bash x2 本文冒頭: 調べ終えた",
            "routine": true,
            "type": "decision",
          },
        ],
        "emits": [],
        "queues": [],
        "withholds": [
          [
            "mgr-deliver-pin",
            "調べ終えた",
            {
              "breakdown": "bash x2",
              "count": 2,
            },
          ],
        ],
      }
    `);
  });
});

describe('段4: 配る text（excerpt の有無・fullText）と foldedTurn', () => {
  it('excerpt 有効: fullText が無ければ text、有れば text に全文の在りかの1行を添える。emit の全欄（kind・requestId・markup・full・foldedTurn・reportFiles）', async () => {
    const s = await open({ excerpt: true });
    const plain = await s.report(report());
    expect(plain).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
    const withFull = await open({ excerpt: true });
    const r = await withFull.report(report({ text: '結論', fullText: '途中の発言\n結論' }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "結論

      （途中の発言を含む全文 8 字は manager_report managerId=mgr-deliver-pin で読める。これはターンの最後の発言だけである）",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('excerpt 無効: fullText が在れば全文を配る（無ければ text）', async () => {
    const s = await open({ excerpt: false });
    const withFull = await s.report(report({ text: '結論', fullText: '途中の発言\n結論' }));
    expect(withFull).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "途中の発言
      結論",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
    const plain = await open({ excerpt: false });
    const r = await plain.report(report());
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('foldedTurn: failure だけ・unreported だけ・両方・どちらも無し（status や本文では決まらない）', async () => {
    const seen: Record<string, unknown> = {};
    const cases: Record<string, Partial<ReportEvent>> = {
      failure: { failure: CRASH_FAILURE },
      unreported: { unreported: { reason: '畳む直前' } },
      両方: { failure: CRASH_FAILURE, unreported: { reason: '畳む直前' } },
      無し: {},
      '無し・status が failed': { status: 'failed' },
    };
    for (const [label, fields] of Object.entries(cases)) {
      const s = await open();
      seen[label] = (await s.report(report(fields))).emits;
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "failure": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            true,
            null,
          ],
        ],
        "unreported": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            true,
            null,
          ],
        ],
        "両方": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            true,
            null,
          ],
        ],
        "無し": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
        "無し・status が failed": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            null,
          ],
        ],
      }
    `);
  });

  it('synthesized が無い failure（旧 runner）: 常に emit 側へ倒す（queue しない）', async () => {
    const s = await open();
    const r = await s.report(report({ failure: QUOTA_FAILURE, text: 'API Error: 429' }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "API Error: 429",
            null,
            null,
            "full",
            true,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('unreported を伴う status failed / lost の報告も、そのまま配る', async () => {
    const s = await open();
    const r = await s.report(report({ status: 'failed', unreported: { reason: '畳む直前' } }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            true,
            null,
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });
});

const HEAD = '（このターンは応答を返さずに終わった: success/429 / result_is_error）';
const PARTIAL_MARKER = '（失敗する前に出ていた本文）';

describe('段4: synthesized の枝（queue へ積む）', () => {
  it('synthesized が有り carriesFiles が偽: queue へ managerId・族・text を渡し、emit しない（foldedTurn は渡らない）', async () => {
    const s = await open();
    const r = await s.report(
      report({
        synthesized: 'resume_failed',
        text: '再開できなかった',
        fullText: '途中\n再開できなかった',
      }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "resume_failed",
            "再開できなかった",
            null,
          ],
        ],
        "withholds": [],
      }
    `);
    expect({ order: s.order(), nowCalls: s.nowCalls() }).toMatchInlineSnapshot(`
      {
        "nowCalls": 2,
        "order": [
          "queue",
        ],
      }
    `);
  });

  it('synthesized が有り carriesFiles が真（files / rejectedFiles 有り）: queue せず emit する（foldedTurn は failure で決まる）', async () => {
    const s = await open();
    const rejected = await s.report(
      report({ synthesized: 'turn_failed', failure: CRASH_FAILURE, rejectedFiles: REJECTED }),
    );
    expect(rejected).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            true,
            {
              "attachments": [],
              "rejected": [
                {
                  "name": "link.txt",
                  "reason": "symlink は送れない",
                },
              ],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
    const withFile = await open();
    const r = await withFile.report(report({ synthesized: 'turn_failed', files: [FILE] }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [
          [
            "mgr-deliver-pin",
            "report",
            "調べ終えた",
            null,
            null,
            "full",
            false,
            {
              "attachments": [
                {
                  "id": "<id>",
                  "mediaType": "text/plain",
                  "name": "result.txt",
                  "sha256": "d448d1dcbecd286df80275880ea5b65cdde995cc6568ad5eacbab6249c137d44",
                  "size": 18,
                },
              ],
              "rejected": [],
            },
          ],
        ],
        "queues": [],
        "withholds": [],
      }
    `);
  });

  it('synthesized が有り files / rejectedFiles が空の配列: carriesFiles は偽なので queue する', async () => {
    const s = await open();
    const r = await s.report(
      report({ synthesized: 'turn_failed', failure: CRASH_FAILURE, files: [], rejectedFiles: [] }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "調べ終えた",
            null,
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('turn_failed と枠の失敗（429）: quota を組む。body と said（失敗する前に出ていた本文）の両方が在るとき、sdkText・said・resetText・resetsAt・sessionWindow が入る。now は注入した時刻', async () => {
    const s = await open();
    const text = `${HEAD}\n${NOTICE}\n\n${PARTIAL_MARKER}\n調べていた途中の発言`;
    const r = await s.report(
      report({ synthesized: 'turn_failed', failure: QUOTA_FAILURE, text, status: 'running' }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)

      （失敗する前に出ていた本文）
      調べていた途中の発言",
            {
              "resetText": "resets 9:30am (Asia/Tokyo)",
              "resetsAt": 1789432200000,
              "said": "調べていた途中の発言",
              "sdkText": "You've hit your session limit · resets 9:30am (Asia/Tokyo)",
              "sessionWindow": true,
            },
          ],
        ],
        "withholds": [],
      }
    `);
    expect({ order: s.order(), nowCalls: s.nowCalls() }).toMatchInlineSnapshot(`
      {
        "nowCalls": 3,
        "order": [
          "queue",
        ],
      }
    `);
  });

  it('turn_failed と枠の失敗で body だけ（said 無し）: quota に said の欄が出ない', async () => {
    const s = await open();
    const text = `${HEAD}\n${NOTICE}`;
    const r = await s.report(report({ synthesized: 'turn_failed', failure: QUOTA_FAILURE, text }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            {
              "resetText": "resets 9:30am (Asia/Tokyo)",
              "resetsAt": 1789432200000,
              "sdkText": "You've hit your session limit · resets 9:30am (Asia/Tokyo)",
              "sessionWindow": true,
            },
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('turn_failed と枠の失敗で said だけ（body 無し）: quotaMarkOf へ text を渡さず、quota に sdkText が出ず said だけ入る', async () => {
    const s = await open();
    const text = `${HEAD}\n\n${PARTIAL_MARKER}\n途中の発言だけ`;
    const r = await s.report(report({ synthesized: 'turn_failed', failure: QUOTA_FAILURE, text }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）

      （失敗する前に出ていた本文）
      途中の発言だけ",
            {
              "said": "途中の発言だけ",
            },
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('turn_failed と枠の失敗で body も said も無い（見出し1行だけ）: quota は空のオブジェクト（undefined ではない）', async () => {
    const s = await open();
    const r = await s.report(
      report({ synthesized: 'turn_failed', failure: QUOTA_FAILURE, text: HEAD }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）",
            {},
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('turn_failed と枠の失敗: quota は text だけから決まり、fullText に resets 風の文言（おとり）が在っても拾わない', async () => {
    const DECOY = "You've hit your session limit · resets 11:45pm (Asia/Tokyo)";
    const quotaOf = async (fields: { text: string; fullText: string }) => {
      const s = await open();
      const r = await s.report(
        report({ synthesized: 'turn_failed', failure: QUOTA_FAILURE, ...fields }),
      );
      return (r.queues as unknown[][])[0]?.[3];
    };
    const seen = {
      'text に resets（本物）・fullText に別の resets（おとり）': await quotaOf({
        text: `${HEAD}\n${NOTICE}`,
        fullText: `${HEAD}\n${DECOY}`,
      }),
      'text に resets が無く・fullText だけに resets（おとり）': await quotaOf({
        text: HEAD,
        fullText: `${HEAD}\n${DECOY}`,
      }),
    };
    expect(seen).toMatchInlineSnapshot(`
      {
        "text に resets が無く・fullText だけに resets（おとり）": {},
        "text に resets（本物）・fullText に別の resets（おとり）": {
          "resetText": "resets 9:30am (Asia/Tokyo)",
          "resetsAt": 1789432200000,
          "sdkText": "You've hit your session limit · resets 9:30am (Asia/Tokyo)",
          "sessionWindow": true,
        },
      }
    `);
    // 値そのもので縛る: おとりの時刻（11:45pm）が quota のどの欄にも入らない
    expect(JSON.stringify(seen)).not.toContain('11:45pm');
    expect(seen['text に resets が無く・fullText だけに resets（おとり）']).toEqual({});
  });

  it('turn_failed でも枠の失敗でない（クラッシュ）: quota は付かない（第4引数が undefined）', async () => {
    const s = await open();
    const text = `${HEAD}\n${NOTICE}`;
    const r = await s.report(report({ synthesized: 'turn_failed', failure: CRASH_FAILURE, text }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            null,
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('turn_failed で failure が無い: quota は付かない', async () => {
    const s = await open();
    const text = `${HEAD}\n${NOTICE}`;
    const r = await s.report(report({ synthesized: 'turn_failed', text }));
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            null,
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('枠の失敗でも synthesized が turn_failed 以外: quota は付かない', async () => {
    const s = await open();
    const text = `${HEAD}\n${NOTICE}`;
    const r = await s.report(
      report({ synthesized: 'resume_failed', failure: QUOTA_FAILURE, text }),
    );
    expect(r).toMatchInlineSnapshot(`
      {
        "decisions": [],
        "emits": [],
        "queues": [
          [
            "mgr-deliver-pin",
            "resume_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            null,
          ],
        ],
        "withholds": [],
      }
    `);
  });

  it('枠の失敗の種類: assistant_error の rate_limit / billing_error は枠、authentication_failed・status 401 や status の無い result_* は枠ではない', async () => {
    const seen: Record<string, unknown> = {};
    const cases: Record<string, { code: string; via: string; status?: number }> = {
      'assistant_error / rate_limit': { code: 'rate_limit', via: 'assistant_error' },
      'assistant_error / billing_error': { code: 'billing_error', via: 'assistant_error' },
      'assistant_error / authentication_failed': {
        code: 'authentication_failed',
        via: 'assistant_error',
      },
      'result_is_error / status 401': { code: 'success/401', via: 'result_is_error', status: 401 },
      'result_is_error / status 無し（旧 runner）': { code: 'success/429', via: 'result_is_error' },
    };
    for (const [label, failure] of Object.entries(cases)) {
      const s = await open();
      const text = `${HEAD}\n${NOTICE}`;
      seen[label] = (await s.report(report({ synthesized: 'turn_failed', failure, text }))).queues;
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "assistant_error / authentication_failed": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            null,
          ],
        ],
        "assistant_error / billing_error": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            {
              "resetText": "resets 9:30am (Asia/Tokyo)",
              "resetsAt": 1789432200000,
              "sdkText": "You've hit your session limit · resets 9:30am (Asia/Tokyo)",
              "sessionWindow": true,
            },
          ],
        ],
        "assistant_error / rate_limit": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            {
              "resetText": "resets 9:30am (Asia/Tokyo)",
              "resetsAt": 1789432200000,
              "sdkText": "You've hit your session limit · resets 9:30am (Asia/Tokyo)",
              "sessionWindow": true,
            },
          ],
        ],
        "result_is_error / status 401": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            null,
          ],
        ],
        "result_is_error / status 無し（旧 runner）": [
          [
            "mgr-deliver-pin",
            "turn_failed",
            "（このターンは応答を返さずに終わった: success/429 / result_is_error）
      You've hit your session limit · resets 9:30am (Asia/Tokyo)",
            null,
          ],
        ],
      }
    `);
  });
});

describe('段4: 添付を取る await の位置と microtask の周回数（歯）', () => {
  // `files` / `rejectedFiles` が無い報告は `await #fetchReportFiles` を挟まない。挟むと、以下の周回数が 1 以上増える。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('files 無しの報告: emit・queue・withhold・decision が呼ばれる周回数と、処理の完了までの周回数', async () => {
    const seen: Record<string, unknown> = {};
    const cases: Record<string, Partial<ReportEvent>> = {
      '通常（emit）': {},
      'synthesized（queue）': { synthesized: 'resume_failed' },
      '畳む（decision → withhold）': { awaitingBackground: AWAITING },
      '外へ出した成果（decision → emit）': {
        awaitingBackground: AWAITING,
        outwardActions: ['gh pr merge'],
      },
      'contentless（何もしない）': { contentless: true },
      'files が空の配列': { files: [], rejectedFiles: [] },
    };
    for (const [label, fields] of Object.entries(cases)) {
      const s = await open();
      seen[label] = await s.hops(report(fields));
      await s.pool.stop();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "contentless（何もしない）": {
          "calls": [],
          "settled": 13,
        },
        "files が空の配列": {
          "calls": [
            "emit@10",
          ],
          "settled": 13,
        },
        "synthesized（queue）": {
          "calls": [
            "queue@10",
          ],
          "settled": 13,
        },
        "外へ出した成果（decision → emit）": {
          "calls": [
            "journal:decision@10",
            "emit@14",
          ],
          "settled": 17,
        },
        "畳む（decision → withhold）": {
          "calls": [
            "journal:decision@10",
            "withhold@14",
          ],
          "settled": 17,
        },
        "通常（emit）": {
          "calls": [
            "emit@10",
          ],
          "settled": 13,
        },
      }
    `);
  });

  it('rejectedFiles だけ・files 有りの報告: fetch の await の分だけ遅れる（rejectedFiles だけは取りに行かないが async 関数の await は挟む）', async () => {
    const seen: Record<string, unknown> = {};
    const cases: Record<string, Partial<ReportEvent>> = {
      rejectedFiles: { rejectedFiles: REJECTED },
      'rejectedFiles（背景待ち）': { rejectedFiles: REJECTED, awaitingBackground: AWAITING },
      files: { files: [FILE] },
    };
    for (const [label, fields] of Object.entries(cases)) {
      const s = await open();
      seen[label] = await s.hops(report(fields));
      await s.pool.stop();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "files": {
          "calls": [
            "emit@35",
          ],
          "settled": 38,
        },
        "rejectedFiles": {
          "calls": [
            "emit@11",
          ],
          "settled": 14,
        },
        "rejectedFiles（背景待ち）": {
          "calls": [
            "emit@11",
          ],
          "settled": 14,
        },
      }
    `);
  });

  it('turn_failed の queue: 枠の失敗（quota を組む回）とクラッシュ（組まない回）の周回数（429 は段3 の枠の起こし直しの分も含むので、段4 だけの差ではない）', async () => {
    const text = `${HEAD}\n${NOTICE}`;
    const seen: Record<string, unknown> = {};
    const cases: Record<string, ReportEvent['failure']> = {
      'クラッシュ（quota 無し）': CRASH_FAILURE,
      '429（quota 有り）': QUOTA_FAILURE,
    };
    for (const [label, failure] of Object.entries(cases)) {
      const s = await open();
      seen[label] = await s.hops(report({ synthesized: 'turn_failed', failure, text }));
      await s.pool.stop();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "429（quota 有り）": {
          "calls": [
            "queue@13",
          ],
          "settled": 16,
        },
        "クラッシュ（quota 無し）": {
          "calls": [
            "queue@10",
          ],
          "settled": 13,
        },
      }
    `);
  });
});
