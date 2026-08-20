/**
 * 症状B（人間の報告）: 「利用上限に当たった状態で話しかけると、枠が回復した
 * 後も、待たされていた発言への返信が届かない」。
 *
 * `clone.test.ts` の「症状B」ブロックは `packages/core` だけで確かめており、
 * `GET /conversations/:id`（`apps/daemon/src/app.ts:944-967`）が実際に何を
 * 返すかは見ていない。ここでは**本物の `createClone`（偽 SDK のみ差し替え）と
 * 本物の `createApp` を組み合わせ**、`/chat` → `/conversations/:id` を実際に
 * 叩いて確かめる。
 *
 * マネージャーからの追加指示: 人間の要望は「あとで良いのでちゃんと返信して
 * ほしい」であって、リアルタイム性ではない。だから「会話に残って、開けば
 * 見える」で訴えは満たせるはずだが、**`clone.ts` の `#reportFailure`
 * （:1071-1095）は枠で落ちた1回目の失敗を `with: 'human'` / `role: 'outbound'`
 * で日誌へ書く** — これは `/conversations/:id` の絞り込み
 * （`entry.with === 'human'`、role は見ない）をそのまま通るので、**枠に当たった
 * 英語の失敗理由が、あたかもクローンの返信であるかのように会話へ混ざる**。
 * これが人間の言う「英語の文言が返信として出る」の正体である可能性が高い。
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  type CloneHost,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const spendLimitMessage = "You've hit your individual spend limit for this account.";

/**
 * `packages/core/src/clone.test.ts` の `fakeSdk` の簡約版。
 *
 * ここで確かめたいのは `apps/daemon` の HTTP 経路と実クローンを組み合わせた
 * ときの挙動であって、SDK の全形はいらない。**`turnIndex` ごとに成功/失敗を
 * 切り替えられれば足りる**（枠に当たる→回復して再試行が成功する、の2状態）。
 * 返信テキストに `turnIndex` を焼き込み、日誌・会話のどのエントリがどの回の
 * ものかを文字列だけで一意に特定できるようにしてある（カウントの数え間違いに
 * 頼らないため）。
 */
function fakeSdk(
  resultFor: (turnIndex: number) => { subtype?: string; text?: string } | undefined,
): typeof import('@anthropic-ai/claude-agent-sdk').query {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      let turnIndex = 0;
      async function* runTurn(idx: number): AsyncGenerator<SDKMessage, void> {
        const override = resultFor(idx);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `返信(turn=${idx})` }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: `uuid-assistant-${idx}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: override?.subtype ?? 'success',
          result: override?.text ?? `返信(turn=${idx})`,
          session_id: 'sess-fake',
          uuid: `uuid-result-${idx}`,
        } as unknown as SDKMessage;
      }

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        yield* runTurn(0);
        return;
      }
      // `for await (const message of ...)` にしないのは、`message` を1本も
      // 使わないから（各ターンの入力文字列はここでは要らない。何回目かだけで
      // 成功/失敗を切り替えられれば足りる）。束縛せずに1件ずつ進める。
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        const idx = turnIndex;
        turnIndex += 1;
        yield* runTurn(idx);
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
  return fn;
}

function setupRealCloneApp(
  resultFor: (turnIndex: number) => { subtype?: string; text?: string } | undefined,
): { app: ReturnType<typeof createApp>; stores: Stores; clone: CloneHost } {
  const stores = createMemoryStores();
  const queryFn = fakeSdk(resultFor);
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
  });
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
  return { app, stores, clone };
}

async function waitFor(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > 5000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface ConversationMessage {
  id: string;
  at: string;
  role: 'inbound' | 'outbound';
  text: string;
}

describe('/conversations/:id と枠（利用上限）の再試行 — 症状B', () => {
  it('保持していた合図の再試行が成功すると、/conversations/:id には最終的に inbound → outbound の順で返信が並ぶ', async () => {
    const { app, stores } = setupRealCloneApp((turnIndex) =>
      turnIndex === 0 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    );

    // 1本目: 枠に当たる。実物の /chat を叩き、SSE が終わるまで待つ
    // （`response.text()` は app.ts の SSE ループが `done`/`error` で
    // 抜けるまで、つまり実物の unsubscribe が起きるまで待つ）。
    const first = await app.request('/chat', json({ text: '一件目', conversationId: 'conv-1' }));
    const firstBody = await first.text();
    expect(firstBody).toContain('event: usage_limited');
    expect(firstBody).toContain('event: error');

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    // 枠が回復した後の契機は、人間が chat を開いていなくても来る。ここでは
    // `/events`（起点③・外部イベント）を使い、conv-1 への新しい /chat 接続を
    // 意図的に開かない — 「たまたま人間が再度 chat を開いた」に頼らない形。
    const eventsResponse = await app.request('/events', json({ source: 'test', payload: {} }));
    expect(eventsResponse.status).toBe(200);

    // 保持していた1本目の再試行が実際に成功するまで待つ。
    await waitFor(async () => {
      const detail = await app.request('/conversations/conv-1');
      if (detail.status !== 200) return false;
      const body = (await detail.json()) as { messages: ConversationMessage[] };
      return body.messages.some((m) => m.text.includes('返信(turn=1)'));
    }, '保持していた1本目の再試行の返信が /conversations/conv-1 に現れる');

    // 症状Bの核心（マネージャーの言う「あとで良いのでちゃんと返信してほしい」）:
    // 元の /chat 接続（firstBody）にはこの返信が届いていない（現物の SSE は
    // error で終端しているので当然）。しかし /conversations/:id を見れば、
    // human が後で画面を開いたときに再試行の成功が見えるはず、という期待を
    // ここで検証する。
    expect(firstBody).not.toContain('返信(turn=1)');

    const detail = await app.request('/conversations/conv-1');
    const body = (await detail.json()) as { messages: ConversationMessage[] };

    // 並び順（古い順）を確かめる。1本目の人間の発言（inbound）が最初に来て、
    // 最終的な成功の返信（outbound, turn=1）がそれより後ろにあること。
    const humanIndex = body.messages.findIndex((m) => m.role === 'inbound' && m.text === '一件目');
    const replyIndex = body.messages.findIndex(
      (m) => m.role === 'outbound' && m.text === '返信(turn=1)',
    );
    expect(humanIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(humanIndex);
  });

  it('枠で落ちた1回目の失敗理由（英語）が、クローンの返信として会話に混ざる（人間の言う「英語の文言が返信として出る」の候補）', async () => {
    const { app, stores } = setupRealCloneApp((turnIndex) =>
      turnIndex === 0 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    );

    const first = await app.request('/chat', json({ text: '一件目', conversationId: 'conv-1' }));
    await first.text();

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    await app.request('/events', json({ source: 'test', payload: {} }));

    await waitFor(async () => {
      const detail = await app.request('/conversations/conv-1');
      if (detail.status !== 200) return false;
      const body = (await detail.json()) as { messages: ConversationMessage[] };
      return body.messages.some((m) => m.text.includes('返信(turn=1)'));
    }, '保持していた1本目の再試行の返信が /conversations/conv-1 に現れる');

    const detail = await app.request('/conversations/conv-1');
    const body = (await detail.json()) as { messages: ConversationMessage[] };
    const outboundTexts = body.messages.filter((m) => m.role === 'outbound').map((m) => m.text);

    // **求める結果（あるべき姿）**: 人間に見せる会話の「クローンの返信」欄には、
    // SDK の生の失敗理由（英語）がそのまま出てはいけない。しかし
    // `clone.ts:1079-1094`（`#reportFailure`）は、枠で落ちた失敗を
    // `with: 'human'` / `role: 'outbound'` の exchange として書いており、
    // `/conversations/:id` の絞り込みはこれを一切除外しない
    // （`app.ts:948-963`。`with==='human'` しか見ておらず、内容や `role` の
    // 中身では弾いていない）。だから今回は失敗する（赤で正しい）。
    const containsRawFailureText = outboundTexts.some((text) => text.includes(spendLimitMessage));
    expect(containsRawFailureText).toBe(false);
  });
});
