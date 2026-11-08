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

// `Pool#handleEvent` の `case 'session'` / `case 'tool_use'` / `case 'parked_peers_closed'` の処理を、
// 外から見える結果（日誌の全文と `with/role`・台帳の行・受信箱の知らせ・runner への呼び）だけで縛る。
// 期待の文字列は、切り出し前の作りの出力から生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流し、そのたびにマイクロタスクを流しきる。時計は注入する。

const JOB_ID = 'mgr-obs-pin';

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

const NOW_ISO = '2026-11-01T00:00:00.000Z';

async function open(options: { job?: Partial<Job>; unpushedWorkThrows?: boolean } = {}) {
  const clock = Date.parse(NOW_ISO);
  let emit: ((event: RunnerEvent) => void) | null = null;
  let unpushedWorkCalls = 0;
  // 終端の行を「まだ走っている」と読ませると restore が running へ戻す: 終端の試験では runner の側は空にする
  const terminal = options.job?.status !== undefined && options.job.status !== 'running';
  const alive: RunnerManagerState[] = terminal
    ? []
    : [
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
    async list() {
      return [...alive];
    },
    async setProfile() {
      return { ok: true as const };
    },
    async unpushedWork() {
      unpushedWorkCalls += 1;
      if (options.unpushedWorkThrows === true) throw new Error('unpushedWork 失敗（試験）');
      return undefined;
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...options.job,
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
  const exchangeBefore = (await stores.journal.list({ types: ['exchange'] })).length;
  return {
    pool,
    stores,
    inbox,
    unpushedWorkCalls: () => unpushedWorkCalls,
    async push(event: RunnerEvent): Promise<void> {
      emit?.(event);
      await settle();
    },
    async exchanges(): Promise<{ text: string; roleLine: string }[]> {
      const entries = await stores.journal.list({ types: ['exchange'] });
      return entries
        .flatMap((entry) =>
          entry.type === 'exchange'
            ? [{ text: entry.text, roleLine: `${entry.with}/${entry.role}` }]
            : [],
        )
        .reverse()
        .slice(exchangeBefore);
    },
    async job(): Promise<Job | null> {
      return stores.jobs.getJob(JOB_ID);
    },
    reports(): string[] {
      return inbox.flatMap((event) =>
        event.type === 'manager_message' && event.kind === 'report' ? [event.text] : [],
      );
    },
  };
}

function session(extra: Partial<Extract<RunnerEvent, { type: 'session' }>> = {}): RunnerEvent {
  return { type: 'session', managerId: JOB_ID, sessionId: 'sess-2', ...extra };
}

describe('session: plugin の読み込み結果の日誌', () => {
  const FIRST = { plugins: [{ name: 'first', version: '1.0.0' }], errors: null };
  const SECOND = {
    plugins: [{ name: 'second' }],
    errors: [{ plugin: 'q', type: 'load', message: 'boom' }],
  };

  it('日誌は [判断] の接頭辞つき・manager/inbound の全文で書き、同じ結果の再送は重ねず、変われば書く', async () => {
    const s = await open();

    await s.push(session({ pluginLoad: FIRST }));
    await s.push(session({ sessionId: 'sess-3', pluginLoad: FIRST }));
    await s.push(session({ sessionId: 'sess-4', pluginLoad: SECOND }));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: `[判断] [${JOB_ID}] init が知らせた plugin の読み込み結果: 読み込めた plugin: first@1.0.0。読み込みの失敗: 失敗の報告は無い`,
      },
      {
        roleLine: 'manager/inbound',
        text: `[判断] [${JOB_ID}] init が知らせた plugin の読み込み結果: 読み込めた plugin: second。読み込みの失敗: 失敗 1 件 — q（load）: boom`,
      },
    ]);
    await s.pool.stop();
  });

  it('pluginLoad を運ぶ session は、runner の鍵・managerId・注入した時計の時刻で控える。欄が無い session は消さない', async () => {
    const s = await open();

    await s.push(session({ pluginLoad: FIRST }));
    expect(s.pool.pluginLoadOf?.('runner-primary')).toEqual({
      at: NOW_ISO,
      managerId: JOB_ID,
      pluginLoad: FIRST,
    });
    await s.push(session({ sessionId: 'sess-3' }));
    expect(s.pool.pluginLoadOf?.('runner-primary')?.pluginLoad).toEqual(FIRST);
    await s.pool.stop();
  });
});

describe('session: MCP サーバの接続の失敗の日誌', () => {
  const CONNECTED = { name: 'alteroid', status: 'connected' };
  const GITHUB = { name: 'ext-github', status: 'failed' };

  it('日誌は [障害] の接頭辞つき・manager/inbound の全文。全部つながれば署名を消すので、同じ失敗がまた起きたら書き直す', async () => {
    const s = await open();

    await s.push(session({ mcpServers: [CONNECTED, GITHUB] }));
    await s.push(session({ sessionId: 'sess-3', mcpServers: [CONNECTED, GITHUB] }));
    // 全部つながった回（署名を消す）→ 同じ失敗の再発は、前回と同じ署名でも書き直す
    await s.push(session({ sessionId: 'sess-4', mcpServers: [CONNECTED] }));
    await s.push(session({ sessionId: 'sess-5', mcpServers: [CONNECTED, GITHUB] }));

    const lines = await s.exchanges();
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.roleLine)).toEqual(['manager/inbound', 'manager/inbound']);
    expect(lines[0]?.text).toBe(lines[1]?.text);
    expect(lines[0]?.text).toBe(
      `[障害] [${JOB_ID}] init が知らせた MCP サーバのうち、接続できていないもの: ext-github（failed）。この担当ではそのサーバの道具が使えない（認証が切れた・落ちた）。`,
    );
    await s.pool.stop();
  });

  it('mcpServers の欄が無い session は、署名を消さない（前回と同じ失敗は書かない）', async () => {
    const s = await open();

    await s.push(session({ mcpServers: [CONNECTED, GITHUB] }));
    await s.push(session({ sessionId: 'sess-3' }));
    await s.push(session({ sessionId: 'sess-4', mcpServers: [CONNECTED, GITHUB] }));

    expect(await s.exchanges()).toHaveLength(1);
    await s.pool.stop();
  });
});

describe('session: 台帳の行の更新', () => {
  it('sessionId と runnerSessionSince を台帳へ書き、turnStartedAt は後ろへだけ進める', async () => {
    const older = await open({ job: { turnStartedAt: '2026-10-31T00:00:00.000Z' } });
    await older.push(session());
    const olderJob = await older.job();
    expect(olderJob?.sessionId).toBe('sess-2');
    expect(olderJob?.runnerSessionSince).toBe(NOW_ISO);
    expect(olderJob?.turnStartedAt).toBe(NOW_ISO);
    expect(await older.exchanges()).toEqual([]);
    await older.pool.stop();

    const later = await open({ job: { turnStartedAt: '2026-11-02T00:00:00.000Z' } });
    await later.push(session());
    expect((await later.job())?.turnStartedAt).toBe('2026-11-02T00:00:00.000Z');
    expect((await later.job())?.runnerSessionSince).toBe(NOW_ISO);
    await later.pool.stop();
  });

  it('止めた委譲に遅れて届いた session も、早く抜けずに sessionId を書く（status は動かさない）', async () => {
    const s = await open({ job: { status: 'stopped' } });
    await s.push(session());
    const job = await s.job();
    expect(job?.status).toBe('stopped');
    expect(job?.sessionId).toBe('sess-2');
    expect(job?.runnerSessionSince).toBe(NOW_ISO);
    await s.pool.stop();
  });
});

describe('tool_use', () => {
  const ACTOR = `manager:${JOB_ID}`;

  async function toolUseLines(s: Awaited<ReturnType<typeof open>>) {
    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    return entries
      .flatMap((entry) =>
        entry.type === 'tool_use'
          ? [{ actor: entry.actor, tool: entry.tool, input: entry.input }]
          : [],
      )
      .reverse();
  }

  it('日誌へ tool_use を actor・tool・input つきで書く', async () => {
    const s = await open();
    await s.push({
      type: 'tool_use',
      managerId: JOB_ID,
      actor: ACTOR,
      tool: 'Read',
      input: { file_path: '/work/project/a.ts' },
    });
    expect(await toolUseLines(s)).toEqual([
      { actor: ACTOR, tool: 'Read', input: { file_path: '/work/project/a.ts' } },
    ]);
    expect(s.unpushedWorkCalls()).toBe(0);
    await s.pool.stop();
  });

  it('Bash の git push と枝の作成は未 push の観測を 1 回ずつ取り、他の道具・他のコマンド・コマンドの型違いは取らない', async () => {
    const cases: { tool: string; input: unknown; calls: number }[] = [
      { tool: 'Bash', input: { command: 'git push origin HEAD' }, calls: 1 },
      { tool: 'Bash', input: { command: 'git checkout -b feature/x' }, calls: 1 },
      { tool: 'Bash', input: { command: 'ls -la' }, calls: 0 },
      { tool: 'Bash', input: { command: 42 }, calls: 0 },
      { tool: 'Bash', input: null, calls: 0 },
      { tool: 'Bash', input: undefined, calls: 0 },
      { tool: 'Write', input: { command: 'git push' }, calls: 0 },
    ];
    for (const c of cases) {
      const s = await open();
      await s.push({
        type: 'tool_use',
        managerId: JOB_ID,
        actor: ACTOR,
        tool: c.tool,
        input: c.input,
      });
      expect([c.tool, c.input, s.unpushedWorkCalls()]).toEqual([c.tool, c.input, c.calls]);
      // どの場合も日誌には残る
      expect(await toolUseLines(s)).toHaveLength(1);
      await s.pool.stop();
    }
  });

  it('観測が失敗しても tool_use の処理は止めず、同じ委譲の観測は進行中なら重ねない', async () => {
    const s = await open({ unpushedWorkThrows: true });
    const push = {
      type: 'tool_use',
      managerId: JOB_ID,
      actor: ACTOR,
      tool: 'Bash',
      input: { command: 'git push' },
    } as const;
    await s.push(push);
    await s.push(push);
    expect(await toolUseLines(s)).toHaveLength(2);
    expect(s.unpushedWorkCalls()).toBeGreaterThanOrEqual(1);
    await s.pool.stop();
  });
});

describe('parked_peers_closed', () => {
  const PEERS = [
    { id: 'peer-aaa', provider: 'codex', interrupted: '調査の途中で止まった' },
    { id: 'peer-bbb', provider: 'codex' },
  ];
  const OF = (reason: 'stopped' | 'expired' | 'replaced' | 'shutdown' | 'failed'): RunnerEvent => ({
    type: 'parked_peers_closed',
    managerId: JOB_ID,
    reason,
    peers: PEERS,
  });

  it('人が止めた理由（reason=stopped）は、台帳へ預けずクローンへの知らせだけ（全文）', async () => {
    const s = await open();
    await s.push(OF('stopped'));
    expect(s.reports()).toEqual([
      `[${JOB_ID}] （alteroid より: peer 2 本を閉じた（ユーザーが止めた）。閉じた peer: codex[peer-aaa], codex[peer-bbb]。走っていた背景ターンは途中で終わった: codex[peer-aaa] 調査の途中で止まった。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）`,
    ]);
    expect((await s.job())?.pendingPeerCloseNotice).toBeUndefined();
    await s.pool.stop();
  });

  for (const status of ['stopped', 'failed', 'lost'] as const) {
    it(`担当が終端（${status}）なら、理由が expired でも台帳へ預けずクローンへの知らせだけ`, async () => {
      const s = await open({ job: { status } });
      await s.push(OF('expired'));
      expect(s.reports()).toHaveLength(1);
      expect(s.reports()[0]).toBe(
        `[${JOB_ID}] （alteroid より: peer 2 本を閉じた（鍵の付け替えで畳んだ担当が戻らないまま、預かりの期限が来た）。閉じた peer: codex[peer-aaa], codex[peer-bbb]。走っていた背景ターンは途中で終わった: codex[peer-aaa] 調査の途中で止まった。続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）`,
      );
      expect((await s.job())?.pendingPeerCloseNotice).toBeUndefined();
      await s.pool.stop();
    });
  }

  it('担当が起こされる（running・止まる理由でない）なら、知らせは出さず台帳へ at つきで預ける', async () => {
    const s = await open();
    await s.push(OF('expired'));
    expect(s.reports()).toEqual([]);
    expect((await s.job())?.pendingPeerCloseNotice).toEqual({
      reason: 'expired',
      peers: [
        {
          id: 'peer-aaa',
          provider: 'codex',
          interrupted: '調査の途中で止まった',
          reason: 'expired',
        },
        { id: 'peer-bbb', provider: 'codex', reason: 'expired' },
      ],
      at: NOW_ISO,
    });
    await s.pool.stop();
  });

  it('預けた知らせへ積む: 理由の欄が無い古い形の peer は、前の知らせの理由を写してから積み、理由は新しい方になる', async () => {
    const s = await open({
      job: {
        pendingPeerCloseNotice: {
          reason: 'expired',
          peers: [
            { id: 'peer-old', provider: 'codex' },
            { id: 'peer-own', provider: 'codex', reason: 'replaced' },
          ],
          at: '2026-10-31T00:00:00.000Z',
        },
      },
    });
    await s.push(OF('shutdown'));
    expect((await s.job())?.pendingPeerCloseNotice).toEqual({
      reason: 'shutdown',
      peers: [
        { id: 'peer-old', provider: 'codex', reason: 'expired' },
        { id: 'peer-own', provider: 'codex', reason: 'replaced' },
        {
          id: 'peer-aaa',
          provider: 'codex',
          interrupted: '調査の途中で止まった',
          reason: 'shutdown',
        },
        { id: 'peer-bbb', provider: 'codex', reason: 'shutdown' },
      ],
      at: NOW_ISO,
    });
    await s.pool.stop();
  });
});
