import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, TOOL_USE_ID_META_KEY } from './tools.js';

// self_status・progress_read・usage_read・token_list・conversation_read の固定の見出し・注記・脚注を、
// 同じ会話の2回目から短い札にする（ToolContext.foldFixed。manager_list / runner_list と同じ型）。
// journal_read の「q 当たり無し」は畳まず短縮するだけなので、1回目も2回目も同じ。
// 数・id・本文は畳まない。サブエージェントの呼びは畳まず、控えも更新しない（isSubagentCall）

const FULL_SHA = 'd'.repeat(40);
const RUNTIME = {
  revision: { commit: FULL_SHA, short: 'd'.repeat(12), source: 'platform' },
  buildTime: { builtAt: '2026-09-18T11:45:00.000Z' },
  declaredModel: 'opus',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: 'xhigh',
  requestedEffort: null,
  claudeCodeVersion: '2.1.0',
  apiKeySource: 'oauth',
  permissionMode: 'default',
  requestedPermissionMode: 'auto',
  mcpServers: [{ name: 'alteroid', status: 'connected' }],
  sessionId: 'sess-observed',
  resumedFrom: null,
  injectedMemoryChars: { chars: 120, tokens: 60, kind: 'heuristic' },
  systemPromptChars: { chars: 4000, tokens: 2000, kind: 'heuristic' },
  lastContextUsage: null,
};

const SUBAGENT_CALL_ID = 'toolu-from-subagent';

function harness(delta: DigestSessionDelta | null) {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
    workConversationId: () => 'conv-1',
    runtime: () => RUNTIME as never,
    accountUsage: () => ({ state: 'unknown' }),
    ...(delta === null
      ? {}
      : {
          foldFixed: (id: string, full: string, ref: string) => delta.fixedInTurn(id, full, ref),
          isSubagentCall: (toolUseId: string | undefined) => toolUseId === SUBAGENT_CALL_ID,
        }),
  });
  const call = async (
    tool: string,
    args: Record<string, unknown> = {},
    caller: 'main' | 'subagent' = 'main',
  ): Promise<string> => {
    const found = tools.find((entry) => entry.name === tool);
    if (!found) throw new Error(`${tool} が無い`);
    const extra = {
      _meta: { [TOOL_USE_ID_META_KEY]: caller === 'subagent' ? SUBAGENT_CALL_ID : 'toolu-main' },
    };
    const result = await found.handler(args as never, extra);
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
  return { stores, call };
}

type Seed = (h: ReturnType<typeof harness>) => Promise<void>;

interface Case {
  tool: string;
  args?: Record<string, unknown>;
  seed?: Seed;
  /** 1回目にだけ出る全文（2回目には出ない） */
  full: string[];
  /** 2回目に出る札（1回目には出ない） */
  ref: string[];
  /** 毎回出る数・id・本文 */
  always: string[];
}

const cases: Case[] = [
  {
    tool: 'self_status',
    seed: async (h) => {
      await h.stores.persona.write(
        'idx1',
        '---\ndescription: 索引\ntype: indexed\n---\n# 題\n## 節\n本文\n',
        { ifMatch: null },
      );
    },
    full: [
      '上の時刻より後に `main` へ入ったものはまだ届いていない',
      '反映間隔の実測は `gh run list',
      '蒸留のサイドクエリは別セッションなのでここには出ない',
      '毎ターン要旨だけが焼かれる',
    ],
    ref: ['先端とは限らない（理由と差の数え方は、この会話の最初の self_status の全文を見よ）'],
    always: [
      `dddddddddddd（Railway が実行時に注入、フル ${FULL_SHA}）`,
      '- 宣言されたモデル帯: opus',
      '- effort（実効値）: xhigh',
      '（1 文書）',
      '- indexed 合計:',
    ],
  },
  {
    tool: 'progress_read',
    seed: async (h) => {
      await h.call('commitment_open', { body: '約束1' });
    },
    full: [
      '積み上がり（台帳の未了）: 1 件',
      '終端時刻の欄が無いので更新時刻での近似',
      '（他と重なりうる）',
    ],
    ref: [
      '未了: 1 件',
      '（basis: updatedAt。更新時刻での近似）',
      '（重なりうる）',
      '（見出しは短縮。全文は最初の progress_read）',
    ],
    always: [
      '観測時刻:',
      '起点別: 人間 0 / マネージャー 0 / 外部 0 / 自発 1',
      '実行中 0 / 人間待ち 0 / 行方不明 0',
      '根拠: 未了 1 /',
    ],
  },
  {
    tool: 'usage_read',
    full: ['消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない'],
    ref: ['記録は機能を入れた時点から。それ以前は残っていない'],
    always: ['台帳にはまだ1件も記録が無い。', '**0 ではなく、分からない。**'],
  },
  {
    tool: 'usage_read',
    seed: async (h) => {
      await h.stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'cumulative',
        managerId: 'mgr-1',
        date: '2026-08-14',
        at: '2026-08-14T10:00:00.000Z',
        snapshot: {
          models: {
            'claude-opus-5': {
              inputTokens: 10,
              outputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 2,
            },
          },
        },
      });
    },
    full: ['SDK が返す推定値であり、Anthropic の請求明細ではない（一致しないことがある）。'],
    ref: ['推定値であり請求明細ではない。'],
    always: ['合計 $2.00', '入力 10 / 出力 100', '台帳の始点: 2026-08-14'],
  },
  {
    tool: 'token_list',
    seed: async (h) => {
      await h.stores.tokens.replace([
        { id: 'tok-a', label: '予備1', value: 'v1', order: 0 },
        { id: 'tok-b', label: '予備2', value: 'v2', order: 1 },
      ]);
    },
    full: [
      '（作成 = 行を足した時刻 / 更新 = 最後に変わった時刻。同じなら一度も変わっていない。',
      '全文は journal_read types=token_rotation の noticeText に在る',
    ],
    ref: [
      '（作成 = 足した時刻 / 更新 = 最後に変わった時刻。',
      '全文は journal_read types=token_rotation）',
    ],
    always: ['回す契機:', '- tok-a ', '- tok-b ', '予備2（order 1）'],
  },
  {
    tool: 'conversation_read',
    seed: async (h) => {
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '人間の発言',
        conversationId: 'conv-abc12345',
      } as never);
    },
    full: ['（各会話の中身は conversation_read conversationId=<id> で古い順に読める）'],
    ref: ['（中身は conversationId=<id> で読める）'],
    always: ['conv-abc12345', '人間の発言', '人間との往復を 1 件遡った。先頭に届いている'],
  },
  {
    tool: 'conversation_read',
    args: { q: '発言' },
    seed: async (h) => {
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '人間の発言',
        conversationId: 'conv-abc12345',
      } as never);
    },
    full: ['（本文は抜粋。全文は conversation_read id=<id> で取れる）'],
    ref: ['（本文は抜粋。全文は id=<id>）'],
    always: ['conv-abc12345', '人間の発言'],
  },
];

describe.each(cases)('$tool は固定の文言を、同じ会話の2回目から短い札にする', (c) => {
  const label = `${c.tool}${c.args === undefined ? '' : ` ${JSON.stringify(c.args)}`}`;

  it(`${label}: 1回目は全文・2回目は札。数・id・本文は毎回出る`, async () => {
    const h = harness(new DigestSessionDelta());
    await c.seed?.(h);

    const first = await h.call(c.tool, c.args);
    const second = await h.call(c.tool, c.args);

    for (const phrase of c.full) {
      expect(first, `1回目に全文が無い: ${phrase}`).toContain(phrase);
      expect(second, `2回目にも全文が出ている: ${phrase}`).not.toContain(phrase);
    }
    for (const phrase of c.ref) {
      expect(first, `1回目に札が出ている: ${phrase}`).not.toContain(phrase);
      expect(second, `2回目に札が無い: ${phrase}`).toContain(phrase);
    }
    for (const phrase of c.always) {
      expect(first, `1回目に無い: ${phrase}`).toContain(phrase);
      expect(second, `2回目に無い: ${phrase}`).toContain(phrase);
    }
    expect(second.length).toBeLessThan(first.length);
  });

  it(`${label}: 会話が切れたら（reset）全文へ戻る`, async () => {
    const delta = new DigestSessionDelta();
    const h = harness(delta);
    await c.seed?.(h);

    const first = await h.call(c.tool, c.args);
    await h.call(c.tool, c.args);
    delta.reset();
    const afterReset = await h.call(c.tool, c.args);

    // 観測時刻などの時刻だけは呼ぶたびに動くので揃えて比べる
    const withoutClock = (text: string): string =>
      text.replaceAll(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<時刻>');
    expect(withoutClock(afterReset)).toBe(withoutClock(first));
  });

  it(`${label}: サブエージェントの呼びは全文で、本体の控えを更新しない`, async () => {
    const h = harness(new DigestSessionDelta());
    await c.seed?.(h);

    const subFirst = await h.call(c.tool, c.args, 'subagent');
    const subSecond = await h.call(c.tool, c.args, 'subagent');
    // サブエージェントが2回呼んでも、本体の最初の呼びはまだ全文である（控えが更新されていない）
    const mainFirst = await h.call(c.tool, c.args, 'main');
    const mainSecond = await h.call(c.tool, c.args, 'main');

    for (const phrase of c.full) {
      expect(subFirst).toContain(phrase);
      expect(subSecond).toContain(phrase);
      expect(mainFirst).toContain(phrase);
      expect(mainSecond).not.toContain(phrase);
    }
    for (const phrase of c.ref) {
      expect(subFirst).not.toContain(phrase);
      expect(subSecond).not.toContain(phrase);
      expect(mainSecond).toContain(phrase);
    }
  });

  it(`${label}: 口の無い器（蒸留・テスト）は常に全文`, async () => {
    const h = harness(null);
    await c.seed?.(h);

    const first = await h.call(c.tool, c.args);
    const second = await h.call(c.tool, c.args);

    for (const phrase of c.full) {
      expect(first).toContain(phrase);
      expect(second).toContain(phrase);
    }
    for (const phrase of c.ref) expect(second).not.toContain(phrase);
  });
});

describe('self_status は同じ sha を何回も出さない', () => {
  it('フルの sha は1回だけで、差の数え方はその行を指す', async () => {
    const h = harness(null);

    const text = await h.call('self_status');

    expect(text.split(FULL_SHA)).toHaveLength(2);
    expect(text).toContain('compare/<上の「フル」の sha>...main');
  });

  it('ledgerCursor の続きの呼びは固定の注記を出さず、控えも使わない', async () => {
    const delta = new DigestSessionDelta();
    const h = harness(delta);

    // 続きの呼びは節だけを返す。ここで fold を呼ぶと、出していない全文を「出した」と控える
    await h.call('self_status', { ledgerCursor: 'x' });
    const first = await h.call('self_status');

    expect(first).toContain('上の時刻より後に `main` へ入ったものはまだ届いていない');
  });
});

describe('journal_read の q 当たり無しは畳まず、短くするだけ', () => {
  it('意味（探す対象に入っていない欄が在る）は残り、1回目も2回目も同じ文面', async () => {
    const h = harness(new DigestSessionDelta());

    const first = await h.call('journal_read', { q: 'zzz' });
    const second = await h.call('journal_read', { q: 'zzz' });

    expect(second).toBe(first);
    expect(first).toContain('"zzz" に当たる日誌は無い（この条件の中では）。');
    expect(first).toContain('tool_use の input');
    expect(first).toContain('は探す対象外で、そこにだけ書かれた語は当たらない。');
    expect(first).toContain('（日誌の先頭まで探した）');
  });
});
