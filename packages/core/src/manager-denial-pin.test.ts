import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

const JOB_ID = 'mgr-denial-pin';

type DeniedEvent = Extract<RunnerEvent, { type: 'permission_denied' }>;

/**
 * 実時間では待たない: 出来事を 1 件ずつ流し、そのたびにマイクロタスクを流しきる（`#onEvent` の await の連鎖が終わるまで）。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

async function open(options: { status?: Job['status'] } = {}) {
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [
    {
      liveBackgroundTasks: 0,
      managerId: JOB_ID,
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
      emit = onEvent;
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    status: options.status ?? 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    now: () => clock,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([runner]),
  });
  await pool.restore();
  await settle();
  inbox.length = 0;
  const journalBefore = (await stores.journal.list({ types: ['exchange'] })).length;
  return {
    pool,
    stores,
    inbox,
    setClock(iso: string) {
      clock = Date.parse(iso);
    },
    /** 別件の確認（permission）を1件待たせる */
    async ask(requestId: string, askedAt: string): Promise<void> {
      emit?.({
        type: 'ask',
        managerId: JOB_ID,
        requestId,
        kind: 'permission',
        summary: '別件の確認',
        askedAt,
      });
      await settle();
    },
    async deny(event: Omit<DeniedEvent, 'type' | 'managerId'>): Promise<void> {
      emit?.({ type: 'permission_denied', managerId: JOB_ID, ...event });
      await settle();
    },
    /** 拒否の処理が書いた日誌（古い順）。restore が書いた分は除く */
    async lines(): Promise<string[]> {
      const entries = await stores.journal.list({ types: ['exchange'] });
      return entries
        .filter(
          (entry): entry is Extract<typeof entry, { type: 'exchange' }> =>
            entry.type === 'exchange',
        )
        .map((entry) => entry.text)
        .reverse()
        .slice(journalBefore);
    },
    /** 拒否の処理が書いた日誌の `with/role`（重複は畳む） */
    async roles(): Promise<string[]> {
      const entries = await stores.journal.list({ types: ['exchange'] });
      const all = entries
        .filter(
          (entry): entry is Extract<typeof entry, { type: 'exchange' }> =>
            entry.type === 'exchange',
        )
        .reverse()
        .slice(journalBefore)
        .map((entry) => `${entry.with}/${entry.role}`);
      return [...new Set(all)];
    },
    /** 受信箱へ上がった拒否の知らせ */
    notices(): InboxEvent[] {
      return inbox.filter((event) => event.type === 'manager_message');
    },
  };
}

/**
 * どの知らせにも同じ字面で載る 2 つの塊。全文は先頭の 1 件（`manager-live-input-head-all3`）で逐語の全文として固定し、
 * 他の件では見やすさのためにこの 2 つを名前に畳む（畳む前に、塊が本文にそのまま入っていることも確かめる）。
 */
const FIXED_MIDDLE =
  'この合図だけでは拒否の出所は特定できない。**まず、担い手自身に返っている拒否の理由文を読ませること**。' +
  '(a) 器のモデル分類器か deny 規則がその場で拒否したのであれば、この確認はクローンには回ってきていない。' +
  '(b) alteroid 自身の `PreToolUse` フック（例: `bash-wait-guard.ts`）が拒否したのであれば、' +
  '理由と代替案は担い手へ直接返っているので、担い手はそれだけで自力で抜けられることがある。';
const FIXED_ROUTE =
  '\n答え方: この拒否について「この1回だけ許可しますか」の確認（`requestId` は `toolu_…` の形）が別に届いていれば、' +
  'その `requestId` と `decision` を付けて `manager_send` で答える（allow しても自動では撃ち直されず、撃ち直しても分類器にまた止められうる。#4904）。' +
  'その確認が届いていなければ、この拒否には `requestId` が無く、許可として答える口は無い。' +
  'そのときは `manager_send` に `decision` を付けて送らないこと' +
  '（`requestId` 無しの `decision` は、このマネージャーが別に待っている確認へ回答として当たりうる）。' +
  '別の形でやり直させるなら、`decision` 無しの追加指示として送る。' +
  '作業者の拒否なら、その作業者へ伝えるようマネージャーに頼む（`manager_send` の届け先はマネージャーである）。' +
  '\n全件は日誌に残っている（`journal_read` で辿れる）。';

/** 受信箱の知らせの本文だけ（`id` は毎回変わる）。2 つの固定の塊は名前に畳む */
function textsOf(events: readonly InboxEvent[]): string[] {
  return events.map((event) => {
    const text = event.type === 'manager_message' ? event.text : '';
    expect(text).toContain(FIXED_MIDDLE);
    expect(text.endsWith(FIXED_ROUTE)).toBe(true);
    return `${text.slice(0, text.length - FIXED_ROUTE.length).replace(FIXED_MIDDLE, '<MIDDLE>')}<ROUTE>`;
  });
}

async function scenarioLayers() {
  const s = await open();
  const out: Record<string, unknown> = {};
  const step = async (name: string, event: Omit<DeniedEvent, 'type' | 'managerId'>) => {
    const linesBefore = (await s.lines()).length;
    const noticesBefore = s.notices().length;
    await s.deny(event);
    out[name] = {
      lines: (await s.lines()).slice(linesBefore),
      notices: textsOf(s.notices().slice(noticesBefore)),
    };
  };
  await step('manager-live-input-head-all3', {
    toolUseId: 'toolu_a',
    tool: 'Bash',
    input: { command: 'cd /tmp && echo hi' },
    via: 'live',
    actor: 'manager:mgr',
    reason: 'R',
    reasonType: 'classifier',
    message: 'M',
    inputHead: 'cd /tmp && echo HEAD',
  });
  await step('worker-live-input-nohead', {
    toolUseId: 'toolu_b',
    tool: 'Edit',
    input: { file_path: 'a.tsx' },
    via: 'live',
    actor: 'worker:mgr:agent-1',
  });
  await step('unknown-result-input', {
    toolUseId: 'toolu_c',
    tool: 'Write',
    input: { file_path: 'x.ts', content: 'secret' },
    via: 'result',
  });
  await step('unknown-live-noinput', {
    toolUseId: 'toolu_d',
    tool: 'Read',
    via: 'live',
  });
  await step('unknown-result-noinput', {
    toolUseId: 'toolu_e',
    tool: 'Grep',
    via: 'result',
    actor: 'other:1',
  });
  await step('worker-live-noinput-head', {
    toolUseId: 'toolu_f',
    tool: 'Glob',
    via: 'live',
    actor: 'worker:mgr:agent-2',
    inputHead: 'Glob HEAD',
  });
  await step('reasonType-only', {
    toolUseId: 'toolu_g',
    tool: 'T1',
    input: { a: 1 },
    via: 'live',
    actor: 'manager:mgr',
    reasonType: 'rule',
  });
  await step('reason-only', {
    toolUseId: 'toolu_h',
    tool: 'T2',
    input: { a: 1 },
    via: 'live',
    actor: 'manager:mgr',
    reason: 'because',
  });
  await step('message-only', {
    toolUseId: 'toolu_i',
    tool: 'T3',
    input: { a: 1 },
    via: 'live',
    actor: 'manager:mgr',
    message: 'denied by rule',
  });
  out['roles'] = await s.roles();
  out['events'] = s.notices().map((event) => ({ ...event, id: 'ID', text: 'TEXT' }));
  await s.pool.stop();
  return out;
}

async function scenarioTotals() {
  const s = await open();
  const mk = (id: string, actor: string | undefined, extra: Partial<DeniedEvent> = {}) =>
    s.deny({
      toolUseId: id,
      tool: 'Edit',
      input: { file_path: `${id}.tsx` },
      via: actor === undefined ? 'result' : 'live',
      ...(actor === undefined ? {} : { actor }),
      ...extra,
    });
  await mk('t1', 'manager:mgr');
  await mk('t2', 'worker:mgr:a');
  await mk('t3', 'worker:mgr:a');
  await mk('t4', 'worker:mgr:a');
  await mk('t5', 'worker:mgr:a');
  await mk('t6', undefined);
  await mk('t7', undefined);
  await mk('t8', undefined);
  await mk('t9', undefined);
  const out = {
    lines: await s.lines(),
    notices: textsOf(s.notices()),
    denials: s.pool.denials(JOB_ID),
  };
  await s.pool.stop();
  return out;
}

async function scenarioStopped() {
  const s = await open();
  await s.pool.abort(JOB_ID, '止める');
  await settle();
  s.inbox.length = 0;
  const before = (await s.lines()).length;
  await s.deny({
    toolUseId: 'tu-1',
    tool: 'Bash',
    input: { command: 'ls' },
    via: 'live',
    actor: 'worker:mgr:a',
  });
  const out = { lines: (await s.lines()).slice(before), notices: textsOf(s.notices()) };
  await s.pool.stop();
  return out;
}

async function scenarioThinning() {
  const s = await open();
  await s.deny({
    toolUseId: 'k0',
    tool: 'Tool0',
    input: { i: 0 },
    via: 'live',
    actor: 'worker:mgr:a',
    reason: 'old reason',
  });
  await s.deny({ toolUseId: 'k1', tool: 'Tool1', input: { i: 1 }, via: 'result' });
  for (let i = 2; i < 66; i += 1) {
    await s.deny({
      toolUseId: `k${i}`,
      tool: `Tool${i}`,
      input: { i },
      via: 'live',
      actor: 'manager:mgr',
    });
  }
  const forgets = (await s.lines()).filter((line) => line.includes('上限'));
  const afterForget = s.pool.denials(JOB_ID).map((d) => `${d.tool}/${d.actor ?? '-'}/${d.count}`);
  await s.deny({
    toolUseId: 'k0b',
    tool: 'Tool0',
    input: { i: 0 },
    via: 'live',
    actor: 'worker:mgr:a',
  });
  const reLines = (await s.lines()).slice(-1);
  const out = {
    roles: await s.roles(),
    forgets,
    size: afterForget.length,
    head: afterForget.slice(0, 3),
    reLines,
    tool0: s.pool.denials(JOB_ID).filter((d) => d.tool === 'Tool0' || d.tool === 'Tool1'),
  };
  await s.pool.stop();
  return out;
}

/**
 * 蓋で忘れた組の帳面（最後に止められた時刻・知らせ直しの段・直近の知らせ直しの鍵）が、数えと一緒に消えること。
 * 知らせ直し（`renotifyStalledDenials`）と `send` の宛先の選び方（`lastDenialRenotify`）が読む側。
 */
async function scenarioForget() {
  const s = await open();
  const renotices = () =>
    s
      .notices()
      .map((e) => (e.type === 'manager_message' ? e.text : ''))
      .filter((text) => text.includes('の拒否（'))
      .map((text) =>
        text.endsWith(FIXED_ROUTE) ? `${text.slice(0, -FIXED_ROUTE.length)}<ROUTE>` : text,
      );
  const tool0 = (texts: readonly string[]) => texts.filter((t) => t.includes('`Tool0` の拒否'));
  const T = '2026-11-01T00:00:00.000Z';
  await s.deny({
    toolUseId: 'f0',
    tool: 'Tool0',
    input: { i: 0 },
    via: 'live',
    actor: 'manager:mgr',
  });
  await s.ask('req-other', T);
  s.setClock('2026-11-01T00:11:00.000Z');
  await s.pool.renotifyStalledDenials();
  await settle();
  const first = tool0(renotices());
  // 蓋（64 種）を越えさせて Tool0 を忘れさせる
  for (let i = 1; i <= 64; i += 1) {
    await s.deny({
      toolUseId: `f${i}`,
      tool: `Tool${i}`,
      input: { i },
      via: 'live',
      actor: 'manager:mgr',
    });
  }
  const forgotten = !s.pool.denials(JOB_ID).some((d) => d.tool === 'Tool0');
  // 直近の知らせ直しの鍵が Tool0 のまま残っていれば、ここで「知らせ直しが届いている」と断られる
  const sent = await s.pool.send(JOB_ID, 'ok', { decision: 'allow' });
  // 最後に止められた時刻が残っていれば、Tool0 に 2 回目の知らせ直しが出る
  s.setClock('2026-11-01T00:42:00.000Z');
  await s.pool.renotifyStalledDenials();
  await settle();
  const afterForget = tool0(renotices());
  // 同じ ms の拒否が戻ってきたとき、知らせ直しの段の帳面が残っていれば 1 回目が出ない
  s.setClock(T);
  await s.deny({
    toolUseId: 'f0b',
    tool: 'Tool0',
    input: { i: 0 },
    via: 'live',
    actor: 'manager:mgr',
  });
  s.setClock('2026-11-01T00:11:00.000Z');
  await s.pool.renotifyStalledDenials();
  await settle();
  const afterReturn = tool0(renotices());
  await s.pool.stop();
  return { first, forgotten, sent, afterForget, afterReturn };
}

async function scenarioSnapshot() {
  const s = await open();
  const out: unknown[] = [];
  s.setClock('2026-11-01T01:00:00.000Z');
  await s.deny({
    toolUseId: 'r1',
    tool: 'Bash',
    input: { command: 'ls' },
    via: 'live',
    actor: 'manager:mgr',
    reason: 'R1',
    reasonType: 'classifier',
    message: 'M1',
    inputHead: 'ls HEAD',
  });
  out.push(s.pool.denials(JOB_ID));
  s.setClock('2026-11-01T02:00:00.000Z');
  await s.deny({
    toolUseId: 'r2',
    tool: 'Bash',
    input: { command: 'ls' },
    via: 'live',
    actor: 'manager:mgr',
    reason: 'R2',
  });
  out.push(s.pool.denials(JOB_ID));
  s.setClock('2026-11-01T03:00:00.000Z');
  await s.deny({
    toolUseId: 'r3',
    tool: 'Bash',
    input: { command: 'ls' },
    via: 'live',
    actor: 'manager:mgr',
  });
  out.push(s.pool.denials(JOB_ID));
  await s.pool.stop();
  return out;
}

const J = '[判断] [mgr-denial-pin] ';
const NOTICE_HEAD = (tool: string, who: string, total: number) =>
  `\`${tool}\` の実行が確認へ上がらずに止められた（${who} / このマネージャーで ${String(total)} 件目・道具ごとの合計）。`;
const UNKNOWN_STUCK =
  'マネージャーか作業者の手が止まっている可能性がある（どちらの層かはこの合図からは取れていない）（(a) の場合）。';
const LIVE_ABSENCE =
  '入力は付いていない（走行中の合図には入力の欄が無い。ターン終わりの記録が届けば、続く note に形だけ残る）';
const RESULT_ABSENCE = '入力は付いていない（result の記録に入力の欄が無かった）';
const HEAD_NOTE = (head: string) =>
  '\n拒否より前に見た入力の先頭（伏せ字・最大160字。この拒否の合図自体が運んだ値ではなく、同じ tool_use_id で runner の `PreToolUse` フックが拒否より前に見た値である）: ' +
  `\`${head}\``;

// 期待の文字列は仕様を先に書いたものではなく、切り出し前の作りの出力を写して目で読んで確かめたもの（コミットメッセージにも書く）。
describe('manager の permission_denied: 日誌・受信箱の全文（切り出し前の出力の固定）', () => {
  it('層（本体の手・作業者の手・層不明）× 入力の有無 × inputHead × 理由の3欄ごとの、日誌と受信箱の全文', async () => {
    const out = await scenarioLayers();
    expect(out['manager-live-input-head-all3']).toEqual({
      lines: [
        `${J}Bash の実行が確認へ上がらずに止められた（マネージャー自身 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=command / 先頭の語=cd / chars=32 [分類: classifier / 理由: R / モデルへの拒否文: M]`,
      ],
      notices: [
        `${NOTICE_HEAD('Bash', 'マネージャー自身', 1)}<MIDDLE>マネージャー自身の手が止まっている可能性がある（(a) の場合）。` +
          '直近の入力の形: `欄=command / 先頭の語=cd / chars=32` [分類: classifier / 理由: R / モデルへの拒否文: M]' +
          '（「先頭の語」は入力コマンドの先頭の単語であって、拒否の原因ではない）' +
          `${HEAD_NOTE('cd /tmp && echo HEAD')}<ROUTE>`,
      ],
    });
    expect(out['worker-live-input-nohead']).toEqual({
      lines: [
        `${J}Edit の実行が確認へ上がらずに止められた（作業者 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=file_path / chars=21`,
      ],
      notices: [
        `${NOTICE_HEAD('Edit', '作業者', 1)}<MIDDLE>作業者の手が止まっている可能性がある（(a) の場合）。` +
          '直近の入力の形: `欄=file_path / chars=21`<ROUTE>',
      ],
    });
    expect(out['unknown-result-input']).toEqual({
      lines: [
        `${J}Write の実行が確認へ上がらずに止められた（どちらの層か不明 / このマネージャーのこの組で 1 件目 / result の記録）: 欄=file_path,content / chars=39`,
      ],
      notices: [
        `${NOTICE_HEAD('Write', 'どちらの層か不明', 1)}<MIDDLE>${UNKNOWN_STUCK}` +
          '直近の入力の形: `欄=file_path,content / chars=39`<ROUTE>',
      ],
    });
    expect(out['unknown-live-noinput']).toEqual({
      lines: [
        `${J}Read の実行が確認へ上がらずに止められた（どちらの層か不明 / このマネージャーのこの組で 1 件目 / 走行中の合図）: ${LIVE_ABSENCE}`,
      ],
      notices: [
        `${NOTICE_HEAD('Read', 'どちらの層か不明', 1)}<MIDDLE>${UNKNOWN_STUCK}直近の入力の形: ${LIVE_ABSENCE}<ROUTE>`,
      ],
    });
    // `actor` が `manager:` でも `worker:` でもない文字列は、推測でどちらかへ寄せず「不明」
    expect(out['unknown-result-noinput']).toEqual({
      lines: [
        `${J}Grep の実行が確認へ上がらずに止められた（どちらの層か不明 / このマネージャーのこの組で 1 件目 / result の記録）: ${RESULT_ABSENCE}`,
      ],
      notices: [
        `${NOTICE_HEAD('Grep', 'どちらの層か不明', 1)}<MIDDLE>${UNKNOWN_STUCK}直近の入力の形: ${RESULT_ABSENCE}<ROUTE>`,
      ],
    });
    // 入力の形が無くても inputHead は載る（形が無いので codeSpan で包まない案内の後ろに足される）
    expect(out['worker-live-noinput-head']).toEqual({
      lines: [
        `${J}Glob の実行が確認へ上がらずに止められた（作業者 / このマネージャーのこの組で 1 件目 / 走行中の合図）: ${LIVE_ABSENCE}`,
      ],
      notices: [
        `${NOTICE_HEAD('Glob', '作業者', 1)}<MIDDLE>作業者の手が止まっている可能性がある（(a) の場合）。` +
          `直近の入力の形: ${LIVE_ABSENCE}${HEAD_NOTE('Glob HEAD')}<ROUTE>`,
      ],
    });
    expect(out['reasonType-only']).toEqual({
      lines: [
        `${J}T1 の実行が確認へ上がらずに止められた（マネージャー自身 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=a / chars=7 [分類: rule]`,
      ],
      notices: [
        `${NOTICE_HEAD('T1', 'マネージャー自身', 1)}<MIDDLE>マネージャー自身の手が止まっている可能性がある（(a) の場合）。` +
          '直近の入力の形: `欄=a / chars=7` [分類: rule]<ROUTE>',
      ],
    });
    expect(out['reason-only']).toEqual({
      lines: [
        `${J}T2 の実行が確認へ上がらずに止められた（マネージャー自身 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=a / chars=7 [理由: because]`,
      ],
      notices: [
        `${NOTICE_HEAD('T2', 'マネージャー自身', 1)}<MIDDLE>マネージャー自身の手が止まっている可能性がある（(a) の場合）。` +
          '直近の入力の形: `欄=a / chars=7` [理由: because]<ROUTE>',
      ],
    });
    expect(out['message-only']).toEqual({
      lines: [
        `${J}T3 の実行が確認へ上がらずに止められた（マネージャー自身 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=a / chars=7 [モデルへの拒否文: denied by rule]`,
      ],
      notices: [
        `${NOTICE_HEAD('T3', 'マネージャー自身', 1)}<MIDDLE>マネージャー自身の手が止まっている可能性がある（(a) の場合）。` +
          '直近の入力の形: `欄=a / chars=7` [モデルへの拒否文: denied by rule]<ROUTE>',
      ],
    });
    // `emit` に渡る出来事の全体（本文以外）: 受信箱の kind は report、時刻は注入した時計、状態は running
    // 日誌の向きと相手: decision 行は manager との inbound
    expect(out['roles']).toEqual(['manager/inbound']);
    const events = out['events'] as unknown[];
    expect(events).toHaveLength(9);
    for (const event of events) {
      expect(event).toEqual({
        type: 'manager_message',
        id: 'ID',
        at: '2026-11-01T00:00:00.000Z',
        managerId: JOB_ID,
        kind: 'report',
        text: 'TEXT',
        statusAtDelivery: 'running',
      });
    }
  });

  it('日誌の「N 件目」は道具×層の組の件数、受信箱の「N 件目」は道具ごとの合計で、1・3・9 件目でだけ上がる', async () => {
    const out = await scenarioTotals();
    const line = (who: string, n: number, via: string, shape = '欄=file_path / chars=22') =>
      `${J}Edit の実行が確認へ上がらずに止められた（${who} / このマネージャーのこの組で ${String(n)} 件目 / ${via}）: ${shape}`;
    expect(out.lines).toEqual([
      line('マネージャー自身', 1, '走行中の合図'),
      line('作業者', 1, '走行中の合図'),
      line('作業者', 2, '走行中の合図'),
      line('作業者', 3, '走行中の合図'),
      line('作業者', 4, '走行中の合図'),
      line('どちらの層か不明', 1, 'result の記録'),
      line('どちらの層か不明', 2, 'result の記録'),
      line('どちらの層か不明', 3, 'result の記録'),
      line('どちらの層か不明', 4, 'result の記録'),
    ]);
    expect(out.notices).toEqual([
      `${NOTICE_HEAD('Edit', 'マネージャー自身', 1)}<MIDDLE>マネージャー自身の手が止まっている可能性がある（(a) の場合）。直近の入力の形: \`欄=file_path / chars=22\`<ROUTE>`,
      `${NOTICE_HEAD('Edit', '作業者', 3)}<MIDDLE>作業者の手が止まっている可能性がある（(a) の場合）。直近の入力の形: \`欄=file_path / chars=22\`<ROUTE>`,
      `${NOTICE_HEAD('Edit', 'どちらの層か不明', 9)}<MIDDLE>${UNKNOWN_STUCK}直近の入力の形: \`欄=file_path / chars=22\`<ROUTE>`,
    ]);
    expect(out.denials).toEqual([
      { tool: 'Edit', count: 1, actor: 'manager', lastAt: '2026-11-01T00:00:00.000Z' },
      { tool: 'Edit', count: 4, actor: 'worker', lastAt: '2026-11-01T00:00:00.000Z' },
      { tool: 'Edit', count: 4, lastAt: '2026-11-01T00:00:00.000Z' },
    ]);
  });

  it('止めた委譲の拒否は、日誌には全文が残り、受信箱へは上がらない', async () => {
    const out = await scenarioStopped();
    expect(out).toEqual({
      lines: [
        `${J}Bash の実行が確認へ上がらずに止められた（作業者 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=command / 先頭の語=ls / chars=16`,
      ],
      notices: [],
    });
  });

  it('件数を覚える蓋（64 種）に当たると、忘れた組を日誌に残して 1 件目から数え直す', async () => {
    const out = await scenarioThinning();
    expect(out.forgets).toEqual([
      '[間引き] [mgr-denial-pin] 拒否の件数を覚えている道具×層の組が上限（64種）に達したので、古い 1 件を忘れた: Tool0（worker）。この組が次に止められたら 1 件目から数え直す（日誌には全件残っている）。',
      // 層が取れていない組は「（層）」を付けず道具名だけ
      '[間引き] [mgr-denial-pin] 拒否の件数を覚えている道具×層の組が上限（64種）に達したので、古い 1 件を忘れた: Tool1。この組が次に止められたら 1 件目から数え直す（日誌には全件残っている）。',
    ]);
    expect(out.roles).toEqual(['manager/inbound']);
    expect(out.size).toBe(64);
    expect(out.head).toEqual(['Tool2/manager/1', 'Tool3/manager/1', 'Tool4/manager/1']);
    expect(out.reLines).toEqual([
      `${J}Tool0 の実行が確認へ上がらずに止められた（作業者 / このマネージャーのこの組で 1 件目 / 走行中の合図）: 欄=i / chars=7`,
    ]);
    expect(out.tool0).toEqual([
      { tool: 'Tool0', count: 1, actor: 'worker', lastAt: '2026-11-01T00:00:00.000Z' },
    ]);
  });

  it('蓋で忘れた組は、最後に止められた時刻・知らせ直しの段・直近の知らせ直しの鍵も一緒に忘れる', async () => {
    const out = await scenarioForget();
    const renotice =
      '[mgr-denial-pin] `Tool0` の拒否（マネージャー自身）から11分、動きが無い（知らせ直し 1/2 回目。issue #1105 C）。<ROUTE>';
    expect(out.first).toEqual([renotice]);
    expect(out.forgotten).toBe(true);
    // 直近の知らせ直しの鍵が忘れた組を指したままなら、ここは「知らせ直しが届いている」という断りになる
    expect(out.sent).toEqual({
      outcome: 'unknown',
      detail:
        'req-other は runner 側で既に解けている。台帳の待ちからも外した（次の送信はこの確認への答えとしては扱われない）。',
    });
    // 忘れた組へは 2 回目の知らせ直しが出ない（最後に止められた時刻が残っていれば出る）
    expect(out.afterForget).toEqual([renotice]);
    // 同じ時刻の拒否が戻ってきたら 1 回目から数え直す（知らせ直しの段の帳面が残っていれば出ない）
    expect(out.afterReturn).toEqual([renotice, renotice]);
  });

  it('最後に止められた時刻・理由の3欄・inputHead は最新1件の像で、無い回は前回分を持ち越さない', async () => {
    const out = await scenarioSnapshot();
    expect(out).toEqual([
      [
        {
          tool: 'Bash',
          count: 1,
          actor: 'manager',
          lastAt: '2026-11-01T01:00:00.000Z',
          reasonType: 'classifier',
          reason: 'R1',
          message: 'M1',
          inputHead: 'ls HEAD',
        },
      ],
      [
        {
          tool: 'Bash',
          count: 2,
          actor: 'manager',
          lastAt: '2026-11-01T02:00:00.000Z',
          reason: 'R2',
        },
      ],
      [{ tool: 'Bash', count: 3, actor: 'manager', lastAt: '2026-11-01T03:00:00.000Z' }],
    ]);
  });
});
