import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
} from './agent-session.js';
import {
  createPeerBroker,
  type PeerBrokerDeps,
  type PeerCallResult,
  type PeerResumable,
  type PeerThreadEvent,
  type PeerTurnResult,
} from './peer-broker.js';

function turnEnded(body: string): AgentEvent {
  return { type: 'turn_ended', succeeded: true, body, errorLines: [], denials: [] };
}

function setup(
  options: {
    resumable?: Record<string, PeerResumable>;
    maxLiveSessions?: number;
    prepareResume?: PeerBrokerDeps['prepareResume'];
    transcriptLocation?: string;
  } = {},
) {
  const specs: AgentManagerSessionSpec[] = [];
  const notes: string[] = [];
  const thread: PeerThreadEvent[] = [];
  const closedSessions: string[] = [];
  const resumable = new Map(Object.entries(options.resumable ?? {}));
  let opened = 0;
  const driver: AgentManagerDriver = {
    providerId: 'codex',
    open(spec) {
      specs.push(spec);
      opened += 1;
      const label = spec.resume ?? `new-${String(opened)}`;
      const session: AgentManagerSession = {
        readEvents: async (onEvent) => {
          await onEvent({
            type: 'session_started',
            sessionId: spec.resume ?? `thr-new-${String(opened)}`,
            runtime: { model: 'gpt' } as never,
            ...(options.transcriptLocation === undefined
              ? {}
              : { transcriptLocation: options.transcriptLocation }),
          });
          for await (const input of spec.input) {
            void input;
            await onEvent(turnEnded(`答え(${label})`));
          }
        },
        close: () => {
          closedSessions.push(label);
        },
        contextUsage: async () => {
          throw new Error('unused');
        },
        sessionModelUsage: async () => undefined,
      };
      return session;
    },
  };
  const broker = createPeerBroker({
    allowed: ['codex'],
    driverOf: () => driver,
    makeSpec: (_provider, given) =>
      ({
        input: given.input,
        onPermission: given.onPermission,
        onNote: given.onNote,
        onPostToolUse: () => ({ kind: 'continue' }),
        onPostToolUseFailure: () => undefined,
        ...(given.resume === undefined ? {} : { resume: given.resume }),
      }) as unknown as AgentManagerSessionSpec,
    reportsUsage: () => true,
    onNote: (text) => notes.push(text),
    onUsage: () => undefined,
    onThread: (event) => thread.push(event),
    resumable,
    ...(options.prepareResume === undefined ? {} : { prepareResume: options.prepareResume }),
    ...(options.maxLiveSessions === undefined
      ? {}
      : { limits: { maxLiveSessions: options.maxLiveSessions, idleMs: 3_600_000 } }),
  });
  return { broker, specs, notes, thread, closedSessions, resumable };
}

function turn(result: PeerCallResult): PeerTurnResult {
  if (typeof result === 'string') throw new Error(result);
  if ('background' in result) throw new Error('背景へ回っている');
  return result;
}

describe('peer-broker: 器の入れ替わりの後に peer を続きから起こす', () => {
  it('知らない id でも resumable に在れば、spec.resume 付きで起こして続きのターンに合流する', async () => {
    const { broker, specs, notes } = setup({
      resumable: { 'peer-aaaa': { provider: 'codex', threadId: 'thr-old-1' } },
    });
    const result = turn(await broker.reply('peer-aaaa', '続きをお願い'));
    expect(result.ok).toBe(true);
    expect(result.text).toBe('答え(thr-old-1)');
    expect(result.sessionId).toBe('peer-aaaa');
    expect(specs).toHaveLength(1);
    expect(specs[0]?.resume).toBe('thr-old-1');
    expect(
      notes.some((note) => note.includes('[peer-aaaa]') && note.includes('続きから起こした')),
    ).toBe(true);
    broker.closeAll();
  });

  it('対照: resumable に無い id は、今までどおり「無い」と断り、相手を起こさない', async () => {
    const { broker, specs } = setup({
      resumable: { 'peer-aaaa': { provider: 'codex', threadId: 'thr-old-1' } },
    });
    const result = await broker.reply('peer-zzzz', '続き');
    expect(typeof result).toBe('string');
    expect(result).toContain('peer セッションは無い');
    expect(specs).toHaveLength(0);
    broker.closeAll();
  });

  it('上限で閉じられた（retired）id も、resumable に在れば続きから起こせる', async () => {
    const { broker, specs, closedSessions } = setup({
      resumable: { 'peer-aaaa': { provider: 'codex', threadId: 'thr-old-1' } },
      maxLiveSessions: 1,
    });
    turn(await broker.reply('peer-aaaa', '1回目'));
    // 上限 1 本: 新しく頼むと、閉じてよい peer-aaaa が閉じられる
    turn(await broker.run('codex', '別件'));
    expect(closedSessions).toContain('thr-old-1');
    const again = turn(await broker.reply('peer-aaaa', '2回目'));
    expect(again.ok).toBe(true);
    expect(specs.filter((spec) => spec.resume === 'thr-old-1')).toHaveLength(2);
    broker.closeAll();
  });

  it('続きから起こした分も、担当ごとの上限 4 本の掃除を通る（いちばん長く使われていないものが閉じる）', async () => {
    const ids = ['peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5'];
    const { broker, closedSessions } = setup({
      resumable: Object.fromEntries(
        ids.map((id) => [id, { provider: 'codex' as const, threadId: `thr-${id}` }]),
      ),
      maxLiveSessions: 4,
    });
    for (const id of ids) turn(await broker.reply(id, '続き'));
    expect(broker.sessionList().map((session) => session.id)).toEqual(ids.slice(1));
    expect(closedSessions).toEqual(['thr-peer-1']);
    broker.closeAll();
  });

  it('記録を戻せなかった（prepareResume が落ちた）peer は起こさず、今までの断りを返す', async () => {
    const { broker, specs, notes } = setup({
      resumable: { 'peer-aaaa': { provider: 'codex', threadId: 'thr-old-1' } },
      prepareResume: () => Promise.reject(new Error('置けなかった')),
    });
    const result = await broker.reply('peer-aaaa', '続き');
    expect(typeof result).toBe('string');
    expect(result).toContain('peer セッションは無い');
    expect(specs).toHaveLength(0);
    expect(notes.some((note) => note.includes('続きから起こせなかった'))).toBe(true);
    broker.closeAll();
  });

  it('prepareResume は起こす直前に、その peer の id で1回呼ばれる', async () => {
    const prepared: string[] = [];
    const { broker } = setup({
      resumable: { 'peer-aaaa': { provider: 'codex', threadId: 'thr-old-1' } },
      prepareResume: (peerId) => {
        prepared.push(peerId);
        return Promise.resolve();
      },
    });
    turn(await broker.reply('peer-aaaa', '続き'));
    expect(prepared).toEqual(['peer-aaaa']);
    broker.closeAll();
  });

  it('onThread: 始まりは thread id・記録の置き場・続きかどうかを、止まりどころごとに stopped を知らせる', async () => {
    const { broker, thread } = setup({
      resumable: { 'peer-aaaa': { provider: 'codex', threadId: 'thr-old-1' } },
      transcriptLocation: '/home/c/.codex/sessions/2026/10/25/rollout-x-thr-old-1.jsonl',
    });
    turn(await broker.reply('peer-aaaa', '続き'));
    expect(thread[0]).toEqual({
      kind: 'started',
      peerId: 'peer-aaaa',
      provider: 'codex',
      threadId: 'thr-old-1',
      resumed: true,
      transcriptLocation: '/home/c/.codex/sessions/2026/10/25/rollout-x-thr-old-1.jsonl',
    });
    expect(thread.some((event) => event.kind === 'stopped' && event.peerId === 'peer-aaaa')).toBe(
      true,
    );
    broker.closeAll();
  });
});
