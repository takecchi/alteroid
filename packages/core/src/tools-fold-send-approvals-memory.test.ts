import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import type { ManagerPool } from './manager.js';
import { heuristicChars } from './quantity.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, TOOL_USE_ID_META_KEY } from './tools.js';

// manager_send・approvals_list・memory_append の固定の見出し・注記・脚注を、同じ会話の2回目から短い札にする
// （ToolContext.foldFixed。manager_list / runner_list / #5445 の道具と同じ型）。
// 数・id・本文・質問・消えた見出しの名指しは畳まない。サブエージェントの呼びは畳まず、控えも更新しない（isSubagentCall）

const SUBAGENT_CALL_ID = 'toolu-from-subagent';

function harness(delta: DigestSessionDelta | null) {
  const stores = createMemoryStores();
  const managers = {
    send: async () => ({ outcome: 'delivered', detail: '追加指示として届けた。' }),
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
    workConversationId: () => 'conv-1',
    managers,
    runtime: () => ({ injectedMemoryChars: heuristicChars(100) }) as never,
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
  name: string;
  tool: string;
  args: Record<string, unknown>;
  seed?: Seed;
  /** 1回目にだけ出る全文（2回目には出ない） */
  full: string[];
  /** 2回目に出る札（1回目には出ない）。結論を1句残していることを見る */
  ref: string[];
  /** 毎回出る数・id・本文 */
  always: string[];
}

const pendingApproval = (id: string, createdAt: string, question: string) => ({
  id,
  createdAt,
  question,
});

const cases: Case[] = [
  {
    name: 'manager_send（届けた）',
    tool: 'manager_send',
    args: { managerId: 'mgr-1', message: '続きを' },
    full: [
      '（「届けた」は resume の口が成功を返したところまで。読んだかは manager_report で見る。',
    ],
    ref: ['（届けたのは resume の口まで。同じ本文で新しい委譲を立てないこと）'],
    // 札にも「同じ本文で新しい委譲を立てない」の結論を残す（安全上の断り）
    always: ['[mgr-1] 追加指示として届けた。', '同じ本文で新しい委譲を立てないこと）'],
  },
  {
    name: 'approvals_list（全件の詳細が入る）',
    tool: 'approvals_list',
    args: {},
    seed: async (h) => {
      await h.stores.jobs.putApproval(
        pendingApproval('ap-1', '2026-01-01T00:00:00.000Z', '本番に出してよいか'),
      );
      await h.stores.jobs.putApproval(
        pendingApproval('ap-2', '2026-01-02T00:00:00.000Z', '予算を増やしてよいか'),
      );
    },
    full: [
      '（質問は抜粋。全文は approvals_list id=<id> で取れる。答えが付いた件・取り下げた件も id で開けて',
      '（並び順: 作成時刻の昇順。同じ作成時刻なら id の昇順で全順序にしてある。保存先の実装には依存しない）',
    ],
    ref: ['（質問は抜粋。全文は id=<id> で取れる）', '（並び: 作成時刻の昇順、同着は id の昇順）'],
    always: [
      '- ap-1 本番に出してよいか',
      '- ap-2 予算を増やしてよいか',
      '作成: 2026-01-01T00:00:00.000Z',
    ],
  },
  {
    name: 'approvals_list（索引つき。詳細が予算に入りきらない）',
    tool: 'approvals_list',
    args: {},
    seed: async (h) => {
      for (let index = 0; index < 60; index += 1) {
        await h.stores.jobs.putApproval(
          pendingApproval(
            `ap-${String(index).padStart(3, '0')}`,
            `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
            `質問${String(index)} ${'あ'.repeat(190)}`,
          ),
        );
      }
    },
    full: [
      '（質問は抜粋。全文は approvals_list id=<id> で取れる。答えが付いた件・取り下げた件も id で開けて',
      '（索引の並び: 作成時刻の昇順。同じ作成時刻なら id の昇順。詳細はその逆順。保存先の実装には依存しない）',
    ],
    ref: [
      '（質問は抜粋。全文は id=<id> で取れる）',
      '（索引は作成時刻の昇順、同着は id の昇順。詳細はその逆順）',
    ],
    always: ['回答待ちは 60 件ある。', '・ap-059（', '詳細（新しい順）:'],
  },
  {
    name: 'memory_append',
    tool: 'memory_append',
    args: { slug: 'notes', content: '追記の本文\n', summary: '追記' },
    seed: async (h) => {
      await h.stores.persona.write('notes', '---\ndescription: 要旨\ntype: indexed\n---\n# 題\n', {
        ifMatch: null,
      });
    },
    full: [
      '毎ターンの床（焼き込み全体。いま読み直した値）: ',
      '⚠️ 予測であって実測ではない（他に何も変わらなければ。単純に合算しないこと）。',
      '次に組み立て直されたら焼かれる量（セッション構築時点との差）',
    ],
    ref: ['毎ターンの床: ', '⚠️ 予測であって実測ではない。', '焼かれる量（構築時点との差）'],
    always: ['記憶 notes に追記した。', '消えた見出し: なし。', '文字（'],
  },
];

describe.each(cases)('$name は固定の文言を、同じ会話の2回目から短い札にする', (c) => {
  it('1回目は全文・2回目は札。数・id・本文は毎回出る', async () => {
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
    // 札が元より長くならない（畳みで増えた所は畳まない）
    expect(second.length).toBeLessThan(first.length);
  });

  it('会話が切れたら（reset）全文へ戻る', async () => {
    const delta = new DigestSessionDelta();
    const h = harness(delta);
    await c.seed?.(h);

    await h.call(c.tool, c.args);
    await h.call(c.tool, c.args);
    delta.reset();
    const afterReset = await h.call(c.tool, c.args);

    for (const phrase of c.full)
      expect(afterReset, `reset 後に全文が無い: ${phrase}`).toContain(phrase);
    for (const phrase of c.ref) expect(afterReset).not.toContain(phrase);
  });

  it('サブエージェントの呼びは全文で、本体の控えを更新しない', async () => {
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

  it('foldFixed の口が無い器（蒸留・テスト）は常に全文', async () => {
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

describe('memory_append: 数は畳まない', () => {
  it('2回目でも床の文字数の遷移は数で出る（札になるのは見出しの固定語句だけ）', async () => {
    const h = harness(new DigestSessionDelta());
    await h.stores.persona.write('notes', '---\ndescription: 要旨\ntype: indexed\n---\n# 題\n', {
      ifMatch: null,
    });
    await h.call('memory_append', { slug: 'notes', content: '1回目\n', summary: 's' });
    const second = await h.call('memory_append', {
      slug: 'notes',
      content: '2回目\n',
      summary: 's',
    });

    expect(second).toContain('毎ターンの床: ');
    expect(second).toMatch(/\d+ 文字から \d+ 文字へ/);
  });
});

describe('manager_send: 失敗・保留の応答は畳まない', () => {
  it('脚注は届いた回だけの固定文で、保留（held）の応答には付かず、控えも使わない', async () => {
    const delta = new DigestSessionDelta();
    const stores = createMemoryStores();
    const outcomes = ['held', 'delivered'] as const;
    let index = 0;
    const managers = {
      send: async () => ({ outcome: outcomes[index++], detail: 'detail' }),
    } as unknown as ManagerPool;
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => 'conv-1',
      managers,
      foldFixed: (id: string, full: string, ref: string) => delta.fixedInTurn(id, full, ref),
    });
    const send = tools.find((entry) => entry.name === 'manager_send')!;
    const run = async (): Promise<string> =>
      ((await send.handler({ managerId: 'mgr-1', message: 'm' } as never, {})).content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');

    const held = await run();
    const delivered = await run();

    expect(held).not.toContain('resume の口');
    // 保留の回は脚注を出していないので、控えず、届いた最初の回は全文
    expect(delivered).toContain('（「届けた」は resume の口が成功を返したところまで。');
  });
});
