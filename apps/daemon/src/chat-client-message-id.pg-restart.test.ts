/**
 * #3634。pg の日誌は本文の NUL を落とし、孤立サロゲートを U+FFFD に直して残す（`storage-pg/src/db.ts` の `stripNulls`）。
 * 再起動をまたぐ重複の判定は、日誌の本文から指紋を作り直す（`findReceivedClientMessage`）。指紋（`client-message-fingerprint.ts`）が
 * 同じ規則（NUL を落とし、孤立サロゲートを U+FFFD に）を通さないと、再送が 409 mismatch になる。PGlite で再起動を模擬する。
 */
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  createClone,
  createLocalRunner,
  createRunnerRegistry,
  type Stores,
} from '@alteroid/core';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

const quietSdk = (() => {
  async function* generate(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 's',
      uuid: 'u-init',
      model: 'claude-fake',
      claude_code_version: '9.9.9',
      apiKeySource: 'user',
      permissionMode: 'default',
      mcp_servers: [],
    } as unknown as SDKMessage;
  }
  return Object.assign(generate(), {
    close: () => undefined,
    interrupt: async () => undefined,
  }) as unknown as Query;
}) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;

function appOver(stores: Stores) {
  const clone = createClone({
    stores,
    queryFn: quietSdk,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: quietSdk, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
}

const post = (app: ReturnType<typeof createApp>, body: Record<string, unknown>) =>
  app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });

let client: PGlite | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('clientMessageId の重複判定と、pg の日誌が書き換える本文', () => {
  it.each([
    ['陰性対照: 普通の本文', '普通の本文'],
    ['陰性対照: 正しいサロゲート対（絵文字）', '絵文字😀'],
    ['孤立した上位サロゲートを含む本文', '壊れた絵文字\ud83d'],
    ['孤立した下位サロゲートを含む本文', '\ude00壊れた絵文字'],
    ['NUL と孤立サロゲートの両方を含む本文', 'a\u0000b\ud83dc'],
  ])('%s の再送は、再起動をまたいでも 409 mismatch にならず重複として受ける', async (_label, text) => {
    const migrated = await createMigratedPglite();
    client = migrated.client;
    const stores = createPgStoresFromDb(migrated.db);
    const body = { text, conversationId: 'conv-a', clientMessageId: 'cm-1' };

    // 1 回目は受け取り済み（クローンが日誌へ書いた inbound の発言。pg が本文を書き換えて残す）。
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: body.text,
      conversationId: body.conversationId,
      clientMessageId: body.clientMessageId,
    });

    // デーモンの再起動のあとの再送（メモリの受け取り済みは空。日誌から引き直す）。
    const second = await post(appOver(stores), body);
    const reply = await second.text();
    expect([second.status, reply.includes('client_message_id_mismatch')]).toEqual([200, false]);
  });
});
