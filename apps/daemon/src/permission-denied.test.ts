import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createManagerPool,
  createRunnerHost,
  createRunnerRegistry,
  createMemoryStores,
  type InboxEvent,
  type JournalEntry,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { createHttpRunner } from './runner-client.js';

/**
 * **確認へ上がらずに止められた実行が、境界越しでクローンまで届くこと。**
 *
 * `permissionMode: 'auto'` では、SDK が自分で拒否したものは `canUseTool` を
 * 通らずその場で止まる。同一プロセスで届くだけでは足りない — デーモンと runner の
 * 間は JSON なので、**降ろす形が境界のスキーマを通らないとコンテナ構成でだけ
 * 消える**（そして消えたことは誰にも見えない）。ここは本物の HTTP を通す。
 *
 * SDK だけが偽物である（`runner-client.test.ts` と同じ形）。
 */

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function fakeSdk() {
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
        session_id: 'sess-1',
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

/** hono のアプリへ直に流す fetch（ソケットを開かずに本物の HTTP 経路を通す）。 */
function fetchInto(app: ReturnType<typeof createRunnerApp>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return app.request(`${url.pathname}${url.search}`, init as never);
  }) as typeof fetch;
}

interface Rig {
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  inbox: InboxEvent[];
  sessions: ReturnType<typeof fakeSdk>['sessions'];
  close(): Promise<void>;
}

const rigs: Rig[] = [];

afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.close();
});

async function open(): Promise<Rig> {
  const { fn, sessions } = fakeSdk();
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  const client = await createHttpRunner({
    baseUrl: 'http://runner.test',
    token: TOKEN,
    fetchFn: fetchInto(app),
  });

  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([client]),
  });

  const rig: Rig = {
    pool,
    stores,
    inbox,
    sessions,
    async close() {
      await pool.stop();
      await host.shutdown();
    },
  };
  rigs.push(rig);
  return rig;
}

async function deniedLines(stores: Stores): Promise<string[]> {
  const entries = (await stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
  return entries
    .filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('確認へ上がらずに止められた'),
    )
    .map((entry) => entry.text)
    .reverse();
}

/**
 * 日誌に落ちた `note`（`#noteDenial`（`packages/core/src/runner.ts`）が「先に
 * 降ろした拒否に、後から入力が付いた」ときにだけ降ろす1件）を取り出す。
 * `deniedLines` の文言（確認へ上がらずに止められた）とは別なので分けて拾う。
 */
async function noteLines(stores: Stores): Promise<string[]> {
  const entries = (await stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
  return entries
    .filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('先に降ろした'),
    )
    .map((entry) => entry.text)
    .reverse();
}

describe('確認へ上がらずに止められた実行（HTTP 境界）', () => {
  it('走行中の合図と result の記録が、境界越しに日誌と受信箱まで届く', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 走行中の合図（分類器がその場で止めた）
    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: 'apps/web/app/routes/chat.test.tsx' },
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    // **期待値の反転（`packages/core/src/denial-shape.ts` 導入）。**
    //
    // 変更した事実: このテストは元々「ファイルパスの値そのもの
    // （`chat.test.tsx`）が境界越しに日誌へ残ること」を固定していた。いまは
    // `manager.ts` の `case 'permission_denied'` が `brief(event.input)`（生の
    // JSON ダンプ）ではなく `denialInputShape(event.input)` を使うので、値では
    // なく形（`欄=file_path / chars=49`）しか残らない。
    //
    // なぜ必要になったか: 道具の入力には環境変数の値・トークン・URL に埋まった
    // 鍵が入りうる。日誌は消えない記録なので、値をそのまま書くと鍵がそこへ
    // 焼き付く（`denial-shape.ts` の doc）。
    //
    // なぜ保証が弱くなっていないか: 「何が拒否されたのかが分かる形で残る」と
    // いう元の意図は、欄の名前（`file_path`）と長さ（`chars=`）が境界を越えて
    // 残ることで保たれている。弱くなったのは「どの値か」の解像度であって、
    // 「何が起きたか追える」という要件そのものではない。値が出なくなったことも
    // 形は残ることも、両方をここで固定する。
    const line = (await deniedLines(r.stores))[0];
    expect(line).toContain('欄=file_path');
    expect(line).toMatch(/chars=\d+/);
    expect(line).not.toContain('chat.test.tsx');

    // ターン終わりの記録。走行中に見た1件は二度上げず、見ていなかった1件を拾う
    session.push({
      type: 'result',
      subtype: 'success',
      result: '編集できなかったので報告する',
      permission_denials: [
        {
          tool_name: 'Edit',
          tool_use_id: 'toolu_1',
          tool_input: { file_path: 'apps/web/app/routes/chat.test.tsx' },
        },
        { tool_name: 'Edit', tool_use_id: 'toolu_2', tool_input: { file_path: 'b.tsx' } },
        { tool_name: 'Edit', tool_use_id: 'toolu_3', tool_input: { file_path: 'c.tsx' } },
      ],
      session_id: 'sess-1',
      uuid: 'uuid-result-1',
    } as unknown as SDKMessage);

    // 3件で受信箱が鳴る（同じ道具が繰り返し止められている形）
    await expect
      .poll(
        () =>
          r.inbox.filter(
            (event) => event.type === 'manager_message' && event.text.includes('止められた'),
          ).length,
        { timeout: 2000 },
      )
      .toBe(1);
    const alert = r.inbox.find(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.text.includes('止められた'),
    );
    expect(alert).toMatchObject({ managerId, kind: 'report' });
    expect(alert?.text).toContain('3 件目');

    // 日誌には3件（重複した toolu_1 は1件のまま）
    expect(await deniedLines(r.stores)).toHaveLength(3);
    // マネージャー自身の報告も従来どおり届く
    expect(
      r.inbox.filter(
        (event) =>
          event.type === 'manager_message' && event.text === '編集できなかったので報告する',
      ),
    ).toHaveLength(1);
  }, 15_000);

  /**
   * **回帰: `tool_input` を持たない走行中の合図が、HTTP 境界を越えて捨てられる。**
   *
   * SDK の実際の `SDKPermissionDeniedMessage` には `tool_input` フィールドが
   * 無い。上のテストは `tool_input` を手で渡していたので、`input` というキーが
   * 常に存在する形でしかこの境界を通していなかった。実機では `input` が
   * `undefined` になり、`JSON.stringify`（`apps/runner/src/app.ts`）がキーごと
   * 落とすので、`runnerEventSchema` が `input` を必須のまま持っていると
   * （zod 4 はキーの不在を許さない）`safeParse` が失敗し、拒否が丸ごと
   * デーモンに届かなかった。
   */
  it('`tool_input` の無い走行中の合図でも、境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 走行中の合図（実機の SDK が実際に送ってくる形。`tool_input` を持たない）
    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    expect((await deniedLines(r.stores))[0]).toContain('Edit');
    expect((await deniedLines(r.stores))[0]).toContain('走行中の合図');
  }, 15_000);

  /**
   * **理由・分類・モデルへの拒否文（`decision_reason` / `decision_reason_type` /
   * `message`）が、HTTP 境界を越えて日誌まで届くこと。**
   *
   * `runnerEventSchema` の `permission_denied` にこの3欄を足した PR（`input` の
   * ときと同じ理由で全部 `.optional()`）。**同一プロセスのテスト
   * （`packages/core/src/permission-denied.test.ts`）だけでは、この3欄が
   * `JSON.stringify` でキーごと落ちる形を再現できない** — ここは本物の HTTP
   * （`fetchInto` 経由で hono の app へ）を通す。
   */
  it('理由・分類・モデルへの拒否文が、境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 実機の SDK が送ってくる形（`tool_input` は無く、理由の3欄がある）
    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      decision_reason: 'この編集は許可されていないパスに触れている',
      decision_reason_type: 'rule',
      message: 'Edit was denied by a deny rule',
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const line = (await deniedLines(r.stores))[0];
    expect(line).toContain('Edit');
    expect(line).toContain('走行中の合図');
    expect(line).toContain('この編集は許可されていないパスに触れている');
    expect(line).toContain('rule');
    expect(line).toContain('Edit was denied by a deny rule');
  }, 15_000);

  /**
   * **理由の3欄が無くても、境界越しに拒否そのものは変わらず届くこと。**
   *
   * `via: 'result'`（`SDKPermissionDenial`）は理由を一切持たないので、これが
   * 実機の主要な形である。3欄とも欠けたときに「（不明）」等の作り物を出さない
   * ことをここで固定する。
   */
  it('理由の3欄が無い result の記録でも、作り物を足さずに境界越しに届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push({
      type: 'result',
      subtype: 'success',
      result: '編集できなかったので報告する',
      permission_denials: [
        { tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: 'a.tsx' } },
      ],
      session_id: 'sess-1',
      uuid: 'uuid-result-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const line = (await deniedLines(r.stores))[0];
    expect(line).toContain('Edit');
    expect(line).not.toContain('分類:');
    expect(line).not.toContain('理由:');
    expect(line).not.toContain('モデルへの拒否文:');
    expect(line).not.toContain('（不明）');
  }, 15_000);

  /**
   * **新しく降ろすようになった `note` イベントが、HTTP 境界を越えてデーモンの
   * 日誌まで届くこと。**
   *
   * `runner.ts` の `#noteDenial` は、先に入力を持たない記録（`via: 'live'`）が
   * 降りていて、後から入力を持つ記録（`via: 'result'`）が同じ `tool_use_id` で
   * 届いたときに限り、`permission_denied` をもう一度降ろす代わりに既存の
   * `note` イベントで形だけを1本足す（`runner-protocol.ts` に種別も欄も足さない
   * ための選択）。**`note` はここでは何も新設していないので同一プロセスの
   * テストでも境界は割と壊れにくいが**、`runner-protocol.ts` 冒頭の doc
   * （「回帰テストは JSON.parse(JSON.stringify(...)) を通すか、HTTP 境界を実際に
   * 越える apps/daemon 側で書くこと」）に従い、ここは本物の HTTP
   * （`fetchInto` 経由で hono の app へ）を通して固定する。
   */
  it('先に届いた入力なしの拒否に、後から入力ありの記録が続くと、note が境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 走行中の合図（実機の SDK が実際に送ってくる形。`tool_input` を持たない）
    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);
    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);

    // ターン終わりの記録。同じ id に、今度は入力が付いて届く。
    session.push({
      type: 'result',
      subtype: 'success',
      result: '終わった',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git diff' } },
      ],
      session_id: 'sess-1',
      uuid: 'uuid-result-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await noteLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const note = (await noteLines(r.stores))[0];
    expect(note).toContain('Bash');
    // 値ではなく形が載る（欄名と先頭の語）。
    expect(note).toContain('欄=command');
    expect(note).toContain('先頭の語=git');

    // **拒否の行そのものは増えない。** `permission_denied` を二度降ろすと
    // デーモンの件数が二重計上になる（`runner.ts` の `#noteDenial` の doc）。
    expect(await deniedLines(r.stores)).toHaveLength(1);
  }, 15_000);
});
