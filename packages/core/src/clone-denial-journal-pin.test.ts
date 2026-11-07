import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { setup, waitForDone } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import { createMemoryStores, humanMessage } from './testing.js';
import type { Stores } from './store.js';

/**
 * 拒否の記録（C1。`clone.ts` の `#noteDenial`・`#noteGrantFunneled`・`#onSubagentStop` と、`onForget` の2本）を協力者へ切り出す前に置いた固定。今の作りの出力で通る。
 * 期待の文字列は仕様を先に書いたものではなく、今の作りの出力を生成して目で読んで確かめたものを写した
 * （既存の `clone-core-loop.test.ts` は `includes` と件数が中心。ここは全文・注意書きの「初回だけ」・重複排除・上限の `onForget` を足す）。
 * 切り出しの前後でこの試験を変えない。
 */

const GRANT = {
  id: 'grant-1',
  rule: 'Bash(gh release edit:*)',
  allows: ['gh release edit'],
  denies: ['gh release edit; rm -rf /'],
  approvalId: 'ap-1',
  answer: '許可します',
  grantedAt: '2026-01-01T00:00:00.000Z',
  route: { principalKind: 'account' as const, accountId: 'acc-1' },
};

// この試験が見る日誌の行（拒否の記録が書く3種と、`onForget` の2本）。他のターンの行は混ぜない
const DENIAL_LINE_MARKS = [
  '確認へ上がらずに止められた',
  'ターン終わりの記録（合図の出所: result）に',
  'PreToolUse が allow を返した',
  '記憶が上限',
];

async function denialLines(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['self'] });
  // `journal.list` は新しい順で返すので、書いた順に直す
  return rows
    .map((row) => (row.type === 'exchange' ? row.text : ''))
    .filter((text) => DENIAL_LINE_MARKS.some((mark) => text.includes(mark)))
    .reverse();
}

const live = (fields: Record<string, unknown>): SDKMessage =>
  ({ type: 'system', subtype: 'permission_denied', ...fields }) as unknown as SDKMessage;

function hooksOf(s: Setup) {
  const options = (s.calls[0] as FakeCall).options;
  const preToolUse = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  const postToolUse = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  const postToolUseFailure = options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
  const subagentStop = options.hooks?.SubagentStop?.[0]?.hooks?.[0];
  if (preToolUse === undefined) throw new Error('PreToolUse フックが登録されていない');
  if (postToolUse === undefined) throw new Error('PostToolUse フックが登録されていない');
  if (postToolUseFailure === undefined)
    throw new Error('PostToolUseFailure フックが登録されていない');
  if (subagentStop === undefined) throw new Error('SubagentStop フックが登録されていない');
  return { preToolUse, postToolUse, postToolUseFailure, subagentStop };
}

type Hooks = ReturnType<typeof hooksOf>;

const allow = (
  hooks: Hooks,
  toolUseId: string,
  agentId?: string,
  command = 'gh release edit --draft',
) =>
  hooks.preToolUse(
    {
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: toolUseId,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    } as never,
    undefined,
    {} as never,
  );

const stop = (hooks: Hooks, agentId?: string) =>
  hooks.subagentStop(
    (agentId === undefined ? {} : { agent_id: agentId }) as never,
    undefined,
    {} as never,
  );

/** 1ターン目で開いて hook を取り出し、`secondTurn` の分だけ2ターン目へ合図を足す */
async function openWithGrant(options: {
  secondTurnLive?: SDKMessage[];
  secondTurnDenials?: unknown[];
}) {
  let turns = 0;
  let denialCalls = 0;
  const s = setup(undefined, createMemoryStores(), {
    beforeAssistant: () => {
      turns += 1;
      return turns === 2 ? (options.secondTurnLive ?? []) : [];
    },
    permissionDenials: () => {
      denialCalls += 1;
      return denialCalls === 2 ? options.secondTurnDenials : undefined;
    },
  });
  await s.stores.permissionGrants.put(GRANT);
  s.clone.post(humanMessage('やあ'));
  await waitForDone(s.events);
  return { s, hooks: hooksOf(s) };
}

async function secondTurn(s: Setup): Promise<void> {
  s.events.length = 0;
  s.clone.post(humanMessage('two'));
  await waitForDone(s.events);
}

describe('クローン — 拒否の日誌の行（#noteDenial。全文）', () => {
  it('live（本体・理由つき）→ result（同じ id・入力つき）: 拒否の本体の行と「入力が載っていた」の行の2本（全文）', async () => {
    const id = 'tu-d1';
    const { s } = await openWithGrant({
      secondTurnLive: [
        live({
          tool_name: 'Bash',
          tool_use_id: id,
          decision_reason: '分類器が止めた',
          decision_reason_type: 'classifier',
          message: 'Bash is not allowed right now',
        }),
      ],
      secondTurnDenials: [
        { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'git push origin main' } },
      ],
    });
    await secondTurn(s);
    await s.clone.stop();

    expect(await denialLines(s.stores)).toEqual([
      '[判断] Bash の実行が、確認へ上がらずに止められた（分類: classifier / 理由: 分類器が止めた / モデルへの拒否文: Bash is not allowed right now）。止められたのは クローン本体 の手（合図の出所: live）。入力の形: 入力は付いていない（走行中の合図には入力の欄が無い。ターン終わりの記録が届けば、続く note に形だけ残る）。許可モードは auto で、この層に確認を回す相手は居ない。',
      '[判断] 先に書いた Bash の拒否について、ターン終わりの記録（合図の出所: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 欄=command / 先頭の語=git / chars=34',
    ]);
  });

  it('live（作業者・agent_type 無し）と、id 無しの result だけの拒否（道具名・入力の欠落）の行（全文）', async () => {
    const { s } = await openWithGrant({
      secondTurnLive: [live({ tool_name: 'Write', tool_use_id: 'tu-d2', agent_id: 'agent-9' })],
      secondTurnDenials: [{ tool_name: 'Edit', tool_input: { file_path: '/a' } }, {}],
    });
    await secondTurn(s);
    await s.clone.stop();

    expect(await denialLines(s.stores)).toEqual([
      '[判断] Write の実行が、確認へ上がらずに止められた。止められたのは 作業者（(不明)） の手（合図の出所: live）。入力の形: 入力は付いていない（走行中の合図には入力の欄が無い。ターン終わりの記録が届けば、続く note に形だけ残る）。許可モードは auto で、この層に確認を回す相手は居ない。',
      '[判断] Edit の実行が、確認へ上がらずに止められた。止められたのは どちらの層か不明 の手（合図の出所: result）。入力の形: 欄=file_path / chars=18。許可モードは auto で、この層に確認を回す相手は居ない。',
      '[判断] (不明な道具) の実行が、確認へ上がらずに止められた。止められたのは どちらの層か不明 の手（合図の出所: result）。入力の形: 入力は付いていない（result の記録に入力の欄が無かった）。許可モードは auto で、この層に確認を回す相手は居ない。',
    ]);
  });
});

describe('クローン — 拒否の重複排除（同じ tool_use_id は日誌に1回）', () => {
  it('live が2回・result が1回（どれも入力無し）届いても、拒否の行は1本で追記の行も出ない（全文）', async () => {
    const bare = { tool_name: 'Bash', tool_use_id: 'tu-dup-1' };
    const { s } = await openWithGrant({
      secondTurnLive: [live(bare), live(bare)],
      secondTurnDenials: [bare],
    });
    await secondTurn(s);
    await s.clone.stop();

    expect(await denialLines(s.stores)).toEqual([
      '[判断] Bash の実行が、確認へ上がらずに止められた。止められたのは クローン本体 の手（合図の出所: live）。入力の形: 入力は付いていない（走行中の合図には入力の欄が無い。ターン終わりの記録が届けば、続く note に形だけ残る）。許可モードは auto で、この層に確認を回す相手は居ない。',
    ]);
  });

  it('入力つきで先に書いた拒否へ、入力つきの result が届いても追記の行は出ない（入力は一度だけ足す）', async () => {
    const withInput = {
      tool_name: 'Bash',
      tool_use_id: 'tu-dup-2',
      tool_input: { command: 'rm -rf /tmp/x' },
    };
    const { s } = await openWithGrant({
      secondTurnDenials: [withInput, withInput],
    });
    await secondTurn(s);
    await s.clone.stop();

    expect(await denialLines(s.stores)).toEqual([
      '[判断] Bash の実行が、確認へ上がらずに止められた。止められたのは どちらの層か不明 の手（合図の出所: result）。入力の形: 欄=command / 先頭の語=rm / chars=27。許可モードは auto で、この層に確認を回す相手は居ない。',
    ]);
  });
});

describe('クローン — 許可 DB に一致して allow した呼び出しの拒否（#noteGrantFunneled。全文）', () => {
  it('注意書きは grant ごとに初回だけ。live と result の両方から届いても検出は1回（引いたら消える）', async () => {
    const { s, hooks } = await openWithGrant({
      secondTurnLive: [
        live({
          tool_name: 'Bash',
          tool_use_id: 'tu-f1',
          decision_reason: '分類器が止めた',
          decision_reason_type: 'classifier',
        }),
      ],
      // tu-f1 は live で引いて消えているので、result では funneled にならない。tu-f2 は result だけで届く
      secondTurnDenials: [
        { tool_name: 'Bash', tool_use_id: 'tu-f1' },
        { tool_name: 'Bash', tool_use_id: 'tu-f2' },
      ],
    });
    await allow(hooks, 'tu-f1');
    await allow(hooks, 'tu-f2');
    await secondTurn(s);
    await s.clone.stop();

    expect(await denialLines(s.stores)).toEqual([
      '[判断] 許可 DB の規則 Bash(gh release edit:*)（grant grant-1）で PreToolUse が allow を返したのに、同じ呼び出し（合図の出所: live）が拒否された（分類: classifier / 理由: 分類器が止めた）。 考えられるのは、SDK が hook の allow を分類器へ回すようになったこと、または deny 規則が hook の allow を上書きしたことである（どちらかは、あるいは両方かは、ここからは切り分けられない）。この許可は、いまは効いていない可能性がある。',
      '[判断] Bash の実行が、確認へ上がらずに止められた（分類: classifier / 理由: 分類器が止めた）。止められたのは クローン本体 の手（合図の出所: live）。入力の形: 入力は付いていない（走行中の合図には入力の欄が無い。ターン終わりの記録が届けば、続く note に形だけ残る）。許可モードは auto で、この層に確認を回す相手は居ない。',
      '[判断] 許可 DB の規則 Bash(gh release edit:*)（grant grant-1）で PreToolUse が allow を返したのに、同じ呼び出し（合図の出所: result）が拒否された。',
      '[判断] Bash の実行が、確認へ上がらずに止められた。止められたのは どちらの層か不明 の手（合図の出所: result）。入力の形: 入力は付いていない（result の記録に入力の欄が無かった）。許可モードは auto で、この層に確認を回す相手は居ない。',
    ]);
  });

  it('決着（PostToolUse / PostToolUseFailure）した呼び出しの拒否は検出しない', async () => {
    const { s, hooks } = await openWithGrant({
      secondTurnDenials: [
        { tool_name: 'Bash', tool_use_id: 'tu-s1' },
        { tool_name: 'Bash', tool_use_id: 'tu-s2' },
      ],
    });
    await allow(hooks, 'tu-s1');
    await allow(hooks, 'tu-s2');
    await hooks.postToolUse(
      {
        tool_name: 'Bash',
        tool_use_id: 'tu-s1',
        tool_input: { command: 'gh release edit --draft' },
        tool_response: { output: 'ok' },
      } as never,
      undefined,
      {} as never,
    );
    await hooks.postToolUseFailure(
      {
        tool_name: 'Bash',
        tool_use_id: 'tu-s2',
        tool_input: { command: 'gh release edit --draft' },
        error: 'exit code 1',
      } as never,
      undefined,
      {} as never,
    );
    await secondTurn(s);
    await s.clone.stop();

    const lines = await denialLines(s.stores);
    expect(lines.filter((line) => line.includes('PreToolUse が allow を返した'))).toEqual([]);
    expect(lines).toHaveLength(2);
  });
});

describe('クローン — 決着も拒否も無いまま作業者が終わった（#onSubagentStop。全文）', () => {
  it('注意書きは grant ごとに初回だけ（同じ作業者の2件目は無し）。funneled の検出で書いた注意書きとも共有する', async () => {
    const { s, hooks } = await openWithGrant({
      secondTurnLive: [live({ tool_name: 'Bash', tool_use_id: 'tu-w3' })],
    });
    await allow(hooks, 'tu-w1', 'agent-1');
    await allow(hooks, 'tu-w2', 'agent-1');
    await stop(hooks, 'agent-1');
    // 注意書きは上で使い済みの grant（grant-1）なので、funneled の検出の行にも注意書きは付かない
    await allow(hooks, 'tu-w3');
    await secondTurn(s);
    await stop(hooks, 'agent-1');
    await s.clone.stop();

    const rows = await s.stores.journal.list({ types: ['exchange'], with: ['self'] });
    expect(
      rows
        .map((row) => (row.type === 'exchange' ? row.text : ''))
        .filter((text) => text.includes('SubagentStop を迎えた') || text.includes('PreToolUse が'))
        .reverse(),
    ).toEqual([
      '[判断] 許可 DB の規則 Bash(gh release edit:*)（grant grant-1）で PreToolUse が allow を返した作業者（agentId: agent-1）の呼び出し（tool_use_id: tu-w1）が、実行の決着も拒否の記録も無いまま、その作業者の SubagentStop を迎えた。決着しなかった。 「hook の allow を追い越した」とは断定しない——決着も拒否の記録も無いまま作業者が終わった、という不在の事実だけがここでは分かる。この許可は、いまは効いていない可能性がある。',
      '[判断] 許可 DB の規則 Bash(gh release edit:*)（grant grant-1）で PreToolUse が allow を返した作業者（agentId: agent-1）の呼び出し（tool_use_id: tu-w2）が、実行の決着も拒否の記録も無いまま、その作業者の SubagentStop を迎えた。決着しなかった。',
      '[判断] 許可 DB の規則 Bash(gh release edit:*)（grant grant-1）で PreToolUse が allow を返したのに、同じ呼び出し（合図の出所: live）が拒否された。',
    ]);
  });

  it('agentId で絞る: 別の作業者・agent_id の無い控え・agent_id の無い SubagentStop は、控えを消費しない', async () => {
    const { s, hooks } = await openWithGrant({});
    await allow(hooks, 'tu-x1', 'agent-1');
    await allow(hooks, 'tu-x2');
    await stop(hooks, 'agent-2');
    await stop(hooks);
    const before = await s.stores.journal.list({ types: ['exchange'], with: ['self'] });
    expect(
      before.filter((row) => row.type === 'exchange' && row.text.includes('SubagentStop を迎えた')),
    ).toEqual([]);

    // 消費されていないので、本人の SubagentStop ではまだ出る（agent-1 の1件だけ。agent_id の無い控えは出ない）
    await stop(hooks, 'agent-1');
    await s.clone.stop();
    const after = await s.stores.journal.list({ types: ['exchange'], with: ['self'] });
    const unsettled = after
      .map((row) => (row.type === 'exchange' ? row.text : ''))
      .filter((text) => text.includes('SubagentStop を迎えた'));
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toContain('tu-x1');
    expect(unsettled[0]).not.toContain('tu-x2');
  });
});

describe('クローン — 上限で忘れたときの onForget（日誌へ書く。待たずに投げる）', () => {
  // 上限は定数（512）で、`createClone` の口から小さくできない。513 件目を足して観測する
  const LIMIT = 512;

  it('拒否の記憶（tool_use_id）が上限を超えたら、古い1件を忘れたことを日誌へ書く（全文）', async () => {
    const lives = Array.from({ length: LIMIT + 1 }, (_, i) =>
      live({ tool_name: 'Bash', tool_use_id: `tu-n-${String(i).padStart(3, '0')}` }),
    );
    const { s } = await openWithGrant({ secondTurnLive: lives });
    await secondTurn(s);
    await s.clone.stop();

    const lines = await denialLines(s.stores);
    expect(lines.filter((line) => line.includes('記憶が上限'))).toEqual([
      '[間引き] 二重書き込み防止のために覚えている拒否の記憶が上限（512件）に達したので、古い 1 件を忘れた: tu-n-000。この tool_use_id の拒否が生の合図と result の両方から再び届くと、同じ拒否がもう一度日誌に載る。',
    ]);
    // 拒否の行そのものは 513 本とも書く（忘れるのは重複排除の記憶だけ）
    expect(lines.filter((line) => line.includes('確認へ上がらずに止められた'))).toHaveLength(
      LIMIT + 1,
    );
  });

  it('許可 DB の規則に一致して allow した記憶が上限を超えたら、古い1件を忘れたことを日誌へ書く（全文）', async () => {
    const { s, hooks } = await openWithGrant({});
    for (let i = 0; i <= LIMIT; i += 1) {
      await allow(hooks, `tu-a-${String(i).padStart(3, '0')}`);
    }
    await s.clone.stop();

    expect(await denialLines(s.stores)).toEqual([
      '[間引き] 許可 DB の規則に一致して allow を返した記憶が上限（512件）に達したので、古い 1 件を忘れた: tu-a-000。この tool_use_id への拒否が後から届いても、もう「hook の allow を追い越した」とは検出できない。',
    ]);
  });
});
