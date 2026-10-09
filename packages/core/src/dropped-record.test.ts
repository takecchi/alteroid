import { describe, expect, it } from 'vitest';

import {
  approvalShape,
  clearRecentTracesForTesting,
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  inboxEventShape,
  journalEntryShape,
  journalRowType,
  noteBackgroundFailure,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  noteDroppedRecord,
  noteManagerIdCollision,
  noteUncaught,
  noteUnreadableRecord,
  RECENT_TRACE_LIMIT,
  reasonOf,
  recentDroppedTraces,
  runnerEventShape,
  type DroppedTraceOrigin,
} from './dropped-record.js';
import type { RunnerEvent } from './runner-protocol.js';
import {
  contextUsageObservationSchema,
  inboxEventSchema,
  JOURNAL_ENTRY_TYPES,
  journalEntrySchema,
  pendingApprovalSchema,
} from './schema.js';
import type {
  ContextUsageObservation,
  InboxEvent,
  InboxEventType,
  JournalEntryInput,
  JournalEntryType,
  PendingApproval,
} from './schema.js';
import { captureStderr } from './testing.js';

/** 孤立サロゲート（高だけ・低だけ）。`isWellFormed()` は tsconfig の lib に無いので直接探す。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// 跡に本文を足さない: 日誌にすら入らなかった秘密がホスティング先のログに出る。
describe('落とした記録の跡', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('本文を出さずに、いつ・どの型か・なぜ失敗したかを残す', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord(
        '日誌',
        journalEntryShape({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[mgr-1] 鍵は ${secret} だった`,
        }),
        new Error('storage is closed'),
      );
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).not.toContain(secret);
    expect(line).toContain('日誌を記録できませんでした');
    expect(line).toContain('exchange with=manager role=inbound');
    expect(line).toContain('storage is closed');
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
  });

  it('どの型の自由文も跡に乗らない', () => {
    const entries: JournalEntryInput[] = [
      { type: 'exchange', with: 'human', role: 'inbound', text: secret },
      { type: 'decision', decision: secret, grounds: secret },
      {
        type: 'escalation',
        question: secret,
        approvalId: 'ap-1',
        managerId: 'mgr-1',
        answer: secret,
      },
      { type: 'tool_use', actor: 'manager:mgr-1', tool: 'Bash', input: { command: secret } },
      { type: 'memory_update', slug: 'values', cause: 'clone', summary: secret },
      { type: 'daily_report', date: '2026-08-16', body: secret, unavailable: secret },
      { type: 'external_event', source: 'github', summary: secret },
      {
        type: 'token_rotation',
        event: 'not_rotated',
        label: secret,
        noticeText: secret,
        text: secret,
      },
    ];

    for (const entry of entries) {
      const shape = journalEntryShape(entry);
      expect(shape, entry.type).not.toContain(secret);
      expect(shape, entry.type).toContain(entry.type);
    }
  });

  // `source` は名前に見えて URL パスセグメントがそのまま入る外部値（列挙でも長さ上限でもない）。
  it('external_event の source は外から来る値なので、長さだけにする', () => {
    const shape = journalEntryShape({
      type: 'external_event',
      source: secret,
      summary: 'なんらかの通知',
    });

    expect(shape).not.toContain(secret);
    expect(shape).not.toContain(secret.slice(0, 8));
    expect(shape).toContain('external_event');
    expect(shape).toContain(`source.chars=${secret.length}`);
  });

  // 名簿の正規表現の歯は source と summary の取り違えを検出できないので、丸ごと toBe で固定する。
  it('external_event は source と summary の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = journalEntryShape({
      type: 'external_event',
      source: 'github',
      summary: secret,
    });

    expect(shape).toBe(`external_event source.chars=6 chars=${secret.length}`);
  });

  it('自由文が2つ以上ある型は、どれの長さかが分かる形で全部出す', () => {
    expect(journalEntryShape({ type: 'decision', decision: 'あ', grounds: 'いう' })).toBe(
      'decision decision.chars=1 grounds.chars=2',
    );
    expect(
      journalEntryShape({
        type: 'escalation',
        approvalId: 'ap-1',
        question: 'あ',
        answer: 'いう',
      }),
    ).toBe('escalation approvalId=ap-1 question.chars=1 answer.chars=2');
    expect(
      journalEntryShape({ type: 'escalation', approvalId: 'ap-1', question: 'あ' }),
    ).not.toContain('answer');
    expect(
      journalEntryShape({ type: 'memory_update', slug: 'values', cause: 'clone', summary: 'あ' }),
    ).toContain('chars=1');
  });

  it('exchange は with/role/text の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = journalEntryShape({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: secret,
    });

    expect(shape).toBe(`exchange with=manager role=inbound chars=${secret.length}`);
  });

  it('memory_update の summary は、slug に chars=<数字> を含む壊れた値が来ても、実際の長さで toBe が守る（Issue #823）', () => {
    const shape = journalEntryShape({
      type: 'memory_update',
      slug: 'values chars=999', // 検査を通らない値。journal.append 失敗後の跡では起こりうる
      cause: 'clone',
      summary: secret,
    });

    // 名簿と同じ緩い判定。slug の毒だけで満たせるので summary の size() が落ちても検出しない（対照）。
    expect(shape).toMatch(/(?:^| )chars=\d+/u);

    expect(shape).toBe(`memory_update slug=values chars=999 cause=clone chars=${secret.length}`);
  });

  it('daily_report は unavailable があれば長さだけ載せ、無ければ欄ごと出ない', () => {
    const unavailableValue = '上限に当たって日報を書けなかった';
    const withUnavailable = journalEntryShape({
      type: 'daily_report',
      date: '2026-08-20',
      body: '',
      unavailable: unavailableValue,
    });

    expect(withUnavailable).toBe(
      `daily_report date=2026-08-20 chars=0 unavailable.chars=${unavailableValue.length}`,
    );
    expect(withUnavailable).not.toContain(unavailableValue);

    const withoutUnavailable = journalEntryShape({
      type: 'daily_report',
      date: '2026-08-20',
      body: 'できた',
    });
    expect(withoutUnavailable).toBe('daily_report date=2026-08-20 chars=3');
    expect(withoutUnavailable).not.toContain('unavailable');
  });

  it('worker_wait は自由文が無いので数値をそのまま載せる', () => {
    // byCause の3値は互いに違う値にする: 同じ値だとキーと値の結び付きを入れ替えても出力が変わらない。
    const byCause = { input: 1, notification: 3, continuation: 37 };
    expect(new Set(Object.values(byCause)).size).toBe(3);

    const shape = journalEntryShape({
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause,
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: false,
    });

    expect(shape).toBe(
      'worker_wait openedAt=2026-08-20T00:00:00.000Z tasks=5 turns=41 ' +
        'byCause.input=1 byCause.notification=3 byCause.continuation=37 toolless=38 ' +
        'notifications=3 submits=0 settled=false',
    );
    expect(shape).not.toContain('sources');

    const withSources = journalEntryShape({
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause,
      toolless: 38,
      notifications: 3,
      submits: 0,
      sources: { system: 3, user: 1 },
      settled: false,
    });

    expect(withSources).toBe(
      'worker_wait openedAt=2026-08-20T00:00:00.000Z tasks=5 turns=41 ' +
        'byCause.input=1 byCause.notification=3 byCause.continuation=37 toolless=38 ' +
        'notifications=3 submits=0 sources=2 settled=false',
    );
    expect(withSources).not.toContain('system');
    expect(withSources).not.toContain('user');

    // 上のフィクスチャの値を将来揃えられても効くよう、1欄だけに印を置いて残りを 0 にする。
    const causes = ['input', 'notification', 'continuation'] as const;
    const oneHotByCause = (marked: (typeof causes)[number], marker: number) => ({
      input: marked === 'input' ? marker : 0,
      notification: marked === 'notification' ? marker : 0,
      continuation: marked === 'continuation' ? marker : 0,
    });

    for (const marked of causes) {
      const marker = 11 * (causes.indexOf(marked) + 1);
      const oneHot = journalEntryShape({
        type: 'worker_wait',
        openedAt: '2026-08-20T00:00:00.000Z',
        tasks: 5,
        turns: 41,
        byCause: oneHotByCause(marked, marker),
        toolless: 38,
        notifications: 3,
        submits: 0,
        settled: false,
      });

      expect(oneHot).toContain(`byCause.${marked}=${marker}`);
      for (const other of causes) {
        if (other === marked) continue;
        expect(oneHot).toContain(`byCause.${other}=0`);
      }
    }
  });

  it('turn_usage は models の中身を出さず、件数と reset の有無だけを載せる', () => {
    const shape = journalEntryShape({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUsd: 1.2345,
        },
      },
    });

    expect(shape).toBe('turn_usage layer=clone site=session managerId=clone models=1');
    expect(shape).not.toContain('1.2345');

    const withReset = journalEntryShape({
      type: 'turn_usage',
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      models: {},
      reset: { fromCostUsd: 5, toCostUsd: 3 },
    });
    expect(withReset).toBe(
      'turn_usage layer=manager site=session managerId=mgr-1 models=0 reset=yes',
    );
  });

  it('turn_usage は sessionId を id として載せ、取れない回は欄ごと出ない', () => {
    const withSessionId = journalEntryShape({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      sessionId: 'sess-abc123',
      models: {},
    });
    expect(withSessionId).toBe(
      'turn_usage layer=clone site=session managerId=clone sessionId=sess-abc123 models=0',
    );

    const withoutSessionId = journalEntryShape({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: {},
    });
    expect(withoutSessionId).toBe('turn_usage layer=clone site=session managerId=clone models=0');
    expect(withoutSessionId).not.toContain('sessionId');
  });

  it('subagent_stall は数値・列挙値・id をそのまま載せ、text だけ長さにする', () => {
    const shape = journalEntryShape({
      type: 'subagent_stall',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: secret,
    });

    expect(shape).not.toContain(secret);
    expect(shape).toBe(
      'subagent_stall agentId=agent-1 agentType=worker ownedTaskCount=1 sessionTaskCount=2 ' +
        `wakeupCount=1 outcome=woken chars=${secret.length}`,
    );

    const withoutAgentType = journalEntryShape({
      type: 'subagent_stall',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 2,
      outcome: 'limit_reached',
      text: 'あ',
    });
    expect(withoutAgentType).not.toContain('agentType');
  });

  it('token_rotation は tag 欄と size 欄が混在し、全欄が載ると跡もそれを反映する', () => {
    const labelValue = 'ラベルてすと';
    const noticeValue = '通知てすとぶんしょう';
    const shape = journalEntryShape({
      type: 'token_rotation',
      event: 'recovered',
      signal: 'reached',
      reason: 'turn_succeeded',
      freshness: 'current',
      tokenId: 'ap-1',
      fromTokenId: 'mgr-1',
      generation: 3,
      earliestAt: '2026-08-20T00:00:00.000Z',
      cooldownSource: 'quota_reset',
      recoveredSource: 'account_probe',
      label: labelValue,
      noticeText: noticeValue,
      text: secret,
    });

    // expect.soft にする: fail-fast だと先頭に近い欄が壊れたとき後続の欄が緑かを確かめられない。
    const parts = shape.split(' ');
    expect.soft(parts).toHaveLength(14);
    expect.soft(parts[0]).toBe('token_rotation');
    expect.soft(parts[1]).toBe('event=recovered');
    expect.soft(parts[2]).toBe('signal=reached');
    expect.soft(parts[3]).toBe('reason=turn_succeeded');
    expect.soft(parts[4]).toBe('freshness=current');
    expect.soft(parts[5]).toBe('tokenId=ap-1');
    expect.soft(parts[6]).toBe('fromTokenId=mgr-1');
    expect.soft(parts[7]).toBe('generation=3');
    expect.soft(parts[8]).toBe('earliestAt=2026-08-20T00:00:00.000Z');
    expect.soft(parts[9]).toBe('cooldownSource=quota_reset');
    expect.soft(parts[10]).toBe('recoveredSource=account_probe');
    expect.soft(parts[11]).toBe(`label.chars=${labelValue.length}`);
    expect.soft(parts[12]).toBe(`noticeText.chars=${noticeValue.length}`);
    expect.soft(parts[13]).toBe(`chars=${secret.length}`);
    expect(shape).not.toContain(labelValue);
    expect(shape).not.toContain(noticeValue);
    expect(shape).not.toContain(secret);
  });

  it('token_rotation は optional 欄が無ければ event と text だけを載せる', () => {
    const shape = journalEntryShape({
      type: 'token_rotation',
      event: 'not_rotated',
      text: 'あ',
    });

    expect(shape).toBe('token_rotation event=not_rotated chars=1');
    for (const field of [
      'signal',
      'reason',
      'freshness',
      'tokenId',
      'fromTokenId',
      'generation',
      'earliestAt',
      'cooldownSource',
      'recoveredSource',
      'label',
      'noticeText',
    ]) {
      expect(shape, field).not.toContain(field);
    }
  });

  it('理由は1行に切る（ドライバが本文を添えて返してくることがある）', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', '', new Error(`connection lost\nDETAIL: 送った本文 ${secret}`));
    });

    const line = lines[0] as string;
    expect(line).toContain('connection lost');
    expect(line).not.toContain(secret);
  });

  it('長い理由は切り詰める', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', '', new Error('x'.repeat(5000)));
    });

    expect((lines[0] as string).length).toBeLessThan(400);
  });

  it('跡のタグの切り口が絵文字をまたいでも、孤立サロゲートを残さない', async () => {
    for (let lead = 63; lead <= 65; lead += 1) {
      const lines = await captureStderr(() => {
        noteManagerIdCollision(`${'a'.repeat(lead)}😀😀`, 1);
      });
      const line = lines[0] as string;
      expect(line, `lead=${lead}`).toContain('…');
      expect(LONE_SURROGATE.test(line), `lead=${lead}`).toBe(false);
    }
  });
});

describe('捨てた合図の見分け', () => {
  const secret = 'ghp_000000000000000000000000000000000000';
  const at = new Date(0).toISOString();

  it('どの起点でも本文が跡に乗らない（7種類すべて）', () => {
    const events: InboxEvent[] = [
      { type: 'human_message', id: 'e1', at, text: secret, conversationId: secret },
      { type: 'human_answer', id: 'e2', at, approvalId: 'ap-1', answer: secret },
      { type: 'distill', id: 'e3', at, reason: 'shutdown' },
      { type: 'timer', id: 'e4', at, kind: 'daily_report', target: '2026-08-16' },
      { type: 'external', id: 'e5', at, source: secret, payload: { body: secret } },
      { type: 'self_initiative', id: 'e6', at, reason: secret },
      {
        type: 'manager_message',
        id: 'e7',
        at,
        managerId: 'mgr-1',
        kind: 'report',
        text: secret,
        requestId: 'req-1',
      },
    ];

    expect(events).toHaveLength(7);
    for (const event of events) {
      const shape = inboxEventShape(event);
      expect(shape, event.type).not.toContain(secret);
      expect(shape, event.type).toContain(event.type);
    }
  });

  it('external の source は外から来る値なので長さだけ、payload は有無だけ', () => {
    const shape = inboxEventShape({
      type: 'external',
      id: 'e1',
      at,
      source: secret,
      payload: { token: secret },
    });

    expect(shape).not.toContain(secret);
    expect(shape).not.toContain(secret.slice(0, 8));
    expect(shape).toContain(`source.chars=${secret.length}`);
    expect(shape).toContain('payload=yes');
    expect(inboxEventShape({ type: 'external', id: 'e2', at, source: 'github' })).toContain(
      'payload=none',
    );
  });

  it('誰から届いたかは残る（マネージャーの報告を突き合わせるため）', () => {
    expect(
      inboxEventShape({
        type: 'manager_message',
        id: 'e1',
        at,
        managerId: 'mgr-ff1a6c32',
        kind: 'report',
        text: 'あ',
      }),
    ).toBe('manager_message managerId=mgr-ff1a6c32 kind=report chars=1');
    expect(
      inboxEventShape({
        type: 'manager_message',
        id: 'e2',
        at,
        managerId: 'mgr-1',
        kind: 'question',
        text: 'あ',
        requestId: 'req-9',
      }),
    ).toContain('requestId=req-9');
  });

  // 共通ループは size() 呼び出しを消しても真のままなので、型ごとに丸ごと toBe で固定する。名簿は位置・値まで見ない。
  it('human_message は text の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'human_message',
      id: 'e1',
      at,
      text: secret,
      conversationId: 'conv-1',
    });

    expect(shape).toBe(`human_message chars=${secret.length}`);
  });

  it('human_answer は approvalId/answer の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'human_answer',
      id: 'e2',
      at,
      approvalId: 'ap-1',
      answer: secret,
    });

    expect(shape).toBe(`human_answer approvalId=ap-1 answer.chars=${secret.length}`);
  });

  it('distill は reason の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'distill',
      id: 'e3',
      at,
      reason: 'shutdown',
    });

    expect(shape).toBe('distill reason=shutdown');
  });

  it('timer は kind/cause/target の位置ごと toBe で固定する（Issue #823）', () => {
    const withAll = inboxEventShape({
      type: 'timer',
      id: 'e4',
      at,
      kind: 'daily_report',
      cause: 'schedule_catchup',
      target: '2026-08-16',
    });
    expect(withAll).toBe('timer kind=daily_report cause=schedule_catchup target=2026-08-16');

    const kindOnly = inboxEventShape({
      type: 'timer',
      id: 'e5',
      at,
      kind: 'memory_tidy',
    });
    expect(kindOnly).toBe('timer kind=memory_tidy');
  });

  it('self_initiative は reason の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'self_initiative',
      id: 'e6',
      at,
      reason: secret,
    });

    expect(shape).toBe(`self_initiative chars=${secret.length}`);
  });
});

// `poisonableTagField` は持たない: この7型は上の it が位置・値ごとに固定済みで、同じ機構を複製しない。
describe('inboxEventShape の名簿（schema に足した型・欄の足し忘れを赤くする。Issue #1391）', () => {
  type FieldPlan =
    | { readonly emit: 'tag'; readonly token: string }
    | { readonly emit: 'size'; readonly token: string }
    | { readonly emit: 'size-unnamed' }
    | { readonly emit: 'presence'; readonly token: string }
    | { readonly emit: 'never'; readonly why: string };

  type ShapedFieldsOf<T extends InboxEventType> = Exclude<
    keyof Extract<InboxEvent, { type: T }>,
    'type' | 'id' | 'at'
  >;

  const INBOX_SHAPE_PLAN = {
    human_message: {
      text: { emit: 'size-unnamed' },
      conversationId: {
        emit: 'never',
        why:
          '呼び出し側（アプリ層）が決める値で、この関数の外にある。' +
          '`journalEntryShape` の `exchange.conversationId` と同じ判断' +
          "（逐語は `command grep -Fn -- '同じ値の扱いを2か所で' packages/core/src/dropped-record.ts`）。" +
          '足すなら `journalEntryShape` の対応欄と2か所同時、`tag()` は禁止。',
      },
      supersedes: {
        emit: 'never',
        why:
          '「メッセージを編集する」機能（#edit-message）の欄。値を決めるのは' +
          '呼び出し側（アプリ層の検証を経た `POST /chat`）で、この関数の外に' +
          'ある。`journalEntryShape` の `exchange.supersedes` と同じ判断。' +
          '足すなら対応欄と2か所同時、`tag()` は禁止。',
      },
      clientMessageId: {
        emit: 'never',
        why:
          '送った側（クライアント）が決める値（#3203。`POST /chat` の入口が形を検める前の値でもある）で、' +
          'この関数の外にある。`journalEntryShape` の `exchange.clientMessageId` と同じ判断で、' +
          '足すなら2か所同時、`tag()` は禁止。',
      },
      attachments: {
        emit: 'never',
        why:
          '添付の参照（#3111）。ファイル名は人間が付けた自由文で、中身（bytes）は' +
          'そもそも受信箱にも日誌にも無い。件数だけでも跡に出す理由が無い。' +
          '対になる欄（`inboxEventShape` / `journalEntryShape`）と同時に判断すること、`tag()` は禁止。',
      },
    },
    human_answer: {
      approvalId: { emit: 'tag', token: 'approvalId' },
      answer: { emit: 'size', token: 'answer' },
      selections: {
        emit: 'never',
        why:
          '回答の構造（issue #2525）。設問 id・選択肢 id と、人間が書いた `other` の自由文を運ぶ。' +
          'この関数は参照しない——自由文は `answer`（畳んだ文）と同じく長さだけに逃がす対象で、' +
          '長さは `answer` が既に言っている。',
      },
      conversationId: {
        emit: 'never',
        why:
          '元の承認（`PendingApproval.conversationId`）の写し（#768）。この関数は' +
          '参照しない——`human_message.conversationId` と違い、対になる journal 欄も' +
          '無い（単に本体が触れていない欄）。',
      },
      answeredVia: {
        emit: 'never',
        why:
          '回答の経路（Issue #1479）。中身は id・enum 値のみで自由文を運ばないが、' +
          'この関数は参照しない（`conversationId` と同じ「単に本体が触れていない欄」）。',
      },
    },
    distill: {
      reason: { emit: 'tag', token: 'reason' },
    },
    timer: {
      kind: { emit: 'tag', token: 'kind' },
      target: { emit: 'tag', token: 'target' },
      cause: { emit: 'tag', token: 'cause' },
      heldForUsage: {
        emit: 'never',
        why:
          '枠保持で終わった回の印（#3317）。真偽値で自由文を運ばないが、この関数は参照しない' +
          '（再起動の配り直しの判定 `completedTimerRoundVerdict` が読む欄で、跡に載せる情報ではない）。',
      },
    },
    external: {
      source: { emit: 'size', token: 'source' },
      payload: { emit: 'presence', token: 'payload' },
      identity: {
        emit: 'never',
        why:
          '畳み込みの鍵（Issue #1298、`inbox-backlog.ts` の `inboxBacklogDedupeKey`）' +
          'に使う値で、この関数は参照しない。デーモン自身が `clone.post()` を直接' +
          '呼ぶ経路でしか立てられず外部からは立てられない欄だが、跡に載せるかは' +
          '別の判断——いまは載せていない。',
      },
      via: {
        emit: 'never',
        why:
          '連携の鍵経由で届いたときの鍵の id と名前（#3113）。名前は人間が付けたラベル（自由文）で、' +
          'この関数は参照しない（`identity` と同じ「単に本体が触れていない欄」）。鍵の値は持たない。',
      },
      attachments: {
        emit: 'never',
        why:
          '添付の参照（#3113 段3）。ファイル名は外から来る自由文で、中身（bytes）はそもそも受信箱にも日誌にも無い。' +
          '件数だけでも跡に出す理由が無い。`human_message.attachments`（上）と同じ判断で、対になる' +
          '`journalEntryShape` の `external_event.attachments` と同時に判断すること、`tag()` は禁止。',
      },
    },
    self_initiative: {
      reason: { emit: 'size-unnamed' },
      cause: {
        emit: 'never',
        why: 'この関数は参照しない。`timer.cause` と同じ軸・同じ3値だが、跡には出していない。',
      },
    },
    manager_message: {
      managerId: { emit: 'tag', token: 'managerId' },
      kind: { emit: 'tag', token: 'kind' },
      text: { emit: 'size-unnamed' },
      requestId: { emit: 'tag', token: 'requestId' },
      markup: {
        emit: 'never',
        why: '`text` の記法の注記（表示側の判断材料。issue #287）で、この関数は参照しない。',
      },
      statusAtDelivery: {
        emit: 'never',
        why: '配る瞬間の `JobStatus` の写し（issue #870）で、この関数は参照しない。',
      },
      synthesized: {
        emit: 'never',
        why: '機構が合成した失敗の知らせの印（クローンの枠の再武装の判定材料。2026-09-24）で、この関数は参照しない。',
      },
      foldedTurn: {
        emit: 'never',
        why:
          '失敗・未受信で畳まれたターンの印（`clone.ts` の `managerPrompt` が見出しを' +
          '切り替える判定材料。Issue #1848）で、この関数は参照しない。`synthesized` と同じ' +
          '「bool のタグで自由文を運ばない」欄。',
      },
      attachments: {
        emit: 'never',
        why:
          '担い手が報告に添えたファイルの参照（#4126 P2b）。ファイル名は担い手が付けた自由文で、中身（bytes）は' +
          'そもそも受信箱にも日誌にも無い。`human_message.attachments`（上）と同じ判断で、`tag()` は禁止。',
      },
      rejectedAttachments: {
        emit: 'never',
        why:
          '受け取れなかったファイルの名前と理由（#4126 P2b）。名前は担い手が付けた自由文、理由は runner が書いた' +
          '自由文を含みうるので、`attachments`（直上）と同じ判断で跡には出さない。`tag()` は禁止。',
      },
    },
  } satisfies { [T in InboxEventType]: Record<ShapedFieldsOf<T>, FieldPlan> };

  const SECRET = 'ghp_444444444444444444444444444444444444';
  const AT = new Date(0).toISOString();

  const INBOX_EVENT_TYPES = inboxEventSchema.options.map(
    (option) => option.shape.type.value,
  ) as InboxEventType[];

  const INBOX_FULL_FIXTURES: {
    [T in InboxEventType]: Required<Extract<InboxEvent, { type: T }>>;
  } = {
    human_message: {
      type: 'human_message',
      id: 'e1',
      at: AT,
      text: SECRET,
      conversationId: SECRET,
      supersedes: SECRET,
      clientMessageId: SECRET,
      attachments: [{ id: SECRET, name: SECRET, mediaType: 'image/png', size: 1, sha256: SECRET }],
    },
    human_answer: {
      type: 'human_answer',
      id: 'e2',
      at: AT,
      approvalId: 'ap-1',
      answer: SECRET,
      selections: [{ questionId: 'q1', optionIds: ['a'], other: SECRET }],
      conversationId: SECRET,
      answeredVia: { kind: 'account', accountId: SECRET },
    },
    distill: {
      type: 'distill',
      id: 'e3',
      at: AT,
      reason: 'scheduled',
    },
    timer: {
      type: 'timer',
      id: 'e4',
      at: AT,
      kind: 'daily_report',
      target: '2026-08-16',
      cause: 'schedule_catchup',
      heldForUsage: true,
    },
    external: {
      type: 'external',
      id: 'e5',
      at: AT,
      source: SECRET,
      payload: { token: SECRET },
      identity: SECRET,
      via: { keyId: SECRET, name: SECRET },
      attachments: [{ id: SECRET, name: SECRET, mediaType: 'image/png', size: 1, sha256: SECRET }],
    },
    self_initiative: {
      type: 'self_initiative',
      id: 'e6',
      at: AT,
      reason: SECRET,
      cause: 'manual',
    },
    manager_message: {
      type: 'manager_message',
      id: 'e7',
      at: AT,
      managerId: 'mgr-1',
      kind: 'question',
      text: SECRET,
      requestId: 'req-1',
      markup: 'none',
      statusAtDelivery: 'running',
      synthesized: true,
      foldedTurn: true,
      attachments: [{ id: SECRET, name: SECRET, mediaType: 'image/png', size: 1, sha256: SECRET }],
      rejectedAttachments: [{ name: SECRET, reason: SECRET }],
    },
  };

  it('名簿のキー集合は inboxEventSchema の実装側の型・欄と両方向に一致する（zod から機械的に引く）', () => {
    expect(new Set(INBOX_EVENT_TYPES)).toEqual(new Set(Object.keys(INBOX_SHAPE_PLAN)));
    expect(INBOX_EVENT_TYPES.length).toBeGreaterThan(0);

    for (const option of inboxEventSchema.options) {
      const type = option.shape.type.value as InboxEventType;
      const implementedFields = new Set(Object.keys(option.shape));
      implementedFields.delete('type');
      implementedFields.delete('id');
      implementedFields.delete('at');

      const plannedFields = new Set(Object.keys(INBOX_SHAPE_PLAN[type]));

      expect(plannedFields, type).toEqual(implementedFields);
    }
  });

  it('名簿の各欄について inboxEventShape が plan どおりに振る舞う（never は出ない・size 系は長さだけ・tag は目印・presence は有無だけ）', () => {
    for (const type of INBOX_EVENT_TYPES) {
      const shape = inboxEventShape(INBOX_FULL_FIXTURES[type]);
      const plan: Record<string, FieldPlan> = INBOX_SHAPE_PLAN[type];

      for (const [field, fieldPlan] of Object.entries(plan)) {
        switch (fieldPlan.emit) {
          case 'never':
            expect(shape, `${type}.${field}`).not.toContain(field);
            break;
          case 'size':
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.token}.chars=${SECRET.length}`,
            );
            break;
          case 'size-unnamed':
            expect(shape, `${type}.${field}`).toMatch(
              new RegExp(`(?:^| )chars=${SECRET.length}(?:$| )`, 'u'),
            );
            break;
          case 'tag':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=`);
            break;
          case 'presence':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=`);
            break;
        }
      }
    }
  });

  it('値が出ない欄（size/size-unnamed/never）に置いた自由文は、どの型の跡にも現れない', () => {
    for (const type of INBOX_EVENT_TYPES) {
      const shape = inboxEventShape(INBOX_FULL_FIXTURES[type]);
      expect(shape, type).not.toContain(SECRET);
    }
  });
});

describe('approvalShape の名簿（schema に足した欄の足し忘れを赤くする。Issue #1397 c16-2）', () => {
  type FieldPlan =
    | { readonly emit: 'tag'; readonly token: string }
    | { readonly emit: 'size'; readonly token: string }
    | { readonly emit: 'never'; readonly why: string };

  const APPROVAL_SHAPE_PLAN = {
    id: { emit: 'tag', token: 'approvalId' },
    createdAt: {
      emit: 'never',
      why: 'この関数は参照しない。作成時刻は跡の目的（本文を含まない見分け）に要らない。',
    },
    question: { emit: 'size', token: 'question' },
    context: { emit: 'size', token: 'context' },
    jobId: { emit: 'tag', token: 'managerId' },
    requestId: { emit: 'tag', token: 'requestId' },
    answeredAt: {
      emit: 'never',
      why:
        'この関数は `ask_human` が承認待ちを積む段（前段）の見分けを作る——' +
        '回答が付くのはそれより後なので、この時点では意味を持たない欄。',
    },
    answer: {
      emit: 'never',
      why: '`answeredAt` と同じ理由（回答は後段の欄）。回答の本文は `journalEntryShape` の `escalation.answer` 側が扱う。',
    },
    questions: {
      emit: 'never',
      why: '設問と選択肢（issue #2525）。人間向けの自由文（prompt / label / description）を運ぶので出さない。',
    },
    selections: {
      emit: 'never',
      why: '`answer` と同じ理由（回答は後段の欄。`other` は人間の自由文）。',
    },
    conversationId: {
      emit: 'never',
      why: 'この関数は参照しない。`inboxEventShape`/`journalEntryShape` の対応欄と違い、対になる journal 欄も無い（単に本体が触れていない欄）。',
    },
    withdrawnAt: {
      emit: 'never',
      why: 'この関数は参照しない。取り下げは前段（`putApproval`）より後に起きる操作（issue #963）。',
    },
    withdrawnReason: {
      emit: 'never',
      why: '`withdrawnAt` と同じ理由（取り下げは後段の欄）。',
    },
    permissionRequest: {
      emit: 'never',
      why:
        'この関数は参照しない（Issue #863）。`rule` / `allows` / `denies` は ' +
        '`request_permission` の入力そのものであって秘密ではないが、この関数の ' +
        '契約は「本文は出さない」——`size()` へ逃がす対象を増やす拡張は、実際に ' +
        '掘れなかった実例が出てから広げる（`context_usage` の doc と同じ判断）。',
    },
    answeredVia: {
      emit: 'never',
      why:
        '回答の経路（Issue #1479）。中身は id・enum 値のみで自由文を運ばないが、' +
        'この関数は参照しない——`answeredAt`/`answer` と同じ理由（回答は前段の' +
        '見分けより後の欄）。',
    },
    answerDelivery: {
      emit: 'never',
      why:
        "回答の配達済み印（issue #1977）。値は `'pending' | 'delivered'` の" +
        '2値のみで自由文を運ばないが、この関数は参照しない——`answeredAt`/`answer`' +
        'と同じ理由（回答が付いた後段の欄）。',
    },
  } satisfies Record<keyof PendingApproval, FieldPlan>;

  const SECRET = 'ghp_555555555555555555555555555555555555';

  const APPROVAL_FULL_FIXTURE: Required<PendingApproval> = {
    id: 'ap-1',
    createdAt: SECRET,
    question: SECRET,
    context: SECRET,
    jobId: 'mgr-1',
    requestId: 'req-1',
    answeredAt: SECRET,
    answer: SECRET,
    questions: [{ id: 'q1', prompt: SECRET, options: [{ id: 'a', label: SECRET }] }],
    selections: [{ questionId: 'q1', optionIds: ['a'], other: SECRET }],
    conversationId: SECRET,
    withdrawnAt: SECRET,
    withdrawnReason: SECRET,
    permissionRequest: { rule: SECRET, allows: [SECRET], denies: [SECRET] },
    answeredVia: { kind: 'account', accountId: SECRET },
    answerDelivery: 'delivered',
  };

  it('名簿のキー集合は pendingApprovalSchema の実装側の欄と両方向に一致する（zod から機械的に引く）', () => {
    const implementedFields = new Set(Object.keys(pendingApprovalSchema.shape));
    const plannedFields = new Set(Object.keys(APPROVAL_SHAPE_PLAN));

    expect(plannedFields).toEqual(implementedFields);
    expect(implementedFields.size).toBeGreaterThan(0);
  });

  it('名簿の各欄について approvalShape が plan どおりに振る舞う（never は出ない・size は長さだけ・tag は値そのものが目印として出る）', () => {
    const shape = approvalShape(APPROVAL_FULL_FIXTURE);
    const plan: Record<string, FieldPlan> = APPROVAL_SHAPE_PLAN;

    for (const [field, fieldPlan] of Object.entries(plan)) {
      switch (fieldPlan.emit) {
        case 'never':
          expect(shape, field).not.toContain(field);
          break;
        case 'size':
          expect(shape, field).toContain(`${fieldPlan.token}.chars=${SECRET.length}`);
          break;
        case 'tag': {
          // token= だけでは tag() を size() に取り替えた変異（managerId=chars=5）を拾えないので値まで固定する。
          const rawValue = String(APPROVAL_FULL_FIXTURE[field as keyof PendingApproval]);
          expect(shape, field).toContain(`${fieldPlan.token}=${rawValue}`);
          break;
        }
      }
    }
  });

  it('値が出ない欄（size/never）に置いた自由文は跡に現れない', () => {
    const shape = approvalShape(APPROVAL_FULL_FIXTURE);
    expect(shape).not.toContain(SECRET);
  });
});

// `runnerEventShape` に名簿は置かない: 許可制（載せてよい欄だけを選ぶ）なので、名簿は新しい欄を判断なしに載せる側へ倒す。
describe('背景で落ちた処理の跡（#438）', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('どこで落ちたかを名指しし、理由は reasonOf を通す', async () => {
    const lines = await captureStderr(() => {
      noteBackgroundFailure('クローンの受信箱のループ', '', new Error('boom'));
      noteBackgroundFailure(
        'runner からの合図の処理',
        'type=report managerId=mgr-1',
        new Error(`Failed query: select 1\nparams: ${secret}`),
      );
    });

    expect(lines).toHaveLength(2);
    const [plain, detailed] = lines as [string, string];
    expect(plain).toContain('クローンの受信箱のループが例外で終わりました: Error: boom');
    expect(detailed).toContain(
      'runner からの合図の処理が例外で終わりました（type=report managerId=mgr-1）',
    );
    expect(detailed).not.toContain(secret);
  });

  it('runner の合図の見分けは、型とこちらが発行した id だけを載せる', () => {
    const report: RunnerEvent = {
      type: 'report',
      managerId: 'mgr-1',
      text: `鍵は ${secret} だった`,
      status: 'done',
    };
    const shape = runnerEventShape(report);

    expect(shape).toBe('type=report managerId=mgr-1');
    // 本文は長さすら出さない: 跡に要るのは出所であって量ではない。
    expect(shape).not.toContain(secret);
    expect(shape).not.toContain('chars');

    expect(runnerEventShape({ type: 'hello', runnerId: 'runner-primary' })).toBe('type=hello');
  });
});

describe('日誌の読み出しで飛ばした行の跡（Issue #224）', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('journalRowType は type だけを取り、本文には触れない', () => {
    expect(journalRowType({ type: 'future-type', summary: secret })).toBe('future-type');
    // 埋め草を置かない: `'（不明）'` のような固定値にすると、それ自体が種別として数えられる。
    expect(journalRowType('not-an-object')).toBeUndefined();
    expect(journalRowType(null)).toBeUndefined();
    expect(journalRowType({ summary: secret })).toBeUndefined();
    expect(journalRowType({ type: 123 })).toBeUndefined();
  });

  it('初出はその場で1行、同じ種別の2回目以降は増やすだけで出さない', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 42);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 99);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 7);
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).toContain('初出');
    expect(line).toContain('type=future-type');
    expect(line).toContain('bytes=42');
    expect(dropped.get('unknown-shape:future-type')).toBe(3);
  });

  it('reason だけが違う・type だけが違う・type が無い、はそれぞれ別の種別として初出が出る', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', 'a', 1);
      noteDroppedJournalRow(dropped, 'unparsable', 'a', 1);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'b', 1);
      noteDroppedJournalRow(dropped, 'unparsable', undefined, 1);
    });

    expect(lines).toHaveLength(4);
    expect(dropped.size).toBe(4);
  });

  it('本文は乗らない（type と bytes だけ）', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', journalRowType({ type: 'ok' }), 12);
    });

    const line = lines[0] as string;
    expect(line).not.toContain(secret);
  });

  it('summary は何も飛ばしていなければ何も出さない', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRowsSummary(dropped);
    });

    expect(lines).toHaveLength(0);
  });

  it('summary は呼び出しの終わりに、種別ごとの件数をまとめて1行で出す', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 1);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 1);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 1);
      noteDroppedJournalRow(dropped, 'unparsable', undefined, 1);
      noteDroppedJournalRowsSummary(dropped);
    });

    expect(lines).toHaveLength(3);
    const summary = lines[2] as string;
    expect(summary).toContain('合計');
    expect(summary).toContain('unknown-shape:future-type×3');
    expect(summary).toContain('unparsable×1');
  });
});

describe('直近の跡を器の中から読み戻す帳面（#242）', () => {
  it('note() 経由（noteDroppedRecord 等）の行は帳面にも積まれる', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      noteDroppedRecord(
        '日誌',
        'exchange with=human role=inbound chars=3',
        new Error('storage is closed'),
      );
    });

    const traces = recentDroppedTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toContain('日誌を記録できませんでした');
    expect(traces[0]).toContain('storage is closed');
    // 改行を持たない: `renderListingFromEnd` が `\n` で連ねるので、紛れ込むと1件が2行に化ける。
    expect(traces[0]).toMatch(/^alteroid: \d{4}-\d{2}-\d{2}T[\d:.]+Z /u);
    expect(traces[0]?.includes('\n')).toBe(false);
  });

  it('noteUncaught（alteroidd / alteroid-runner）の行は帳面に積まれない', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      noteUncaught('alteroidd', 'uncaughtException', new Error('boom'));
      noteUncaught('alteroid-runner', 'unhandledRejection', new Error('boom2'));
    });

    expect(recentDroppedTraces()).toHaveLength(0);
  });

  it('上限（RECENT_TRACE_LIMIT）を超えたら古い側から押し出される', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      for (let index = 0; index < RECENT_TRACE_LIMIT + 10; index += 1) {
        noteManagerIdCollision(`mgr-${index}`, 1);
      }
    });

    const traces = recentDroppedTraces();
    expect(traces).toHaveLength(RECENT_TRACE_LIMIT);
    expect(traces.some((line) => line.includes('managerId=mgr-0 '))).toBe(false);
    expect(traces.some((line) => line.includes('managerId=mgr-9 '))).toBe(false);
    expect(traces.some((line) => line.includes(`managerId=mgr-${RECENT_TRACE_LIMIT + 9} `))).toBe(
      true,
    );
  });

  it('recentDroppedTraces() は控えを返す（呼び手が触っても帳面は動かない）', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      noteUnreadableRecord('runner のセッション一覧', 'runnerId=r-1', new Error('boom'));
    });

    const borrowed = recentDroppedTraces() as string[];
    borrowed.push('偽の行を差し込む');

    expect(recentDroppedTraces()).toHaveLength(1);
  });

  it('clearRecentTracesForTesting() で帳面を空にできる', async () => {
    clearRecentTracesForTesting();
    await captureStderr(() => {
      noteBackgroundFailure('probe', '', new Error('boom'));
    });
    expect(recentDroppedTraces().length).toBeGreaterThan(0);

    clearRecentTracesForTesting();

    expect(recentDroppedTraces()).toHaveLength(0);
  });
});

describe('帳面の字面（origin・0件の読み方・保持）', () => {
  it('describeDroppedTraceOrigin(undefined) は空文字（「不明」と書かない）', () => {
    expect(describeDroppedTraceOrigin(undefined)).toBe('');
  });

  it('DroppedTraceOrigin の全ての値について、空でない文字列を返す', () => {
    // Record で持つ: 値が増えたとき型で落ちる（配列だと素通りする）。
    const ALL_ORIGINS: Record<DroppedTraceOrigin, true> = { daemon: true };
    const origins = Object.keys(ALL_ORIGINS) as DroppedTraceOrigin[];
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(describeDroppedTraceOrigin(origin)).not.toBe('');
    }
  });

  it('describeDroppedTraceOrigin("daemon") は runner を除外する意味の文言を持つ', () => {
    const text = describeDroppedTraceOrigin('daemon');
    expect(text).toContain('デーモン');
    expect(text).toContain('runner');
  });

  // 上の toContain だけでは1文字の変異が生き残るので、全文一致も持つ。
  it('describeDroppedTraceOrigin("daemon") は文字列として完全一致する', () => {
    expect(describeDroppedTraceOrigin('daemon')).toBe(
      'デーモンのプロセス（クローンを含む）が残した跡だけである。' +
        '別プロセスの runner が残した跡はここには出ない。',
    );
  });

  it('describeDroppedTraceEmpty() は「0件＝無事」とは読ませない', () => {
    const text = describeDroppedTraceEmpty();
    expect(text).not.toBe('');
    expect(text).toContain('意味しない');
    expect(text).toContain('再起動');
  });

  it('describeDroppedTraceEmpty() は時刻を埋め込まない', () => {
    expect(describeDroppedTraceEmpty()).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it('describeDroppedTraceRetention(limit) は上限の件数を含み、押し出しと在り処を言う', () => {
    const text = describeDroppedTraceRetention(RECENT_TRACE_LIMIT);
    expect(text).toContain(String(RECENT_TRACE_LIMIT));
    expect(text).toContain('押し出される');
    expect(text).toContain('stderr');
  });
});

describe('droppedTraceLedgerSince（帳面が数え始めた時刻）', () => {
  it('ISO 8601 の時刻を返す', () => {
    const since = droppedTraceLedgerSince();
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
    expect(Number.isNaN(Date.parse(since))).toBe(false);
  });

  it('clearRecentTracesForTesting() が呼ばれると取り直される', async () => {
    const before = droppedTraceLedgerSince();

    // ミリ秒の分解能より速く2回呼ぶと取り直しても同じ値になりうるので、実時間で待つ。
    await new Promise((resolve) => setTimeout(resolve, 2));

    clearRecentTracesForTesting();
    const after = droppedTraceLedgerSince();

    expect(after).not.toBe(before);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

// 名簿は欄が出るかまでしか見ない（値の取り違えは型別の toBe が持つ）。数えるのは第1階層だけで、
// 入れ子は CONTEXT_USAGE_* の2階層だけ別名簿で守る。再帰で自動的に辿らない: 新しい欄が黙って出る側へ倒れるため。
describe('journalEntryShape の名簿（schema に足した欄の足し忘れを赤くする。PR #709）', () => {
  type FieldPlan =
    | { readonly emit: 'tag'; readonly token: string }
    | { readonly emit: 'raw'; readonly token: string }
    | { readonly emit: 'size'; readonly token: string }
    | {
        readonly emit: 'size-unnamed';
        // 同じ型に、tag() を通す素の string 欄（実行時検査だけで縛られるもの）が在るならその欄名。
        readonly poisonableTagField?: string;
      }
    | { readonly emit: 'never'; readonly why: string };

  type ShapedFieldsOf<T extends JournalEntryType> = Exclude<
    keyof Extract<JournalEntryInput, { type: T }>,
    'type'
  >;

  const JOURNAL_SHAPE_PLAN = {
    exchange: {
      with: { emit: 'tag', token: 'with' },
      role: { emit: 'tag', token: 'role' },
      // poisonableTagField 無し: with/role は z.enum 由来のリテラル合併型で、chars= を含む値を持てない。
      text: { emit: 'size-unnamed' },
      conversationId: {
        emit: 'never',
        why:
          '欠落ではなく設計。呼び出し側が決める値（`app.ts` の `given ?? randomUUID()`）で、' +
          '`inboxEventShape` の doc が「同じ値の扱いを2か所で変えないこと」と縛っている' +
          "（逐語は `command grep -Fn -- '同じ値の扱いを2か所で' packages/core/src/dropped-record.ts`）。" +
          '足すなら2か所同時、`tag()` は禁止。',
      },
      supersedes: {
        emit: 'never',
        why:
          '`conversationId`（直上）と同じ判断。値を決めるのは呼び出し側' +
          '（アプリ層の検証を経て `POST /chat` の `supersedes` から渡る）で、' +
          'この関数はその検証の外に立つ。足すなら `inboxEventShape` の' +
          '`human_message.supersedes` と2か所同時、`tag()` は禁止。',
      },
      clientMessageId: {
        emit: 'never',
        why:
          '送った側（クライアント）が決める値（#3203）で、この関数の外にある。' +
          '`inboxEventShape` の `human_message.clientMessageId` と2か所同時、`tag()` は禁止。',
      },
      withdrawnClientMessageId: {
        emit: 'never',
        why:
          '取り下げた発言の `clientMessageId`（#3990）。送った側が決めた値の写しで、' +
          '`clientMessageId`（直上）と同じ判断。足すなら2か所同時、`tag()` は禁止。',
      },
      attachments: {
        emit: 'never',
        why:
          '添付の参照（#3111）。ファイル名は人間が付けた自由文で、中身（bytes）は' +
          'そもそも日誌にも受信箱にも無い。`inboxEventShape` の `human_message.attachments` と同じ判断で、`tag()` は禁止。',
      },
      rejectedAttachments: {
        emit: 'never',
        why:
          '担い手の報告で受け取れなかったファイルの名前と理由（#4126 P2b）。自由文を含みうるので `attachments`（直上）と' +
          '同じ判断で跡には出さない。`inboxEventShape` の `manager_message.rejectedAttachments` と同時に判断すること、`tag()` は禁止。',
      },
      turnFailure: {
        emit: 'never',
        why:
          '`failed` / `held` の2語の列挙。`role` と同じく自由文を運べないが、' +
          '落ちた行の形を追うのに要らない（文面側は `text` が桁だけ持つ）。',
      },
      turnFailureKind: {
        emit: 'never',
        why: '`auth` / `quota` / `other` の3語の列挙。`turnFailure` と同じく落ちた行の形を追うのに要らない。',
      },
      approvalId: { emit: 'tag', token: 'approvalId' },
      managerId: { emit: 'tag', token: 'managerId' },
      answeredApprovalId: { emit: 'tag', token: 'answeredApprovalId' },
    },
    decision: {
      decision: { emit: 'size', token: 'decision' },
      grounds: { emit: 'size', token: 'grounds' },
      answeredApprovalId: { emit: 'tag', token: 'answeredApprovalId' },
      target: {
        emit: 'never',
        why: '書いたやり方の slug。落ちた行の形を追うのに要らず、slug の文字列を運ぶ側へ足さない。',
      },
    },
    escalation: {
      question: { emit: 'size', token: 'question' },
      approvalId: { emit: 'tag', token: 'approvalId' },
      managerId: { emit: 'tag', token: 'managerId' },
      answeredAt: {
        emit: 'never',
        why: 'PR #709 が「doc が『載せる』と言っていないので機能追加になる」として別判断へ回した欄。載せる判断をするならそこから。',
      },
      answer: { emit: 'size', token: 'answer' },
      withdrawnAt: {
        emit: 'never',
        why: '#963 で足した欄。answeredAt と対称の終端時刻で、PR #709 が answeredAt に付けた判断（載せる判断は別途）をそのまま引き継ぐ。',
      },
      withdrawnReason: { emit: 'size', token: 'withdrawnReason' },
      answeredVia: {
        emit: 'never',
        why:
          '回答の経路（Issue #1479）。中身は id・enum 値のみで自由文を運ばないが、' +
          'この関数は入れ子の中へ踏み込まない第1階層までの一般原則（冒頭 doc）を' +
          '適用し、`never` へ倒す。',
      },
    },
    tool_use: {
      actor: { emit: 'tag', token: 'actor' },
      tool: { emit: 'tag', token: 'tool' },
      input: {
        emit: 'never',
        why:
          'この関数の doc が名指しする唯一の例外で、長さも出さない' +
          "（逐語は `command grep -Fn -- '唯一の例外は' packages/core/src/dropped-record.ts`）。" +
          '理由は2つ——(1) `z.unknown()` なので長さを出すには `JSON.stringify` が要るが、' +
          'この関数が走るのは日誌への書き込みが既に失敗した後の例外経路で、そこで循環参照や' +
          '巨大構造の直列化を新たに走らせるのは跡を残す仕組み自身を落としに行く形になる。' +
          '(2) ツール引数そのもの（`{ command: <シェル行> }` 等）で、この関数が扱う自由文の' +
          '中でもいちばん秘密が載りうる。',
      },
      outcome: { emit: 'tag', token: 'outcome' },
      error: { emit: 'size', token: 'error' },
      answeredApprovalId: { emit: 'tag', token: 'answeredApprovalId' },
    },
    memory_update: {
      slug: { emit: 'tag', token: 'slug' },
      cause: { emit: 'tag', token: 'cause' },
      action: { emit: 'tag', token: 'action' },
      bytesBefore: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
      bytesAfter: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
      // slug の型は素の string で、journal.append 失敗後の経路には検査を通らない値が来うる。
      summary: { emit: 'size-unnamed', poisonableTagField: 'slug' },
      answeredApprovalId: { emit: 'tag', token: 'answeredApprovalId' },
    },
    daily_report: {
      date: { emit: 'tag', token: 'date' },
      body: { emit: 'size-unnamed', poisonableTagField: 'date' },
      unavailable: { emit: 'size', token: 'unavailable' },
    },
    external_event: {
      source: { emit: 'size', token: 'source' },
      // poisonableTagField 無し: tag() を1回も呼ばない型。
      summary: { emit: 'size-unnamed' },
      via: {
        emit: 'never',
        why:
          '連携の鍵経由のときの鍵の id と名前（#3113）。名前は人間が付けたラベル（自由文）なので、' +
          '落ちた記録の跡には載せない（この関数は参照しない）。',
      },
      attachments: {
        emit: 'never',
        why:
          '添付の参照（#3113 段3）。ファイル名は外から来る自由文で、中身（bytes）はそもそも日誌にも受信箱にも無い。' +
          '`inboxEventShape` の `external.attachments` と同じ判断で、`tag()` は禁止。',
      },
    },
    worker_wait: {
      openedAt: { emit: 'tag', token: 'openedAt' },
      tasks: { emit: 'raw', token: 'tasks' },
      turns: { emit: 'raw', token: 'turns' },
      byCause: { emit: 'raw', token: 'byCause.input' },
      toolless: { emit: 'raw', token: 'toolless' },
      notifications: { emit: 'raw', token: 'notifications' },
      submits: { emit: 'raw', token: 'submits' },
      sources: { emit: 'raw', token: 'sources' },
      settled: { emit: 'raw', token: 'settled' },
    },
    turn_usage: {
      layer: { emit: 'tag', token: 'layer' },
      site: { emit: 'tag', token: 'site' },
      managerId: { emit: 'tag', token: 'managerId' },
      sessionId: { emit: 'tag', token: 'sessionId' },
      models: { emit: 'raw', token: 'models' },
      reset: { emit: 'raw', token: 'reset' },
      contextUsage: {
        emit: 'never',
        why: "#981 で決めた（入れ子のどの階層も跡へ出さない）。理由は `dropped-record.ts` の `case 'context_usage'` の doc に1箇所だけ書いてある。",
      },
      compactions: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。#981 で「自由文を1つも持たない」ことは確かめたので、残るのは出す価値の判断だけである。',
      },
      mainLoopUsage: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。#981 で「自由文を1つも持たない」ことは確かめたので、残るのは出す価値の判断だけである。',
      },
    },
    token_rotation: {
      event: { emit: 'tag', token: 'event' },
      signal: { emit: 'tag', token: 'signal' },
      reason: { emit: 'tag', token: 'reason' },
      freshness: { emit: 'tag', token: 'freshness' },
      tokenId: { emit: 'tag', token: 'tokenId' },
      fromTokenId: { emit: 'tag', token: 'fromTokenId' },
      generation: { emit: 'raw', token: 'generation' },
      earliestAt: { emit: 'tag', token: 'earliestAt' },
      cooldownSource: { emit: 'tag', token: 'cooldownSource' },
      recoveredSource: { emit: 'tag', token: 'recoveredSource' },
      label: { emit: 'size', token: 'label' },
      noticeText: { emit: 'size', token: 'noticeText' },
      text: { emit: 'size-unnamed', poisonableTagField: 'tokenId' },
    },
    subagent_stall: {
      agentId: { emit: 'tag', token: 'agentId' },
      agentType: { emit: 'tag', token: 'agentType' },
      ownedTaskCount: { emit: 'raw', token: 'ownedTaskCount' },
      sessionTaskCount: { emit: 'raw', token: 'sessionTaskCount' },
      wakeupCount: { emit: 'raw', token: 'wakeupCount' },
      outcome: { emit: 'tag', token: 'outcome' },
      text: { emit: 'size-unnamed', poisonableTagField: 'agentId' },
    },
    context_usage: {
      layer: { emit: 'tag', token: 'layer' },
      site: { emit: 'tag', token: 'site' },
      managerId: { emit: 'tag', token: 'managerId' },
      sessionId: { emit: 'tag', token: 'sessionId' },
      turnSucceeded: { emit: 'raw', token: 'turnSucceeded' },
      contextUsage: {
        emit: 'never',
        why: "#981 で決めた（入れ子のどの階層も跡へ出さない）。理由は `dropped-record.ts` の `case 'context_usage'` の doc に1箇所だけ書いてある。",
      },
    },
    inbox_flow: {
      windowStartedAt: { emit: 'tag', token: 'windowStartedAt' },
      arrived: { emit: 'raw', token: 'arrived' },
      delivered: { emit: 'raw', token: 'delivered' },
      settled: { emit: 'raw', token: 'settled' },
      pending: { emit: 'raw', token: 'pending' },
      retained: { emit: 'raw', token: 'retainedUnread' },
    },
    github_observation: {
      observedBy: {
        emit: 'never',
        why: '観測した側が名乗る値で、デーモンは確かめられない。跡（stderr）へ出さない。',
      },
      repo: { emit: 'never', why: '観測した側が名乗る自由文。`observedBy` と同じ判断。' },
      query: { emit: 'never', why: '観測した側が書く引数の文字列。`observedBy` と同じ判断。' },
      limit: { emit: 'never', why: '母集合の切り方は跡の見分けに要らない（`query` と同じ側）。' },
      result: { emit: 'raw', token: 'status' },
    },
    conversation_deleted: {
      deletedConversationId: {
        emit: 'never',
        why: '消した会話の識別子。`exchange.conversationId` と同じ判断で跡へ出さない。',
      },
      deletedBy: { emit: 'never', why: '消した主体の識別子。跡の見分けに要らない。' },
      hiddenCount: { emit: 'raw', token: 'hiddenCount' },
    },
  } satisfies { [T in JournalEntryType]: Record<ShapedFieldsOf<T>, FieldPlan> };

  const CONTEXT_USAGE_SHAPE_PLAN = {
    durationMs: {
      emit: 'never',
      why:
        '出して害の無い数値だが、#981 で「contextUsage は入れ子のどの階層も' +
        '跡へ出さない」と決めた——その判断が先に掛かる。単独で広げるなら、' +
        'error/categories[].name/categories[].kind とは別に判断すること。',
    },
    totalTokens: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    rawMaxTokens: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    percentage: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    autoCompactThreshold: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    isAutoCompactEnabled: { emit: 'never', why: '同上（durationMs と同じ判断。真偽値も対象）。' },
    categories: {
      emit: 'never',
      why:
        '構造化された欄そのもの。要素の中身は `CONTEXT_USAGE_CATEGORY_SHAPE_PLAN`' +
        '（このファイルの下）が別に守る。この欄自体（配列であること・件数）を' +
        '出す判断も #981 の対象——`contextUsage` を丸ごと出さないという判断に' +
        '含めた。',
    },
    categoriesOmitted: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    mcpToolTokens: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    mcpToolCount: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    memoryFileTokens: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    memoryFileCount: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    systemPromptTokens: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    systemPromptSectionCount: { emit: 'never', why: '同上（durationMs と同じ判断）。' },
    error: {
      emit: 'never',
      why:
        '値を決めるのは SDK 側であって alteroid ではない——`usage-probe.ts` の' +
        '`describeProbeError` が通す `redactEnvSecrets` は env 値の完全一致の' +
        '文字列置換だけで、その doc 自身が「値が変形されて出てきた場合までは' +
        '塞げない」と明記している。「伏せ字済みだから載せてよい」は成り立たない。',
    },
  } satisfies Record<keyof Required<ContextUsageObservation>, FieldPlan>;

  const CONTEXT_USAGE_CATEGORY_SHAPE_PLAN = {
    name: {
      emit: 'never',
      why:
        'SDK 側の表示名（`System prompt` / `Tools` 等）——値を決めるのは SDK で、' +
        '版が上がれば変わりうるし、変わっても赤くならない（schema.ts の doc）。',
    },
    tokens: {
      emit: 'never',
      why:
        '出して害の無い数値だが、#981 で「contextUsage は入れ子のどの階層も' +
        '跡へ出さない」と決めた——その判断が先に掛かる（`CONTEXT_USAGE_SHAPE_PLAN`' +
        'の `durationMs` と同じ）。',
    },
    kind: {
      emit: 'never',
      why:
        'SDK が名乗る分類文字列——`z.enum` ではなく `z.string()` にしてあるのは、' +
        'SDK が将来5つ目の値を足しても書き込みが壊れないようにするためで' +
        '（schema.ts の doc）、値を決めるのは SDK である。',
    },
  } satisfies Record<
    keyof Required<NonNullable<ContextUsageObservation['categories']>[number]>,
    FieldPlan
  >;

  const SECRET = 'ghp_222222222222222222222222222222222222';

  // 他の欄の値と衝突しない桁を割り当てる（小さい値だと衝突しうる）。
  const CU_DURATION_MS = 910001;
  const CU_TOTAL_TOKENS = 910002;
  const CU_RAW_MAX_TOKENS = 910003;
  const CU_PERCENTAGE = 910004;
  const CU_AUTO_COMPACT_THRESHOLD = 910005;
  const CU_CATEGORIES_OMITTED = 910006;
  const CU_MCP_TOOL_TOKENS = 910007;
  const CU_MCP_TOOL_COUNT = 910008;
  const CU_MEMORY_FILE_TOKENS = 910009;
  const CU_MEMORY_FILE_COUNT = 910010;
  const CU_SYSTEM_PROMPT_TOKENS = 910011;
  const CU_SYSTEM_PROMPT_SECTION_COUNT = 910012;
  const CU_CATEGORY_TOKENS = 910013;

  const CONTEXT_USAGE_NUMBER_MARKERS: readonly number[] = [
    CU_DURATION_MS,
    CU_TOTAL_TOKENS,
    CU_RAW_MAX_TOKENS,
    CU_PERCENTAGE,
    CU_AUTO_COMPACT_THRESHOLD,
    CU_CATEGORIES_OMITTED,
    CU_MCP_TOOL_TOKENS,
    CU_MCP_TOOL_COUNT,
    CU_MEMORY_FILE_TOKENS,
    CU_MEMORY_FILE_COUNT,
    CU_SYSTEM_PROMPT_TOKENS,
    CU_SYSTEM_PROMPT_SECTION_COUNT,
    CU_CATEGORY_TOKENS,
  ];

  const FULL_CONTEXT_USAGE_CATEGORY: Required<
    NonNullable<ContextUsageObservation['categories']>[number]
  > = {
    name: SECRET,
    tokens: CU_CATEGORY_TOKENS,
    kind: SECRET,
  };

  const FULL_CONTEXT_USAGE: Required<ContextUsageObservation> = {
    durationMs: CU_DURATION_MS,
    totalTokens: CU_TOTAL_TOKENS,
    rawMaxTokens: CU_RAW_MAX_TOKENS,
    percentage: CU_PERCENTAGE,
    autoCompactThreshold: CU_AUTO_COMPACT_THRESHOLD,
    isAutoCompactEnabled: true,
    categories: [FULL_CONTEXT_USAGE_CATEGORY],
    categoriesOmitted: CU_CATEGORIES_OMITTED,
    mcpToolTokens: CU_MCP_TOOL_TOKENS,
    mcpToolCount: CU_MCP_TOOL_COUNT,
    memoryFileTokens: CU_MEMORY_FILE_TOKENS,
    memoryFileCount: CU_MEMORY_FILE_COUNT,
    systemPromptTokens: CU_SYSTEM_PROMPT_TOKENS,
    systemPromptSectionCount: CU_SYSTEM_PROMPT_SECTION_COUNT,
    error: SECRET,
  };

  const FULL_FIXTURES: {
    [T in JournalEntryType]: Required<Extract<JournalEntryInput, { type: T }>>;
  } = {
    exchange: {
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: SECRET,
      conversationId: SECRET,
      supersedes: SECRET,
      clientMessageId: SECRET,
      withdrawnClientMessageId: SECRET,
      attachments: [{ id: SECRET, name: SECRET, mediaType: 'image/png', size: 1, sha256: SECRET }],
      rejectedAttachments: [{ name: SECRET, reason: SECRET }],
      turnFailure: 'failed',
      turnFailureKind: 'other',
      approvalId: 'ap-1',
      managerId: 'mgr-1',
      answeredApprovalId: 'ap-2',
    },
    decision: {
      type: 'decision',
      decision: SECRET,
      grounds: SECRET,
      answeredApprovalId: 'ap-2',
      target: { kind: 'practice', slug: 'daily' },
    },
    escalation: {
      type: 'escalation',
      question: SECRET,
      approvalId: 'ap-1',
      managerId: 'mgr-1',
      answeredAt: '2026-08-20T00:00:00.000Z',
      answer: SECRET,
      withdrawnAt: '2026-08-20T00:00:00.000Z',
      withdrawnReason: SECRET,
      answeredVia: { kind: 'account', accountId: SECRET },
    },
    tool_use: {
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
      input: { command: SECRET },
      outcome: 'failed',
      error: SECRET,
      answeredApprovalId: 'ap-2',
    },
    memory_update: {
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: 10,
      bytesAfter: 20,
      summary: SECRET,
      answeredApprovalId: 'ap-2',
    },
    daily_report: {
      type: 'daily_report',
      date: '2026-08-20',
      body: SECRET,
      unavailable: SECRET,
    },
    external_event: {
      type: 'external_event',
      source: SECRET,
      summary: SECRET,
      via: { keyId: SECRET, name: SECRET },
      attachments: [{ id: SECRET, name: SECRET, mediaType: 'image/png', size: 1, sha256: SECRET }],
    },
    worker_wait: {
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      sources: { system: 3, user: 1 },
      settled: false,
    },
    turn_usage: {
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUsd: 1.2345,
        },
      },
      reset: { fromCostUsd: 5, toCostUsd: 3 },
      contextUsage: FULL_CONTEXT_USAGE,
      compactions: [{ trigger: 'manual', preTokens: 1000 }],
      mainLoopUsage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    },
    token_rotation: {
      type: 'token_rotation',
      event: 'recovered',
      signal: 'reached',
      reason: 'turn_succeeded',
      freshness: 'current',
      tokenId: 'tok-1',
      fromTokenId: 'tok-0',
      generation: 3,
      earliestAt: '2026-08-20T00:00:00.000Z',
      cooldownSource: 'quota_reset',
      recoveredSource: 'account_probe',
      label: SECRET,
      noticeText: SECRET,
      text: SECRET,
    },
    subagent_stall: {
      type: 'subagent_stall',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: SECRET,
    },
    context_usage: {
      type: 'context_usage',
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      turnSucceeded: false,
      contextUsage: FULL_CONTEXT_USAGE,
    },
    inbox_flow: {
      type: 'inbox_flow',
      windowStartedAt: '2026-09-16T00:00:00.000Z',
      arrived: { total: 1, byType: [{ type: 'human_message', count: 1 }] },
      delivered: { total: 1, byType: [{ type: 'human_message', count: 1 }] },
      settled: { total: 0, byType: [] },
      pending: { count: 2, oldestAt: '2026-09-15T00:00:00.000Z' },
      retained: { unread: 1, redelivered: 1, redeliveredClosed: 1, pendingCollapse: 1 },
    },
    github_observation: {
      type: 'github_observation',
      observedBy: SECRET,
      repo: SECRET,
      query: SECRET,
      limit: 100,
      result: { status: 'ok', openIssues: 3, openPulls: 1, truncated: false },
    },
    conversation_deleted: {
      type: 'conversation_deleted',
      deletedConversationId: SECRET,
      deletedBy: SECRET,
      hiddenCount: 4,
    },
  };

  it('名簿のキー集合は journalEntrySchema の実装側の欄と両方向に一致する（zod から機械的に引く）', () => {
    const scannedTypes = journalEntrySchema.options.map((option) => option.shape.type.value);
    expect(new Set(scannedTypes)).toEqual(new Set(JOURNAL_ENTRY_TYPES));
    expect(scannedTypes.length).toBeGreaterThan(0);

    for (const option of journalEntrySchema.options) {
      const type = option.shape.type.value;
      const implementedFields = new Set(Object.keys(option.shape));
      implementedFields.delete('type');
      implementedFields.delete('id');
      implementedFields.delete('at');

      const plannedFields = new Set(Object.keys(JOURNAL_SHAPE_PLAN[type]));

      expect(plannedFields, type).toEqual(implementedFields);
    }
  });

  it('名簿の各欄について journalEntryShape が plan どおりに振る舞う（never は出ない・size 系は長さだけ・tag/raw は目印が出る）', () => {
    for (const type of JOURNAL_ENTRY_TYPES) {
      const shape = journalEntryShape(FULL_FIXTURES[type]);
      const plan: Record<string, FieldPlan> = JOURNAL_SHAPE_PLAN[type];

      for (const [field, fieldPlan] of Object.entries(plan)) {
        switch (fieldPlan.emit) {
          case 'never':
            expect(shape, `${type}.${field}`).not.toContain(field);
            break;
          case 'size':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}.chars=`);
            break;
          case 'size-unnamed': {
            // toContain('chars=') にしない: 同じ型の名前付き size 欄の `<token>.chars=` に当たって、
            // 無名の欄が落ちても緑になる。境界と実際の長さの両方で絞る。
            const realToken = `chars=${SECRET.length}`;
            const anchoredReal = new RegExp(`(?:^| )chars=${SECRET.length}(?:$| )`, 'u');

            expect(
              shape,
              `${type}.${field}: 無名の size 欄が実際の長さ（${SECRET.length}）を、` +
                '名前付き欄と取り違えられない形で持つこと（Issue #823・境界＋値の判定）',
            ).toMatch(anchoredReal);

            // 同じ桁数の毒までは区別できない（型別の toBe が持つ）。
            if (fieldPlan.poisonableTagField !== undefined) {
              const poisonField = fieldPlan.poisonableTagField;
              // 桁を本物と変える。SECRET が変わっても黙って無力化しないためのガードが下にある。
              const poisonNumber = 1;
              const poisonToken = `chars=${poisonNumber}`;
              expect(poisonToken.startsWith(realToken)).toBe(false);
              expect(realToken.startsWith(poisonToken)).toBe(false);

              const poisonedFields: Record<string, unknown> = { ...FULL_FIXTURES[type] };
              poisonedFields[poisonField] = `poison ${poisonToken}`;
              const poisonedShape = journalEntryShape(
                poisonedFields as unknown as JournalEntryInput,
              );

              // 対照: 緩い判定は毒だけで満たせてしまう。
              expect(poisonedShape).toMatch(/(?:^| )chars=\d+/u);

              expect(
                poisonedShape,
                `${type}.${poisonField} に chars=<数字> を含む毒（${poisonToken}）を` +
                  `仕込んでも、${type}.${field} の真の長さ（${SECRET.length}）は` +
                  '取り違えられずに読み取れること（Issue #823）',
              ).toMatch(anchoredReal);
            }

            expect(shape, `${type}.${field}`).toMatch(/(?:^| )chars=\d+/u);
            break;
          }
          case 'tag':
          case 'raw':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=`);
            break;
        }
      }
    }
  });

  it('値が出ない欄（size/size-unnamed/never）に置いた自由文は、どの型の跡にも現れない', () => {
    for (const type of JOURNAL_ENTRY_TYPES) {
      const shape = journalEntryShape(FULL_FIXTURES[type]);
      expect(shape, type).not.toContain(SECRET);
    }
  });

  it('CONTEXT_USAGE_SHAPE_PLAN のキー集合は contextUsageObservationSchema の実装側の欄と両方向に一致する（zod から機械的に引く）', () => {
    const implementedFields = new Set(Object.keys(contextUsageObservationSchema.shape));
    expect(implementedFields.size).toBeGreaterThan(0);

    const plannedFields = new Set(Object.keys(CONTEXT_USAGE_SHAPE_PLAN));
    expect(plannedFields).toEqual(implementedFields);
  });

  it('CONTEXT_USAGE_CATEGORY_SHAPE_PLAN のキー集合は categories[] の要素の実装側の欄と両方向に一致する（zod から機械的に引く）', () => {
    const categoriesField = contextUsageObservationSchema.shape.categories;
    const categoryShape = categoriesField.unwrap().element.shape;
    const implementedFields = new Set(Object.keys(categoryShape));
    expect(implementedFields.size).toBeGreaterThan(0);

    const plannedFields = new Set(Object.keys(CONTEXT_USAGE_CATEGORY_SHAPE_PLAN));
    expect(plannedFields).toEqual(implementedFields);
  });

  it('turn_usage.contextUsage / context_usage.contextUsage の入れ子は、秘密・目印・欄名のどれも跡に現れない（#981）', () => {
    const contextUsageFieldNames = [
      ...Object.keys(CONTEXT_USAGE_SHAPE_PLAN),
      ...Object.keys(CONTEXT_USAGE_CATEGORY_SHAPE_PLAN),
    ];

    for (const type of ['turn_usage', 'context_usage'] as const) {
      const shape = journalEntryShape(FULL_FIXTURES[type]);

      expect(shape, `${type}: contextUsage 配下の自由文（SECRET）`).not.toContain(SECRET);

      for (const marker of CONTEXT_USAGE_NUMBER_MARKERS) {
        expect(shape, `${type}: contextUsage の目印（${marker}）`).not.toContain(String(marker));
      }

      // 欄名は補助: name/kind のような短い語は判定力が弱い。主たる保証は SECRET と目印の値。
      for (const field of contextUsageFieldNames) {
        expect(shape, `${type}: contextUsage の欄名（${field}）`).not.toContain(field);
      }
    }
  });
});

describe('reasonOf / 例外の文の伏せ字（issue #2415）', () => {
  const FAKE = 'FAKE_SECRET_VALUE_2415B';

  it('drizzle の形（Failed query + params）: 値は出ず、SQL 文は残る', () => {
    const out = reasonOf(
      new Error(`Failed query: insert into "agent_tokens" ("value") values ($1)\nparams: ${FAKE}`),
    );
    expect(out).not.toContain(FAKE);
    expect(out).toContain('Failed query: insert into "agent_tokens" ("value") values ($1)');
  });

  it('drizzle の形（改行の無い版）: 値は出ず、params の印が残る', () => {
    const out = reasonOf(new Error(`Failed query: select 1 params: ${FAKE}`));
    expect(out).not.toContain(FAKE);
    expect(out).toContain('params: [REDACTED]');
  });

  it('URL の資格: 値は出ず、エラーの種類と host は残る', () => {
    const out = reasonOf(new TypeError(`fetch failed postgres://u:${FAKE}@db.internal:5432/x`));
    expect(out).not.toContain(FAKE);
    expect(out).toContain('TypeError: fetch failed');
    expect(out).toContain('db.internal:5432');
  });

  it('Bearer: 値は出ない', () => {
    expect(reasonOf(new Error(`Bearer ${FAKE}`))).not.toContain(FAKE);
  });

  it('cause の中に値があっても出ない', () => {
    const cause = new Error(`Authorization: Bearer ${FAKE}`);
    const out = reasonOf(new Error('upstream failed', { cause }));
    expect(out).not.toContain(FAKE);
    expect(out).toContain('upstream failed');
  });

  it('noteDroppedRecord の stderr にも値が出ない', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', 'type=x', new Error(`Failed query: select 1 params: ${FAKE}`));
    });
    expect(lines.join('')).not.toContain(FAKE);
    expect(lines.join('')).toContain('Failed query: select 1');
  });
});
