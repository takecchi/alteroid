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

/**
 * 走行中の合図（`system/permission_denied`）を、**作業者（Task subagent）の
 * 内側で拒否された形**で作る。SDK の `SDKPermissionDeniedMessage.agent_id`
 * （サブエージェント起源のときだけ付く。`agent_id?: string` の doc（逐語）: [sdk-verbatim SDKPermissionDeniedMessage.agent_id]
 * Subagent ID when the denied tool call originated inside a subagent.
 *
 * `@anthropic-ai/claude-agent-sdk@0.3.261` の型で確認済み）を模す。
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

/**
 * 走行中の合図（`system/permission_denied`）を、**`tool_use_id` を持たない形**で作る。
 *
 * `liveDenial()` と違い `tool_use_id` を一切載せない —— `toAgentPermissionDenial`
 * （`claude-provider.ts`）は空文字/欠落のどちらも「id が無い」として読むので、これは
 * `#noteDenial`（`runner.ts`）の代用鍵（`${tool}:${digestOf(brief(input,120))}`）を
 * 通す経路を作るための足場である。**実機の `via: 'live'` は `tool_input` 自体を
 * 持たない**（`liveDenialAsSdkSends` の doc）ので、ここで `tool_input` を足しているのは
 * `liveDenial()` と同じ意味での足場である —— 代用鍵が入力ごとに変わることを
 * 確かめるにはどうしても値の変化が要る。
 */
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

/**
 * 日誌に落ちた `note`（`#noteDenial` が「先に降ろした拒否に、後から入力が付いた」
 * ときにだけ降ろす1件）を取り出す。`deniedLines` の文言（確認へ上がらずに
 * 止められた）とは別の文言なので、フィルタも別にする。
 */
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
    // **期待値の反転（denial-shape.ts 導入）。**
    //
    // 変更した事実: このテストは元々「ファイルパスの値そのもの
    // （`chat.test.tsx`）が日誌に残ること」を固定していた。いまは
    // `brief(event.input)`（生の JSON ダンプ）ではなく `denialInputShape` を
    // 使うので、値ではなく形（`欄=file_path / chars=49`）しか残らない。
    //
    // なぜ必要になったか: 道具の入力には環境変数の値・トークン・URL に埋まった
    // 鍵が入りうる（`denial-shape.ts` の doc）。日誌は消えない記録なので、
    // 値をそのまま書くと鍵がそこへ焼き付く。
    //
    // なぜ保証が弱くなっていないか: 「何が拒否されたのかが分かる形で残る」と
    // いう元の意図は、欄の名前（`file_path`）と長さ（`chars=`）が残ることで
    // 保たれている——読む側は「Edit が file_path を1つ持つ入力で拒否された」
    // までは辿れる。弱くなったのは「どの値か」の解像度であって、「何が起きたか
    // 追える」という要件そのものではない。**その反転を歯にする**——値が
    // 出なくなったことも、形は残ることも、両方確かめる。
    expect(lines[0]).toContain('欄=file_path');
    expect(lines[0]).toMatch(/chars=\d+/);
    expect(lines.join('\n')).not.toContain('chat.test.tsx');
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
    // `liveDenial` は `agent_id` を持たないので、層は `manager` に解決される
    // （`#onPostToolUse` と同じ式。Issue #373 対応）。
    expect(s.pool.denials(managerId)).toEqual([
      { tool: 'Bash', count: 1, actor: 'manager' },
      { tool: 'Edit', count: 2, actor: 'manager' },
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

  /**
   * `reason` / `reasonType` / `message`（SDK の `decision_reason` /
   * `decision_reason_type` / `message`）も `input` と同じ理由で `.optional()`
   * である。**この3欄が無い回（`via: 'result'` は必ずこれ）でもキーが無いまま
   * 境界のスキーマを通ること**を、`input` のときと同じ形で固定する。
   */
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
          // reason / reasonType / message を渡していない。
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

  /** 3欄が揃っている回（`via: 'live'`）でも境界のスキーマを通り、値が保たれる。 */
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

  /**
   * **このテストは同一プロセス（`createLocalRunner`）なので JSON 境界を越えない。**
   * `createLocalRunner`（`runner-local.ts`）は `RunnerHost` を直接持つだけで、
   * `apps/runner` の HTTP アプリも `JSON.stringify` / `JSON.parse` も一度も
   * 経由しない。だから `input` のキーが `undefined` として残ったまま
   * `#noteDenial`（`runner.ts`）から `#emit` へ渡っても、ここでは壊れない
   * （オブジェクトのキーがそのまま残るので、zod の必須欄でも通ってしまう）。
   *
   * **境界の回帰は `apps/daemon` 側の同名のテストが持つ**
   * （`apps/daemon/src/permission-denied.test.ts`。本物の HTTP を hono の
   * app へ通す）。ここが緑でも、境界越えの保証にはならない。
   */
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

  /**
   * **Markdown ではない字面が、Markdown で描かれる面で化けないこと**（issue #287）。
   *
   * **期待値の反転（denial-shape.ts 導入）。**
   *
   * 変更した事実: このテストは元々「受信箱の本文で `brief(event.input)` の
   * JSON ダンプそのものが可変長フェンスで包まれること」（`` ``{"command":"echo
   * `date`"}`` ``）を固定していた。いまは本文（値）を包む経路そのものが無い ——
   * `manager.ts` の `case 'permission_denied'` は `denialInputShape(event.input)`
   * （値ではなく形）を組み立ててから包むので、包まれるのは
   * `欄=command / 先頭の語=echo / chars=25` のような形の文字列である。
   *
   * なぜ必要になったか: 上のテスト（`欄=file_path` のほう）と同じ理由——値には
   * 鍵が入りうるので、日誌だけでなく受信箱（クローンへの報告）でも値を出さない
   * ことにした。包む対象が変わったのは、包まれるもの自体が変わったからである。
   *
   * なぜ保証が弱くなっていないか: 「Markdown ではない字面を Markdown の文へ
   * 素で埋めると化ける」という可変長フェンスそのものの歯は、**責務が
   * `markdown-span.test.ts` の `codeSpan` 単体テスト（8本、
   * 「Bash のコマンド置換を含む JSON ダンプが、そこで閉じない包みになる」を含む）
   * へ移った**——`denialInputShape` が返す形は道具のスキーマ由来の欄名と
   * 先頭の語だけなので JSON のバッククォートは載らないが、`codeSpan` 自体が
   * 可変長フェンスで包むことに変わりはなく、それはそちらが引き続き固定している。
   * ここで固定するのは「値ではなく形が包まれること」と「日誌の行は包まない
   * （Markdown で描かれる面ではないので）」の2点——前者は
   * `denialInputShape` を経由しているかの歯、後者は元のテストが持っていた
   * 歯をそのまま残す。
   *
   * **日誌の行は包まない。** あちらは Markdown で描かれる面ではないので、包めば
   * 読み手に無いバッククォートが見える。ここでは**両方を1つのテストで固定する** ——
   * 片方だけを見ると、包みを共通化して日誌まで巻き込む実装が黙って通るからである。
   */
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

    // 値（生の JSON ダンプ）ではなく、形が `codeSpan` で包まれて載る。
    const shape = denialInputShape(input);
    expect(shape).toBeDefined();
    expect(text).toContain(codeSpan(shape as string));
    // 値そのもの（バッククォートを含む生の JSON）はどこにも出ない。
    expect(text).not.toContain('echo `date`');
    // ツール名も識別子として包む（本文の `journal_read` と扱いを揃える）。
    expect(text).toContain('`Bash` の実行が');
    // 後続のインラインコードが巻き込まれずに残っている。
    expect(text).toContain('（`journal_read` で辿れる）');

    // **日誌は変えていない。** 形が素のまま（包まれずに）1行として残る。
    const lines = await deniedLines(s.stores);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`: ${shape}`);
    expect(lines[0]).not.toContain('``');
    expect(lines[0]).not.toContain('echo `date`');

    await s.pool.stop();
  }, 15_000);
});

/**
 * Issue #373 — マネージャー自身の拒否と作業者の拒否が同じ数に畳まれていて、
 * クローンが誤った相手（例: マネージャー自身）へ指示を出した実害（2026-08-24
 * コメント #5393921053）を再現しないことを固定する。
 *
 * 材料は SDK の `SDKPermissionDeniedMessage.agent_id`
 * （`via: 'live'` のときだけ付く。`via: 'result'` の型 `SDKPermissionDenial`
 * には存在しない——**判定材料が無い回は「取れていない」第3の状態のまま
 * 運ぶ**。`manager` 側へ黙って寄せると、実際は作業者の拒否でもマネージャー
 * の拒否として数えられ、クローンが誤った相手を止めに行く。
 */
describe('層の判定（Issue #373）', () => {
  it('via: live + agent_id 在り → 作業者として数える', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenialFromWorker('Edit', 'toolu_w1'));
    await tick();

    expect(s.pool.denials(managerId)).toEqual([{ tool: 'Edit', count: 1, actor: 'worker' }]);

    await s.pool.stop();
  }, 15_000);

  it('via: live + agent_id 無し → マネージャー自身として数える', async () => {
    const s = open();
    const { managerId } = await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push(liveDenial('Edit', 'toolu_m1', { file_path: 'a.tsx' }));
    await tick();

    expect(s.pool.denials(managerId)).toEqual([{ tool: 'Edit', count: 1, actor: 'manager' }]);

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

    // **`actor` キーそのものが無い。** 「マネージャーだった」への読み替えを
    // しない——`toEqual` は欠けている欄と `undefined` を区別しないので、
    // `not.toHaveProperty` で「キー自体が無い」ことも別に確かめる。
    const denials = s.pool.denials(managerId);
    expect(denials).toEqual([{ tool: 'Write', count: 1 }]);
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

    // マネージャー1件・作業者2件（別の agent_id でも同じ「作業者」枠へ集約）
    // ——同じ「Edit」でも層が違えば別枠になる。これが崩れると、マネージャー
    // 自身が2回止められただけに見える（Issue #373 の実害の形）。
    const denials = s.pool.denials(managerId);
    expect(denials).toContainEqual({ tool: 'Edit', count: 1, actor: 'manager' });
    expect(denials).toContainEqual({ tool: 'Edit', count: 2, actor: 'worker' });

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
          // actor を渡していない（旧い runner、または via: 'result' で
          // 判定材料が無い回の実機の形と一致する）。
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

/**
 * `#noteDenial`（`runner.ts`）が `via: 'live'` と `via: 'result'` の到着順を
 * どう畳むかの分岐を、1本ずつ数え上げて固定する。
 *
 * 帳面 `#denied` の値が `true`（降ろしたか否かの1ビット）から
 * `DeniedRecord = { input: boolean }`（入力を持つ記録を既に降ろしたか）に
 * 変わったことで、「入力を持たない記録が先に来て、入力を持つ記録が後から来る」
 * 順序だけが特別扱いになった。**この順序変化の全パターンを塞ぐ**。
 */
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

    // **拒否の行は増えない。** 同じ1件が2件として日誌へ落ちると、デーモンの
    // 件数（`s.pool.denials`）も二重に増え、escalation の段が狂う。
    expect(await deniedLines(s.stores)).toHaveLength(1);

    // **note が1本だけ増え、そこに形が載る。**
    const notes = await noteLines(s.stores);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Bash');
    expect(notes[0]).toContain(denialInputShape({ command: 'git diff' }) as string);

    // デーモンの件数は1のまま（`permission_denied` を2件と数えていない）。
    expect(s.pool.denials(managerId)).toEqual([{ tool: 'Bash', count: 1, actor: 'manager' }]);

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

    // **result が authoritative な入力を既に持っているので、後から来た
    // 入力なしの live では何も足さない。** 行は増えず、note も出ない。
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
    // `brief(undefined)` が `''` を返していた頃は、この行の末尾が空文字に
    // 落ちて「空のコマンドだった」と見分けが付かなかった。いまは経路ごとに
    // 「なぜ無いのか」を言う一文が入り、空文字にはならない。
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
    // **2度目の result では、既に入力を持っている（`seen.input === true`）ので
    // 早期返却する。** note が2本に増えると「同じ1件について2回教えられた」と
    // 誤読される。
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

  /**
   * **R7: `tool_use_id` が無い回は代用鍵（ハッシュ）が使われ、日誌にコマンド
   * 本文が出ない。**
   *
   * `#noteDenial` の代用鍵は以前 `${tool}:${brief(input, 120)}` だった——
   * `#denied` の `onForget`（`DENIED_MEMORY_LIMIT` 件を超えたら古い id を
   * 日誌へそのまま並べる）が、この鍵を**そのまま** `ids.join(', ')` で日誌へ
   * 書き出す経路を持つ（`recent.ts` の `RecentMap`）ので、鍵にコマンド本文が
   * 入っていると、記憶が上限に達した回にだけコマンド本文が日誌へ漏れていた。
   * いまは鍵が `${tool}:${digestOf(brief(input, 120))}`（sha256 先頭16桁）に
   * なっている。**これがこの PR の秘密の歯である。**
   *
   * `DENIED_MEMORY_LIMIT`（`runner.ts`）は 512。513件目を流すと最初の1件が
   * 押し出され、`onForget` が鳴る。
   */
  it('R7: id 無しの拒否が上限を超えて忘れられても、忘れた一覧の note にコマンド本文が出ない', async () => {
    const s = open();
    await s.pool.start({ request: 'いろいろやって' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const DENIED_MEMORY_LIMIT = 512;
    // 先頭の語（`echo`）は安全なので出てよいが、それに続く部分
    // （`secret-body-N`）は「コマンド本文」として一切出てはいけない。
    //
    // **`await tick()` を必ず挟む。** この足場（`fakeManagerSdk`）の
    // `push()` は、生成器がまだ前の1件を消費し終えていない（`emit` が
    // 使用済みの resolve を握ったままの）間に呼ぶと、その resolve は
    // 二度目の呼び出しが黙って無視されるため、tick を挟まずに詰めると
    // 後続のメッセージが静かに失われる（他のテストが1件ごとに
    // `await tick()` している理由と同じ）。
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

    // 忘れた鍵は `道具名:ハッシュ16桁` の形であって、コマンド本文ではない。
    expect(forgotten.text).toMatch(/Bash:[0-9a-f]{16}/);
    expect(forgotten.text).not.toContain('secret-body');

    // **日誌のどの行にもコマンド本文が出ない。** 先頭の語（`echo`）だけは
    // 形として出てよいので、それは別に確認する（意図した歯であって漏れではない）。
    const allText = entries
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''))
      .join('\n');
    expect(allText).not.toContain('secret-body');
    expect(allText).toContain('先頭の語=echo');

    await s.pool.stop();
  }, 60_000);

  /**
   * **R8: 秘密の歯（最重要）。**
   *
   * 道具の入力にトークンや URL の秘密が入っていても、日誌にも受信箱の報告にも
   * 値が漏れないことを、live → result の到着順で固定する。**ここではダミー値
   * だけを使う**（本物のトークンは書かない）。
   */
  it('R8: 秘密が入った拒否も、日誌と報告のどこにも値が漏れない', async () => {
    const s = open();
    await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // ダミー値。実物のトークンではない。
    const secretInput = {
      command: 'TOKEN=ghp_XXXXXXXXXXXX curl "https://api.example.com/?token=s3cr3t"',
    };

    // escalation（3件目で報告）を起こすため、先にダミーの拒否を2件流す。
    session.push(liveDenial('Bash', 'toolu_dummy1', { command: 'echo one' }));
    await tick();
    session.push(liveDenial('Bash', 'toolu_dummy2', { command: 'echo two' }));
    await tick();

    // 3件目が秘密入り。live（入力なし）→ result（秘密入りの入力）の順で流す
    // ——これが実機で入力が実際に現れる経路である（`liveDenialAsSdkSends` の doc）。
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

    // 秘密は漏れていないが、形（欄名と長さ）は残っていることも確かめる
    // ——「何も分からない」へ戻していないことの裏取り。
    expect(combined).toContain('欄=command');

    await s.pool.stop();
  }, 15_000);

  /**
   * **R9: escalation の段が飛ばないこと。**
   *
   * `shouldEscalateDenial` は「1ずつ増える数」を前提にしている
   * （`manager.ts` の doc）。live → result の到着順で note が1本増えても、
   * その note は `permission_denied` イベントではないので `manager.ts` の
   * カウンタには一切効かない——このことを、既存の「3件目・9件目で1度だけ
   * 上げる」テストと同じ形で、live → result の組で繰り返して固定する。
   */
  it('R9: live→result を繰り返しても escalation の段は変わらない（note は件数に効かない）', async () => {
    const s = open();
    await s.pool.start({ request: 'テストを直して' });
    const session = s.manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // **escalation の報告だけを数える。** `pushPair` は毎回ターンの完了
    // （`resultWithDenials('経過', …)`）も1本の `manager_message` として送るので
    // （既存テストの「終わった」と同じ形）、フィルタせずに数えると escalation
    // 以外の分まで拾って件数がずれる。
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
    expect(messages()).toHaveLength(0);
    await pushPair('toolu_2', { file_path: 'b.tsx' });
    expect(messages()).toHaveLength(0);

    // 3件目で1度だけ上げる（note が毎回1本増えても、この段は変わらない）。
    await pushPair('toolu_3', { file_path: 'c.tsx' });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain('3 件目');

    for (const id of ['toolu_4', 'toolu_5', 'toolu_6', 'toolu_7', 'toolu_8']) {
      await pushPair(id, { file_path: `${id}.tsx` });
    }
    expect(messages()).toHaveLength(1);

    // 9件目でもう一度（3倍ごと）。
    await pushPair('toolu_9', { file_path: 'i.tsx' });
    expect(messages()).toHaveLength(2);
    expect(messages()[1]?.text).toContain('9 件目');

    // 拒否の行は9本のまま（note は別カウントなので二重計上されない）。
    expect(await deniedLines(s.stores)).toHaveLength(9);
    // 各組で1本ずつ note が出る（live に入力が無く、result で入力が付くため）。
    expect(await noteLines(s.stores)).toHaveLength(9);

    await s.pool.stop();
  }, 15_000);
});

/**
 * **代用鍵が踏まれない前提を、SDK の型そのものへ当てる。**
 *
 * `runner.ts` の `#noteDenial` は、SDK が `tool_use_id` を寄越さなかった回だけ
 * `${tool}:${digestOf(brief(input, 120))}` を代用の鍵にする。**この代用鍵は
 * live と result で必ず食い違う** —— 走行中の合図に入力は付かず（`input` は
 * `undefined`）、ターン終わりの記録には付くので、同じ1件の拒否が別々のハッシュ
 * になる。すると重複排除が効かず `permission_denied` が2本降り、道具ごとの合計が
 * 1件の拒否で2つ増える。`shouldEscalateDenial` は `step === count` の
 * exact-equality で段（3件目・9件目…）を見ているので（`manager.ts` の doc が
 * 「1ずつ増える数」を前提だと書いている）、**段を跨いだ回はクローンへの
 * escalation が丸ごと飛ぶ。**
 *
 * **いま踏まれないのは、SDK の型が `tool_use_id` を両方で必須にしているからだけ
 * である。** 型が変われば経路は静かに開く —— そして開き方が「知らせが減る」側
 * なので、**開いても誰も気づかない。**
 *
 * ## なぜ鍵のほうを直さないか
 *
 * id が無い回に live 側が持つのは理由と分類、result 側が持つのは入力で、
 * **共有する識別子は道具の名前しか残らない。** 道具名だけで束ねると、
 * 「同じ拒否の2度目」と「live を見逃した初出」が1つに潰れる。そして SDK 自身が
 * **その両方が実際に起きうる**と書いている:
 *
 * 「Best-effort advisory: in rare races a denial can book without a frame or a frame can lack a booking twin — result.permission_denials is the authoritative record.」 [sdk-verbatim SDKPermissionDeniedMessage]
 *
 * ⟹ **どちらの「無い」も消せない。** 束ねる材料が無いので束ねず、**前提のほうへ
 * 歯を置く。**
 *
 * ## 形の選び方（`@ts-expect-error` ではなく型の値で当てる）
 *
 * この repo には `@ts-expect-error` が「不要な抑制」になった瞬間に
 * `pnpm typecheck` が落ちる形の先例が在る（`prompt.test.ts` の branded type）。
 * **ここでは採らない** —— あの形は「エラーが消えたら落ちる」ので、欄が
 * **optional になった**回は捕まえるが、欄が**丸ごと消えた**回は別のエラーに
 * すり替わって抑制が効いたままになり、緑で通る。**これは推論ではなく実測である** ——
 * `@ts-expect-error` 形の対照を1行置いて `tool_use_id` の欄ごと消す変異を当てたところ、
 * 対照はエラーを1件も出さず、下の `HasRequiredKey` だけが赤くなった（2026-09-06）。
 *
 * **欄が丸ごと消えるのは、代用鍵が常に踏まれるようになるということで、optional 化より
 * 悪い。** 下の `HasRequiredKey` は「無い」も「任意」も同じ `false` に落とすので、
 * どちらでも赤くなる。
 *
 * ## この歯が言えないこと
 *
 * **実機で分類器が Bash を止めた回に、`result.permission_denials` が本当に
 * 載ってくるかは見ていない。** 見ているのは同梱の型定義だけである（上の逐語も
 * ベンダーの主張であって、この repo の実測ではない）。
 */

/** `K` が `T` に**必須の欄として**在るか。無い欄も任意の欄も `false` に落ちる。 */
type HasRequiredKey<T, K extends PropertyKey> = K extends keyof T
  ? undefined extends T[K]
    ? false
    : true
  : false;

/** `K` が `T` の欄として在るか（必須・任意を問わない）。 */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

describe('SDK の型の前提（腐ったら typecheck が落ちる）', () => {
  it('result の記録（SDKPermissionDenial）は tool_use_id を必須で持つ', () => {
    // 必須でなくなった瞬間、この型は `false` になって代入が型エラーになる。
    const required: HasRequiredKey<SDKPermissionDenial, 'tool_use_id'> = true;
    expect(required).toBe(true);
  });

  it('走行中の合図（SDKPermissionDeniedMessage）は tool_use_id を必須で持つ', () => {
    const required: HasRequiredKey<SDKPermissionDeniedMessage, 'tool_use_id'> = true;
    expect(required).toBe(true);
  });

  it('走行中の合図は tool_input の欄を持たない（denialInputAbsence の根拠）', () => {
    // **これが `denialInputAbsence('live')` の一文の根拠である** ——
    // 「走行中の合図には入力の欄が無い」とクローンへ言い切っているので、SDK が
    // この欄を持つようになったら、あの一文は嘘になる。持った瞬間にこの型は
    // `true` になり、代入が型エラーになる。
    const present: HasKey<SDKPermissionDeniedMessage, 'tool_input'> = false;
    expect(present).toBe(false);
  });
});
