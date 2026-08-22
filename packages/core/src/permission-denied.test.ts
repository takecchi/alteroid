import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, runnerEventSchema } from './runner-protocol.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **確認へ上がらずに止められた実行が、クローンまで届くこと。**
 *
 * `permissionMode` の既定は `auto`（PR #35）である。人間が Claude Code を開いた
 * ときと同じで、これは正しい。だが `auto` では、SDK が自分で拒否したものは
 * `canUseTool`（＝クローンへの確認）を通らず**その場で止まる**。alteroid はその
 * 事実をどこからも読んでいなかった。
 *
 * 実機で起きた形（2026-08-14）: 作業者が `chat.test.tsx` の編集を拒否され、
 * 迂回せずマネージャーへ報告した。**クローンが知れたのは、マネージャーが自分から
 * 報告してくれたからである。** 黙って迂回されていたら誰も気づけない。
 *
 * ここで固定するのは「読むコードを書いた」ではなく、**runner → デーモン → 日誌 /
 * 受信箱の途中で落ちる箇所が無い**ことである。
 */

/** マネージャー側の SDK の代わり。SDK のメッセージを外から好きに流せるようにする。 */
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
 * 走行中の合図（`system/permission_denied`）。
 *
 * **⚠️ ここで渡している `tool_input` は足場の都合であって、実機の形ではない。**
 * SDK の実際の型 `SDKPermissionDeniedMessage` に `tool_input` フィールドは
 * 存在しない（`tool_name` / `tool_use_id` / `message` / `uuid` / `session_id`
 * と任意の3つだけ）。このヘルパは「`input` が付いている形」を確かめるテストの
 * ためだけに残してある。**実機に忠実な形が要るテストは `liveDenialAsSdkSends`
 * を使うこと。**
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

/**
 * 走行中の合図（`system/permission_denied`）を、**実機の SDK が実際に送ってくる
 * 形**で作る。`tool_input` を持たない。
 *
 * このヘルパが無かったことがこの不具合を見えなくしていた足場である —
 * `liveDenial()` が常に `tool_input` を手で渡していたため、`#noteDenial`
 * （`runner.ts`）が読む `denial.tool_input` が `undefined` になる経路を
 * どのテストも一度も通していなかった。`undefined` は `JSON.stringify`
 * （`apps/runner/src/app.ts`）でキーごと落ち、`runnerEventSchema`
 * （`runner-protocol.ts`）が `input` を必須のまま持っていた（zod 4 では
 * キーの不在を許さない）ので、境界を越えるとイベントが丸ごと捨てられていた。
 */
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

/** ターン終わりの記録（`result.permission_denials`）。 */
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

function open() {
  const stores = createMemoryStores();
  const manager = fakeManagerSdk();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
    ]),
  });
  return { stores, manager, inbox, pool };
}

/** 日誌に落ちた拒否の記録だけを取り出す（新しい順で返るので古い順へ直す）。 */
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
    // 何が拒否されたのかが分かる形で残る（後から辿れることが要件）
    expect(lines[0]).toContain('chat.test.tsx');
    expect(lines[0]).toContain('走行中の合図');

    await s.pool.stop();
  }, 15_000);

  it('1件では受信箱を鳴らさない。同じ道具が繰り返し止められたら上げる', async () => {
    // 拒否は正常な運用でも起きる。全部流すとクローンの判断が雑音で鈍る。
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const messages = () => s.inbox.filter((event) => event.type === 'manager_message');

    session.push(liveDenial('Edit', 'toolu_1', { file_path: 'a.tsx' }));
    await tick();
    expect(messages()).toHaveLength(0);

    session.push(liveDenial('Edit', 'toolu_2', { file_path: 'b.tsx' }));
    await tick();
    expect(messages()).toHaveLength(0);

    // 3件目で1度だけ上げる
    session.push(liveDenial('Edit', 'toolu_3', { file_path: 'c.tsx' }));
    await tick();
    expect(messages()).toHaveLength(1);
    const first = messages()[0];
    expect(first).toMatchObject({ managerId, kind: 'report' });
    expect(first?.text).toContain('Edit');
    expect(first?.text).toContain('3 件目');

    // 4〜8件目では黙る（止められ続けている1本で受信箱を埋めない）
    for (const id of ['toolu_4', 'toolu_5', 'toolu_6', 'toolu_7', 'toolu_8']) {
      session.push(liveDenial('Edit', id, { file_path: `${id}.tsx` }));
      await tick();
    }
    expect(messages()).toHaveLength(1);

    // 9件目でもう一度（3倍ごと）。**黙り続けもしない**
    session.push(liveDenial('Edit', 'toolu_9', { file_path: 'i.tsx' }));
    await tick();
    expect(messages()).toHaveLength(2);
    expect(messages()[1]?.text).toContain('9 件目');

    // 日誌にはこの間の9件が全部残っている
    expect(await deniedLines(s.stores)).toHaveLength(9);

    await s.pool.stop();
  }, 15_000);

  it('result の記録からも届く。走行中の合図と同じ1件は二度上げない', async () => {
    // SDK 曰く、走行中の合図は best-effort で、authoritative なのは
    // `result.permission_denials` である。だから両方読む。**同じ拒否が二度
    // 上がると、件数が二重に増えて「繰り返し」の判定まで狂う。**
    const s = open();
    await s.pool.start({ request: '調べて' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Bash', 'toolu_1', { command: 'git diff' }));
    await tick();

    session.push(
      resultWithDenials('終わった', [
        // 走行中に見たものと同じ1件（`tool_use_id` が同じ）
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git diff' } },
        // 合図が来ていなかった1件（取りこぼしはここで拾う）
        { tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: { file_path: 'x.ts' } },
      ]),
    );
    await tick();

    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Bash');
    expect(lines[1]).toContain('Write');
    expect(lines[1]).toContain('result の記録');
    // ターンの報告そのものはこれまでどおり届く（拒否の観測が報告を潰さない）
    expect(
      s.inbox.filter((event) => event.type === 'manager_message' && event.text === '終わった'),
    ).toHaveLength(1);

    await s.pool.stop();
  }, 15_000);

  it('同じ result が二度届いても数え直さない（累積で来ても壊れない）', async () => {
    // `result.permission_denials` が累積かどうかは SDK の型に書かれていない
    // （`modelUsage` には「累積」と明記があるが、こちらには無い）。**どちらでも
    // 壊れないこと**を固定する — 累積を素直に数えると、3件目の閾値に一度の
    // 拒否だけで到達して受信箱が鳴る。
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
    ).toHaveLength(0);

    await s.pool.stop();
  }, 15_000);

  it('件数を覚える蓋に当たったことを黙らない（数え直しが記録に残る）', async () => {
    // 蓋を設けるなら、当たったことが分からないと「なぜ件数が戻ったのか」を後から
    // 誰も辿れない（`recent.ts` の思想そのまま）。
    const s = open();
    await s.pool.start({ request: 'いろいろやって' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 覚える上限は道具の種類 64。65種めで最も古い1件が押し出される。
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
    // 拒否そのものは65件すべて日誌に残っている（忘れたのは件数の帳面だけ）
    expect(await deniedLines(s.stores)).toHaveLength(65);

    await s.pool.stop();
  }, 20_000);

  /**
   * **数えているだけでは表に出ない。**
   *
   * 拒否の件数は `ManagerRecord.denied` に積まれていたのに、読み出す口が無く、
   * 日誌と（繰り返したときだけ）受信箱にしか現れなかった。一覧を見ている
   * クローンからは `running` としか読めず、**手が止まっていることが見えなかった**。
   */
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

    // 古い順（＝一覧は末尾から採る）。Edit は入れ直しで新しい側へ寄る。
    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Bash', count: 1 },
      { tool: 'Edit', count: 2 },
    ]);

    // **状態の値は増やさない。** `stalled` を新設すると `openapi.json` の
    // 外向きの面まで動く。止まっている疑いは状態に**添えて**出す。
    const listed = (await s.pool.list()).find((entry) => entry.managerId === managerId);
    expect(listed?.status).toBe('running');
    // 一覧の応答そのものには載せない（spec に無いものを外へ出さない）。
    expect(listed).not.toHaveProperty('denials');

    await s.pool.stop();
  }, 15_000);

  it('知らない manager_id には空を返す（無いものを数えたことにしない）', () => {
    const s = open();
    expect(s.pool.denials('mgr-居ない')).toEqual([]);
  });

  it('runner から降ろす出来事が境界のスキーマを通る（HTTP 越しで落ちない）', () => {
    // デーモンと runner の間は JSON である。ここを通らない形で降ろすと、同一
    // プロセスでは届くのにコンテナ構成では消える、という差が生まれる。
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

  /**
   * **上のテストは、まさにこの回帰を守るはずだった。**
   *
   * だが `input: { file_path: 'a.tsx' }` と `input` を手で書いて渡していたため、
   * 実際に境界を越えて壊れていた形 — `via: 'live'` のとき `input` という
   * **キー自体が存在しない**形 — を一度も通していなかった。SDK の
   * `SDKPermissionDeniedMessage` には `tool_input` が無く、`#noteDenial`
   * （`runner.ts`）が読む値は `undefined` になり、`JSON.stringify`
   * （`apps/runner/src/app.ts`）はそれをキーごと落とす。zod 4 では
   * `z.unknown()` はキーの不在を許さないので（zod 3 と違う）、`input` を
   * 必須のままにしていると `safeParse` はここで失敗していた。
   */
  it('live の拒否は `input` キーが無くても境界のスキーマを通る（実機の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'permission_denied',
          managerId: 'mgr-1',
          toolUseId: 'toolu_1',
          tool: 'Edit',
          // `input` を渡していない。JSON.stringify も undefined のキーを
          // 落とすので、これが `via: 'live'` の実機の形と一致する。
          via: 'live',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

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
});
