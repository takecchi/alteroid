import type {
  query as sdkQuery,
  Options,
  Query,
  SDKMessage,
  SDKPermissionDenial,
  SDKPermissionDeniedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { denialInputAbsence, denialInputShape } from './denial-shape.js';
import { createManagerPool } from './manager.js';
import { codeSpan } from './markdown-span.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, runnerEventSchema } from './runner-protocol.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

function fakeManagerSdk() {
  const sessions: { options: Options; push: (message: SDKMessage) => void }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];

    sessions.push({
      options,
      push(message) {
        if (emit) emit(message);
        else buffered.push(message);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => emit?.(null),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `tool_input` は足場の都合で、実機の SDK の型 `SDKPermissionDeniedMessage` には無い。
 * 実機に忠実な形が要るテストは `liveDenialAsSdkSends` を使う。
 */
function liveDenial(tool: string, toolUseId: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    tool_use_id: toolUseId,
    tool_input: input,
    session_id: 'sess-mgr',
    uuid: `uuid-denied-${toolUseId}`,
  } as unknown as SDKMessage;
}

/** 実機の SDK が送る形（`tool_input` を持たない）。`liveDenial()` だけだと `undefined` の経路を通らない。 */
function liveDenialAsSdkSends(tool: string, toolUseId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    tool_use_id: toolUseId,
    session_id: 'sess-mgr',
    uuid: `uuid-denied-${toolUseId}`,
  } as unknown as SDKMessage;
}

/**
 * 作業者（Task subagent）の内側で拒否された形。`agent_id?: string` の doc（逐語）: [sdk-verbatim SDKPermissionDeniedMessage.agent_id]
 * Subagent ID when the denied tool call originated inside a subagent.
 */
function liveDenialFromWorker(tool: string, toolUseId: string, agentId = 'agent-1'): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    tool_use_id: toolUseId,
    agent_id: agentId,
    session_id: 'sess-mgr',
    uuid: `uuid-denied-${toolUseId}`,
  } as unknown as SDKMessage;
}

/** `tool_use_id` を持たない形。代用鍵が入力ごとに変わることを確かめるため、足場として `tool_input` を足す。 */
function liveDenialWithoutId(
  tool: string,
  input: Record<string, unknown>,
  uuidSuffix: string,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    tool_input: input,
    session_id: 'sess-mgr',
    uuid: `uuid-denied-noid-${uuidSuffix}`,
  } as unknown as SDKMessage;
}

function resultWithDenials(
  text: string,
  denials: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[],
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    permission_denials: denials,
    session_id: 'sess-mgr',
    uuid: `uuid-result-${text.length}`,
  } as unknown as SDKMessage;
}

function open(options: { now?: () => number } = {}) {
  const stores = createMemoryStores();
  const manager = fakeManagerSdk();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    ...(options.now === undefined ? {} : { now: options.now }),
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
    ]),
  });
  return { stores, manager, inbox, pool };
}

async function deniedLines(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const entries = (await stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
  return entries
    .filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('確認へ上がらずに止められた'),
    )
    .map((entry) => entry.text)
    .reverse();
}

async function noteLines(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const entries = (await stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
  return entries
    .filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('先に降ろした'),
    )
    .map((entry) => entry.text)
    .reverse();
}

describe('確認へ上がらずに止められた実行（permissionMode: auto）', () => {
  it('走行中の合図がクローンの日誌まで届く（黙って止まらない）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'web の画面を直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Edit', 'toolu_1', { file_path: 'apps/web/app/routes/chat.test.tsx' }));
    await tick();

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[${managerId}]`);
    expect(lines[0]).toContain('Edit');
    // 値は日誌へ書かない（入力に鍵が入りうる）。形（欄名と長さ）だけが残る。
    expect(lines[0]).toContain('欄=file_path');
    expect(lines[0]).toMatch(/chars=\d+/);
    expect(lines.join('\n')).not.toContain('chat.test.tsx');
    expect(lines[0]).toContain('走行中の合図');

    await s.pool.stop();
  }, 15_000);

  it('1件目で受信箱へ上げる。以後は3倍ごとで、止められ続けても受信箱を埋めない（#830）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const messages = () => s.inbox.filter((event) => event.type === 'manager_message');

    session.push(liveDenial('Edit', 'toolu_1', { file_path: 'a.tsx' }));
    await tick();
    expect(messages()).toHaveLength(1);
    const first = messages()[0];
    expect(first).toMatchObject({ managerId, kind: 'report' });
    expect(first?.text).toContain('Edit');
    expect(first?.text).toContain('1 件目');

    session.push(liveDenial('Edit', 'toolu_2', { file_path: 'b.tsx' }));
    await tick();
    expect(messages()).toHaveLength(1);

    session.push(liveDenial('Edit', 'toolu_3', { file_path: 'c.tsx' }));
    await tick();
    expect(messages()).toHaveLength(2);
    expect(messages()[1]?.text).toContain('3 件目');

    for (const id of ['toolu_4', 'toolu_5', 'toolu_6', 'toolu_7', 'toolu_8']) {
      session.push(liveDenial('Edit', id, { file_path: `${id}.tsx` }));
      await tick();
    }
    expect(messages()).toHaveLength(2);

    session.push(liveDenial('Edit', 'toolu_9', { file_path: 'i.tsx' }));
    await tick();
    expect(messages()).toHaveLength(3);
    expect(messages()[2]?.text).toContain('9 件目');

    expect(await deniedLines(s.stores)).toHaveLength(9);

    await s.pool.stop();
  }, 15_000);

  // 段を名指しする歯は刻みを 1.2 倍へ詰める改悪を通しうるので、ここでは通数 ≪ 件数だけを見る。
  it('通数は件数に比例しない（27件の拒否で上がるのは4通だけ・#50 の意図）', async () => {
    const s = open();
    await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const messages = () =>
      s.inbox.filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message' && event.text.includes('止められた'),
      );

    const DENIALS = 27;
    for (let i = 1; i <= DENIALS; i += 1) {
      session.push(liveDenial('Edit', `toolu_${i}`, { file_path: `f${i}.tsx` }));
      await tick();
    }

    expect(await deniedLines(s.stores)).toHaveLength(DENIALS);

    expect(
      messages(),
      `27 件の拒否で上がった通数が 4 でない。` +
        `刻みが詰まっていれば #50 が避けた「1 件ずつ流す」へ戻っており、` +
        `4 より少なければ #830 の「一度きりの拒否が黙る」へ戻っている。` +
        `入口（DENIED_ESCALATE_AT）と刻み（shouldEscalateDenial の 3 倍）は別の判断で、` +
        `片方だけ触ると壊れる向きが違う（manager.ts の doc）。`,
    ).toHaveLength(4);
    expect(messages().map((event) => event.text.match(/(\d+) 件目/)?.[1])).toEqual([
      '1',
      '3',
      '9',
      '27',
    ]);

    expect(messages().length).toBeLessThan(DENIALS / 6);

    await s.pool.stop();
  }, 30_000);

  it('result の記録からも届く。走行中の合図と同じ1件は二度上げない', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Bash', 'toolu_1', { command: 'git diff' }));
    await tick();

    session.push(
      resultWithDenials('終わった', [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git diff' } },
        { tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: { file_path: 'x.ts' } },
      ]),
    );
    await tick();

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Bash');
    expect(lines[1]).toContain('Write');
    expect(lines[1]).toContain('result の記録');
    expect(
      s.inbox.filter((event) => event.type === 'manager_message' && event.text === '終わった'),
    ).toHaveLength(1);

    await s.pool.stop();
  }, 15_000);

  it('同じ result が二度届いても数え直さない（累積で来ても壊れない）', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const denial = {
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: 'a.tsx' },
    };
    session.push(resultWithDenials('一度目', [denial]));
    await tick();
    session.push(resultWithDenials('二度目', [denial]));
    await tick();
    session.push(resultWithDenials('三度目', [denial]));
    await tick();

    expect(await deniedLines(s.stores)).toHaveLength(1);
    expect(
      s.inbox.filter(
        (event) => event.type === 'manager_message' && event.text.includes('止められた'),
      ),
      '同じ拒否を二度数えている。累積で届く result を素直に足すと件数が伸び、' +
        '段（1, 3, 9…）を余分に踏んで通数が増える（tool_use_id による重複排除を見ること）。',
    ).toHaveLength(1);

    await s.pool.stop();
  }, 15_000);

  it('件数を覚える蓋に当たったことを黙らない（数え直しが記録に残る）', async () => {
    const s = open();
    await s.pool.start({ request: 'いろいろやって' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    for (let i = 0; i < 65; i += 1) {
      session.push(liveDenial(`Tool${i}`, `toolu_${i}`, { i }));
      await tick();
    }

    const entries = (await s.stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
    const forgotten = entries.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('上限（64種）に達した'),
    );
    expect(forgotten).toHaveLength(1);
    expect((forgotten[0] as { text: string }).text).toContain('Tool0');
    expect(await deniedLines(s.stores)).toHaveLength(65);

    const notices = s.inbox.filter(
      (event) => event.type === 'manager_message' && event.text.includes('止められた'),
    );
    expect(
      notices,
      '道具の種類ごとに1通を超えている。蓋（DENIED_TOOL_LIMIT）か段の判定が壊れると、' +
        '同じ種類で何通も鳴って #50 が避けた「1 件ずつ流す」に戻る。',
    ).toHaveLength(65);

    await s.pool.stop();
  }, 20_000);

  it('数えた拒否を一覧から読み出せる（status は動かさない）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    expect(s.pool.denials(managerId)).toEqual([]);

    session.push(liveDenial('Edit', 'toolu_1', { file_path: 'a.tsx' }));
    await tick();
    session.push(liveDenial('Bash', 'toolu_2', { command: 'git push' }));
    await tick();
    session.push(liveDenial('Edit', 'toolu_3', { file_path: 'b.tsx' }));
    await tick();

    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Bash', count: 1, actor: 'manager', lastAt: expect.any(String) },
      { tool: 'Edit', count: 2, actor: 'manager', lastAt: expect.any(String) },
    ]);

    // 状態の値は増やさない: `stalled` を新設すると `openapi.json` の外向きの面まで動く。
    const listed = (await s.pool.list()).find((entry) => entry.managerId === managerId);
    expect(listed?.status).toBe('running');
    expect(listed).not.toHaveProperty('denials');

    await s.pool.stop();
  }, 15_000);

  it('道具×層ごとに最後に止められた時刻（lastAt）を持ち、止められるたびに進む（#1455）', async () => {
    let clock = Date.parse('2026-09-24T07:00:00.000Z');
    const s = open({ now: () => clock });
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Bash', 'toolu_1', { command: 'rm -rf /' }));
    await tick();
    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Bash', count: 1, actor: 'manager', lastAt: '2026-09-24T07:00:00.000Z' },
    ]);

    clock = Date.parse('2026-09-24T07:05:00.000Z');
    session.push(liveDenial('Bash', 'toolu_2', { command: 'git push' }));
    await tick();
    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Bash', count: 2, actor: 'manager', lastAt: '2026-09-24T07:05:00.000Z' },
    ]);

    await s.pool.stop();
  }, 15_000);

  it('runner が hello で名乗った能力を覚える（#1394 段(C)）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const runnerId = await s.pool.runnerIdOf(managerId);
    if (runnerId === undefined) throw new Error('runnerId が無い');
    expect(s.pool.runnerHasCapability?.(runnerId, 'awaiting-background-signal')).toBe(true);
    expect(s.pool.runnerHasCapability?.(runnerId, 'no-such-capability')).toBe(false);
    expect(s.pool.runnerHasCapability?.('runner-never-seen', 'awaiting-background-signal')).toBe(
      false,
    );
    await s.pool.stop();
  }, 15_000);

  it('旧い runner の hello が managerProvider / managerProviders を名乗っても落とさず、欄は捨てる（2026-10-07 の撤去）', () => {
    expect(runnerEventSchema.safeParse({ type: 'hello', runnerId: 'r-old' }).success).toBe(true);
    const parsed = runnerEventSchema.safeParse({
      type: 'hello',
      runnerId: 'r-legacy',
      managerProvider: 'codex',
      managerProviders: ['claude', 'codex'],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'managerProvider' in parsed.data).toBe(false);
    expect(parsed.success && 'managerProviders' in parsed.data).toBe(false);
  });

  it('hello の capabilities は省略できる（旧い runner の形）', () => {
    expect(runnerEventSchema.safeParse({ type: 'hello', runnerId: 'r-old' }).success).toBe(true);
    const parsed = runnerEventSchema.safeParse({
      type: 'hello',
      runnerId: 'r-new',
      capabilities: ['awaiting-background-signal'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'hello') {
      expect(parsed.data.capabilities).toEqual(['awaiting-background-signal']);
    }
  });

  it('知らない manager_id には空を返す（無いものを数えたことにしない）', () => {
    const s = open();
    expect(s.pool.denials('mgr-居ない')).toEqual([]);
  });

  it('runner から降ろす出来事が境界のスキーマを通る（HTTP 越しで落ちない）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          input: { file_path: 'a.tsx' },
          via: 'live',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it('live の拒否は `input` キーが無くても境界のスキーマを通る（実機の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          via: 'live',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it('理由・分類・拒否文の3欄が無くても境界のスキーマを通る（`via: result` の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          input: { file_path: 'a.tsx' },
          via: 'result',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it('理由・分類・拒否文の3欄が揃っていても境界のスキーマを通り、値が保たれる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          via: 'live',
          reason: 'この編集は許可されていないパスに触れている',
          reasonType: 'rule',
          message: 'Edit was denied by a deny rule',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'permission_denied') {
      expect(parsed.data.reason).toBe('この編集は許可されていないパスに触れている');
      expect(parsed.data.reasonType).toBe('rule');
      expect(parsed.data.message).toBe('Edit was denied by a deny rule');
    }
  });

  // 同一プロセスで JSON 境界を越えないので、境界の回帰は `apps/daemon/src/permission-denied.test.ts` が持つ。
  it('`tool_input` を持たない走行中の合図でも、拒否がクローンの日誌まで届く', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'web の画面を直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Edit', 'toolu_1'));
    await tick();

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[${managerId}]`);
    expect(lines[0]).toContain('Edit');
    expect(lines[0]).toContain('走行中の合図');

    await s.pool.stop();
  }, 15_000);

  // 両方を1つのテストで固定する: 片方だけだと、包みを共通化して日誌まで巻き込む実装が通る。
  it('受信箱の本文では入力の形がコードスパンで包まれ、日誌の行では包まれない', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const input = { command: 'echo `date`' };
    for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) {
      session.push(liveDenial('Bash', id, input));
      await tick();
    }

    const message = s.inbox.filter((event) => event.type === 'manager_message')[0];
    expect(message).toMatchObject({ managerId, kind: 'report' });
    const text = message?.type === 'manager_message' ? message.text : '';

    const shape = denialInputShape(input);
    expect(shape).toBeDefined();
    expect(text).toContain(codeSpan(shape as string));
    expect(text).not.toContain('echo `date`');
    expect(text).toContain('`Bash` の実行が');
    expect(text).toContain('（`journal_read` で辿れる）');

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`: ${shape}`);
    expect(lines[0]).not.toContain('``');
    expect(lines[0]).not.toContain('echo `date`');

    await s.pool.stop();
  }, 15_000);

  it('拒否の出所を断定せず、2つの場合分けと「まず担い手の拒否文を読ませる」案内が載る（#1267）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Bash', 'toolu_1267', { command: 'echo hi' }));
    await tick();

    const message = s.inbox.filter((event) => event.type === 'manager_message')[0];
    expect(message).toMatchObject({ managerId, kind: 'report' });
    const text = message?.type === 'manager_message' ? message.text : '';

    expect(text).not.toContain('モデル分類器か deny 規則がその場で拒否しているので');

    expect(text).toContain(
      '器のモデル分類器か deny 規則がその場で拒否したのであれば、この確認はクローンには回ってきていない',
    );
    expect(text).toContain('`PreToolUse`');
    expect(text).toContain('`bash-wait-guard.ts`');
    expect(text).toContain('自力で抜けられることがある');

    const guidanceAt = text.indexOf('担い手自身に返っている拒否の理由文を読ませること');
    const branchAAt = text.indexOf('器のモデル分類器か deny 規則が');
    expect(guidanceAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeLessThan(branchAAt);

    await s.pool.stop();
  }, 15_000);

  it('「先頭の語」が載る回にだけ、それが原因ではないという断り書きが添えられる（#1267）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Bash', 'toolu_head_1', { command: 'cd /tmp && echo hi' }));
    await tick();
    const withHeadWord = s.inbox.filter((event) => event.type === 'manager_message')[0];
    expect(withHeadWord).toMatchObject({ managerId, kind: 'report' });
    const textWithHeadWord = withHeadWord?.type === 'manager_message' ? withHeadWord.text : '';
    expect(textWithHeadWord).toContain('先頭の語=cd');
    expect(textWithHeadWord).toContain(
      '「先頭の語」は入力コマンドの先頭の単語であって、拒否の原因ではない',
    );

    await s.pool.stop();
  }, 15_000);

  it('「先頭の語」が載らない回には、断り書きも載らない（雑音にしない・#1267）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Edit', 'toolu_no_head', { file_path: 'a.tsx' }));
    await tick();
    const noHeadWord = s.inbox.filter((event) => event.type === 'manager_message')[0];
    expect(noHeadWord).toMatchObject({ managerId, kind: 'report' });
    const textNoHeadWord = noHeadWord?.type === 'manager_message' ? noHeadWord.text : '';
    expect(textNoHeadWord).not.toContain('先頭の語');
    expect(textNoHeadWord).not.toContain('拒否の原因ではない');

    await s.pool.stop();
  }, 15_000);
});

describe('inputHead — escalation にだけ乗り、journal には乗らない（issue #1105）', () => {
  async function firePreToolUse(
    session: { options: Options },
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const hook = session.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
    return hook(input as never, undefined, { signal: new AbortController().signal });
  }

  it('escalation の本文には inputHead が codeSpan で乗り、日誌には乗らない', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    await firePreToolUse(session, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'toolu_ih1',
      tool_name: 'Bash',
      tool_input: { command: 'sed -i 1s/.../ 538-comment.md' },
    });
    session.push(liveDenialAsSdkSends('Bash', 'toolu_ih1'));
    await tick();

    const message = s.inbox.filter((event) => event.type === 'manager_message')[0];
    expect(message).toMatchObject({ managerId, kind: 'report' });
    const text = message?.type === 'manager_message' ? message.text : '';

    expect(text).toContain(codeSpan('sed -i 1s/.../ 538-comment.md'));
    expect(text).toContain('拒否より前に見た入力の先頭');
    expect(text).toContain('この拒否の合図自体が運んだ値ではなく');

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('sed -i');
    expect(lines[0]).not.toContain('538-comment.md');
    expect(lines[0]).not.toContain('拒否より前に見た入力の先頭');

    await s.pool.stop();
  }, 15_000);

  it('escalation の本文は答え方（requestId が無い・decision を付けない・マネージャーに中継させる）を言う', async () => {
    const s = open();
    await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Bash', 'toolu_route1'));
    await tick();

    const message = s.inbox.filter((event) => event.type === 'manager_message')[0];
    const text = message?.type === 'manager_message' ? message.text : '';

    // 2026-10-10（#4447）: 以前は「答え方: この拒否には `requestId` が無く、許可として答える口は無い。」と言い切っていた。
    // 1回だけの許可（#1105 P1）で、分類器の拒否には `toolu_…` の確認が別に上がるようになったので、その確認へ答える道を先に言い、
    // 「答える口は無い」は確認が届かなかったときに限って言う形へ直した。
    expect(text).toContain(
      '答え方: この拒否について「この1回だけ許可しますか」の確認（`requestId` は `toolu_…` の形）が別に届いていれば、',
    );
    expect(text).toContain('（allow しても自動では撃ち直されない）');
    expect(text).toContain(
      'その確認が届いていなければ、この拒否には `requestId` が無く、許可として答える口は無い。',
    );
    expect(text).toContain('`manager_send` に `decision` を付けて送らないこと');
    expect(text).toContain('別に待っている確認へ回答として当たりうる');
    expect(text).toContain('その作業者へ伝えるようマネージャーに頼む');
    const lines = await deniedLines(s.stores);
    expect(lines[0]).not.toContain('答え方');

    await s.pool.stop();
  }, 15_000);

  it('PreToolUse を経由しなかった回は、従来どおり「形」だけの案内のまま（作り物を足さない）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'ビルドを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Bash', 'toolu_ih2'));
    await tick();

    const message = s.inbox.filter((event) => event.type === 'manager_message')[0];
    expect(message).toMatchObject({ managerId, kind: 'report' });
    const text = message?.type === 'manager_message' ? message.text : '';

    expect(text).not.toContain('拒否より前に見た入力の先頭');
    expect(text).toContain('入力は付いていない');

    await s.pool.stop();
  }, 15_000);
});

describe('層の判定（Issue #373）', () => {
  it('via: live + agent_id 在り → 作業者として数える', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialFromWorker('Edit', 'toolu_w1'));
    await tick();

    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Edit', count: 1, actor: 'worker', lastAt: expect.any(String) },
    ]);

    await s.pool.stop();
  }, 15_000);

  it('via: live + agent_id 無し → マネージャー自身として数える', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Edit', 'toolu_m1', { file_path: 'a.tsx' }));
    await tick();

    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Edit', count: 1, actor: 'manager', lastAt: expect.any(String) },
    ]);

    await s.pool.stop();
  }, 15_000);

  it('via: result → 層は取れない（マネージャー側へ黙って寄せない）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(
      resultWithDenials('終わった', [
        { tool_name: 'Write', tool_use_id: 'toolu_r1', tool_input: { file_path: 'x.ts' } },
      ]),
    );
    await tick();

    // `toEqual` は欠けている欄と `undefined` を区別しないので、`not.toHaveProperty` でも確かめる。
    const denials = s.pool.denials(managerId);
    expect(denials).toEqual([{ tool: 'Write', count: 1, lastAt: expect.any(String) }]);
    expect(denials[0]).not.toHaveProperty('actor');

    await s.pool.stop();
  }, 15_000);

  it('同じ道具でもマネージャー自身と作業者は別枠で数える（畳まれない）', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Edit', 'toolu_1', { file_path: 'a.tsx' }));
    await tick();
    session.push(liveDenialFromWorker('Edit', 'toolu_2'));
    await tick();
    session.push(liveDenialFromWorker('Edit', 'toolu_3', 'agent-2'));
    await tick();

    const denials = s.pool.denials(managerId);
    expect(denials).toContainEqual({
      tool: 'Edit',
      count: 1,
      actor: 'manager',
      lastAt: expect.any(String),
    });
    expect(denials).toContainEqual({
      tool: 'Edit',
      count: 2,
      actor: 'worker',
      lastAt: expect.any(String),
    });

    await s.pool.stop();
  }, 15_000);

  it('境界のスキーマは `actor` が無くても通る（旧い runner・result 経由の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          via: 'result',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'permission_denied') {
      expect(parsed.data.actor).toBeUndefined();
    }
  });

  it('境界のスキーマは `actor` が在れば値を保つ（`worker:<id>:<agent>` の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          via: 'live',
          actor: 'worker:mgr-1:worker',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'permission_denied') {
      expect(parsed.data.actor).toBe('worker:mgr-1:worker');
    }
  });
});

describe('live / result の到着順（denial-shape.ts 導入）', () => {
  it('R1: live（入力なし）→ result（入力あり、同じ id）は、拒否の行を増やさず note を1本足す', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Bash', 'toolu_1'));
    await tick();
    expect(await deniedLines(s.stores)).toHaveLength(1);
    expect(await noteLines(s.stores)).toHaveLength(0);

    session.push(
      resultWithDenials('終わった', [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git diff' } },
      ]),
    );
    await tick();

    expect(await deniedLines(s.stores)).toHaveLength(1);

    const notes = await noteLines(s.stores);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Bash');
    expect(notes[0]).toContain(denialInputShape({ command: 'git diff' }) as string);

    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Bash', count: 1, actor: 'manager', lastAt: expect.any(String) },
    ]);

    await s.pool.stop();
  }, 15_000);

  it('R2: result（入力あり）→ live（同じ id）は、拒否の行が1本のまま形を持ち、note は出ない', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(
      resultWithDenials('終わった', [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git diff' } },
      ]),
    );
    await tick();

    const linesAfterResult = await deniedLines(s.stores);
    expect(linesAfterResult).toHaveLength(1);
    expect(linesAfterResult[0]).toContain(denialInputShape({ command: 'git diff' }) as string);

    session.push(liveDenialAsSdkSends('Bash', 'toolu_1'));
    await tick();

    expect(await deniedLines(s.stores)).toHaveLength(1);
    expect(await noteLines(s.stores)).toHaveLength(0);

    await s.pool.stop();
  }, 15_000);

  it('R3: live だけで result が来ないと、拒否の行に「入力が無い理由」の一文が載る（空文字にならない）', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Bash', 'toolu_1'));
    await tick();

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(denialInputAbsence('live'));
    expect(lines[0]).not.toMatch(/:\s*$/);

    expect(await noteLines(s.stores)).toHaveLength(0);

    await s.pool.stop();
  }, 15_000);

  it('R4: result だけの拒否は、拒否の行に形が載る', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(
      resultWithDenials('終わった', [
        { tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: 'x.ts' } },
      ]),
    );
    await tick();

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(denialInputShape({ file_path: 'x.ts' }) as string);

    await s.pool.stop();
  }, 15_000);

  it('R5: live → result → result（同じ入力が累積で2回）でも、note は1本だけ', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Bash', 'toolu_1'));
    await tick();

    const denial = {
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: { command: 'git diff' },
    };
    session.push(resultWithDenials('一度目', [denial]));
    await tick();
    session.push(resultWithDenials('二度目', [denial]));
    await tick();

    expect(await deniedLines(s.stores)).toHaveLength(1);
    expect(await noteLines(s.stores)).toHaveLength(1);

    await s.pool.stop();
  }, 15_000);

  it('R6: live → live（同じ id）は、行が1本のまま', async () => {
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialAsSdkSends('Bash', 'toolu_1'));
    await tick();
    session.push(liveDenialAsSdkSends('Bash', 'toolu_1'));
    await tick();

    expect(await deniedLines(s.stores)).toHaveLength(1);
    expect(await noteLines(s.stores)).toHaveLength(0);

    await s.pool.stop();
  }, 15_000);

  it('R7: id 無しの拒否が上限を超えて忘れられても、忘れた一覧の note にコマンド本文が出ない', async () => {
    const s = open();
    await s.pool.start({ request: 'いろいろやって' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const DENIED_MEMORY_LIMIT = 512;
    // `await tick()` を挟む: 挟まずに詰めると `push()` の二度目の resolve が無視され、後続が静かに失われる。
    for (let i = 0; i < DENIED_MEMORY_LIMIT + 1; i += 1) {
      session.push(liveDenialWithoutId('Bash', { command: `echo secret-body-${i}` }, String(i)));
      await tick();
    }

    const entries = (await s.stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
    const forgotten = entries.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.text.includes(`上へ降ろした拒否の記憶が上限（${DENIED_MEMORY_LIMIT}件）に達した`),
    );
    if (forgotten === undefined || forgotten.type !== 'exchange') {
      throw new Error('忘れた一覧の note が見つからない');
    }

    expect(forgotten.text).toMatch(/Bash:[0-9a-f]{16}/);
    expect(forgotten.text).not.toContain('secret-body');

    const allText = entries
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''))
      .join('\n');
    expect(allText).not.toContain('secret-body');
    expect(allText).toContain('先頭の語=echo');

    await s.pool.stop();
  }, 60_000);

  it('R8: 秘密が入った拒否も、日誌と報告のどこにも値が漏れない', async () => {
    const s = open();
    await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const secretInput = {
      command: 'TOKEN=ghp_XXXXXXXXXXXX curl "https://api.example.com/?token=s3cr3t"',
    };

    session.push(liveDenial('Bash', 'toolu_dummy1', { command: 'echo one' }));
    await tick();
    session.push(liveDenial('Bash', 'toolu_dummy2', { command: 'echo two' }));
    await tick();

    session.push(liveDenialAsSdkSends('Bash', 'toolu_secret'));
    await tick();
    session.push(
      resultWithDenials('終わった', [
        { tool_name: 'Bash', tool_use_id: 'toolu_secret', tool_input: secretInput },
      ]),
    );
    await tick();

    const journalEntries = (await s.stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
    const journalText = journalEntries
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''))
      .join('\n');
    const reportText = s.inbox
      .filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message',
      )
      .map((event) => event.text)
      .join('\n');
    const combined = `${journalText}\n${reportText}`;

    expect(combined).not.toContain('ghp_XXXXXXXXXXXX');
    expect(combined).not.toContain('s3cr3t');
    expect(combined).not.toContain('TOKEN=');

    expect(combined).toContain('欄=command');

    await s.pool.stop();
  }, 15_000);

  it('R9: live→result を繰り返しても escalation の段は変わらない（note は件数に効かない）', async () => {
    const s = open();
    await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // `pushPair` はターン完了も `manager_message` として送るので、escalation だけに絞る。
    const messages = () =>
      s.inbox.filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message' && event.text.includes('止められた'),
      );

    const pushPair = async (id: string, input: Record<string, unknown>) => {
      session.push(liveDenialAsSdkSends('Edit', id));
      await tick();
      session.push(
        resultWithDenials('経過', [{ tool_name: 'Edit', tool_use_id: id, tool_input: input }]),
      );
      await tick();
    };

    await pushPair('toolu_1', { file_path: 'a.tsx' });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain('1 件目');

    await pushPair('toolu_2', { file_path: 'b.tsx' });
    expect(messages()).toHaveLength(1);

    await pushPair('toolu_3', { file_path: 'c.tsx' });
    expect(messages()).toHaveLength(2);
    expect(messages()[1]?.text).toContain('3 件目');

    for (const id of ['toolu_4', 'toolu_5', 'toolu_6', 'toolu_7', 'toolu_8']) {
      await pushPair(id, { file_path: `${id}.tsx` });
    }
    expect(messages()).toHaveLength(2);

    await pushPair('toolu_9', { file_path: 'i.tsx' });
    expect(messages()).toHaveLength(3);
    expect(messages()[2]?.text).toContain('9 件目');

    expect(await deniedLines(s.stores)).toHaveLength(9);
    expect(await noteLines(s.stores)).toHaveLength(9);

    await s.pool.stop();
  }, 15_000);
});

/**
 * 代用鍵は live と result で必ず食い違い、踏まれると重複排除が効かず escalation の段が飛ぶ。
 * いま踏まれないのは SDK の型が `tool_use_id` を必須にしているからだけなので、前提を型へ当てる。
 *
 * 鍵のほうを直さない: id が無い回に共有する識別子は道具名しか残らず、束ねると「2度目」と
 * 「live を見逃した初出」が潰れる。SDK 自身がその両方が起きうると書いている:
 *
 * 「Best-effort advisory: in rare races a denial can book without a frame or a frame can lack a booking twin — result.permission_denials is the authoritative record.」 [sdk-verbatim SDKPermissionDeniedMessage]
 *
 * `@ts-expect-error` 形にしない: 欄が丸ごと消えた回は別のエラーにすり替わって抑制が効いたまま緑で通る
 * （実測）。`HasRequiredKey` は「無い」も「任意」も `false` に落とすので、どちらでも赤くなる。
 * 実機で `result.permission_denials` が載るかは見ていない（見ているのは同梱の型定義だけ）。
 */
type HasRequiredKey<T, K extends PropertyKey> = K extends keyof T
  ? undefined extends T[K]
    ? false
    : true
  : false;

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

describe('SDK の型の前提（腐ったら typecheck が落ちる）', () => {
  it('result の記録（SDKPermissionDenial）は tool_use_id を必須で持つ', () => {
    const required: HasRequiredKey<SDKPermissionDenial, 'tool_use_id'> = true;
    expect(required).toBe(true);
  });

  it('走行中の合図（SDKPermissionDeniedMessage）は tool_use_id を必須で持つ', () => {
    const required: HasRequiredKey<SDKPermissionDeniedMessage, 'tool_use_id'> = true;
    expect(required).toBe(true);
  });

  it('走行中の合図は tool_input の欄を持たない（denialInputAbsence の根拠）', () => {
    // `denialInputAbsence('live')` が「入力の欄が無い」と言い切っているので、SDK が欄を持ったら嘘になる。
    const present: HasKey<SDKPermissionDeniedMessage, 'tool_input'> = false;
    expect(present).toBe(false);
  });

  it('走行中の合図は agent_type の欄を持たない（作業者の種類名を出さない根拠）', () => {
    // `clone.ts` / `runner.ts` が `agent_type` の不在を前提に倒れ先へ倒している。
    // 不在には `check:sdk-quotes` が当てる文言が無いので、ここでしか守れない。
    const present: HasKey<SDKPermissionDeniedMessage, 'agent_type'> = false;
    expect(present).toBe(false);
  });
});
