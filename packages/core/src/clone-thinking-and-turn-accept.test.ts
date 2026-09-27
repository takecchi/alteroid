import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingInboxPut,
  failingJournalAppend,
  humanMessage,
} from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForExpect,
  waitForDone,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 考えている合図（thinking）', () => {
  /**
   * `fakeSdk` は assistant(text) → result の1本道しか流せず、tool_use /
   * tool_result を混ぜられない。ここでは呼び出し側が渡した固定のメッセージ列を
   * そのまま流すだけの専用の偽 SDK をローカルに用意する
   * （既存の `fakeSdk` の振る舞いは変えない）。
   *
   * **1本目の入力にだけ台本を使い、以降は汎用の応答に落ちる。** `clone.stop()` は
   * 終了前に必ず蒸留の内部ターンをもう1本流す（生存条件）。台本を1本しか
   * 用意しないテストでその2本目が無応答のままだと `result` が来ず、
   * `stop()` が永遠に返らなくなる。
   */
  function fakeScriptedSdk(turns: SDKMessage[][]) {
    const calls: FakeCall[] = [];
    let turnIndex = 0;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = {
        options: params.options ?? {},
        inputs: [],
        kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
      };
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          call.inputs.push(String(message.message.content));
          const script = turns[turnIndex] ?? [assistantText('わかった'), resultMessage('わかった')];
          turnIndex += 1;
          yield* script;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, calls };
  }

  /** `setup` と同じ配線（本物の SDK やマネージャーを誤って起こさない）だが、queryFn だけ差し替える。 */
  function setupScripted(turns: SDKMessage[][]): Setup {
    const { fn, calls } = fakeScriptedSdk(turns);
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  function assistantText(text: string): SDKMessage {
    return {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-assistant-text',
    } as unknown as SDKMessage;
  }

  function assistantToolUse(name: string): SDKMessage {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-assistant-tool',
    } as unknown as SDKMessage;
  }

  function userToolResult(): SDKMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
      },
      parent_tool_use_id: 'tu-1',
      session_id: 'sess-fake',
      uuid: 'uuid-user-tool-result',
    } as unknown as SDKMessage;
  }

  /** 人間の発言のエコーや replay を模する（`tool_result` を含まない `user` メッセージ）。 */
  function userEcho(text: string): SDKMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-user-echo',
    } as unknown as SDKMessage;
  }

  function resultMessage(text: string): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      result: text,
      session_id: 'sess-fake',
      uuid: 'uuid-result',
    } as unknown as SDKMessage;
  }

  it('人間の発言に thinking が付き、text より先に届く', async () => {
    const s = setupScripted([[assistantText('こんにちは'), resultMessage('こんにちは')]]);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const thinkingIndex = s.events.findIndex((event) => event.type === 'thinking');
    const textIndex = s.events.findIndex((event) => event.type === 'text');
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingIndex).toBeLessThan(textIndex);

    await s.clone.stop();
  });

  it('道具の結果が返ったら thinking を送り直す（tool の合図で止まらない）', async () => {
    const s = setupScripted([
      [
        assistantToolUse('shell'),
        userToolResult(),
        assistantText('できた'),
        resultMessage('できた'),
      ],
    ]);

    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    const toolIndex = s.events.findIndex((event) => event.type === 'tool');
    expect(toolIndex).toBeGreaterThanOrEqual(0);

    const after = s.events.slice(toolIndex + 1);
    const thinkingAfterToolIndex = after.findIndex((event) => event.type === 'thinking');
    const textAfterToolIndex = after.findIndex((event) => event.type === 'text');
    expect(thinkingAfterToolIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingAfterToolIndex).toBeLessThan(textAfterToolIndex);

    await s.clone.stop();
  });

  it('tool_result を含まない user メッセージでは thinking を送らない', async () => {
    const s = setupScripted([
      [userEcho('やあ'), assistantText('こんにちは'), resultMessage('こんにちは')],
    ]);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    // #runTurn が入力を渡した時点の1回だけで、tool_result を含まない
    // user メッセージ（エコー）からは増えない。
    const thinkingCount = s.events.filter((event) => event.type === 'thinking').length;
    expect(thinkingCount).toBe(1);

    await s.clone.stop();
  });

  /**
   * **日誌が書けなくても会話は続く。だが跡は残る。**
   *
   * 跡が無いと、日誌は判別器として静かに嘘をつく — 「日誌に無い」が
   * 「起きなかった」と読めてしまう。しかも一番書けなくなりやすいのは
   * 片付けの途中（ストアを閉じた後）＝一番調べたい時間帯である。
   *
   * 同時に、**跡に本文が乗らないこと**も固定する。ここを緩めると、日誌にすら
   * 入らなかった秘密がホスティング先のログに出る（#52 と同じ形）。
   */
  it('日誌が書けなくても会話は続き、落としたことが stderr に残る（本文は出さない）', async () => {
    const stores = failingJournalAppend(createMemoryStores(), 'storage is closed');
    const s = setup(() => 'こんにちは', stores);

    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage('鍵は ghp_000000000000000000000000000000000000 だ'));
      await waitForDone(s.events);
      await s.clone.stop();
    });

    // 記録できないことでセッションを殺さない（この判断は変えていない）
    const shown = s.events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(shown).toBe('こんにちは');

    const dropped = lines.filter((line) => line.includes('日誌を記録できませんでした')).join('');
    expect(dropped).not.toBe('');
    expect(dropped).toContain('storage is closed');
    expect(dropped).toContain('exchange');
    expect(dropped).not.toContain('ghp_');
  });

  /**
   * **止まった後に届いたものは処理できない。だが跡は残る。**
   *
   * `post` は7種類の起点（人間の発言・外部イベント・timer・発意・runner の
   * 通知・マネージャーの報告/質問/許可確認・人間の承認回答）が通る1本道である。
   * ここで黙って消えると、「受信箱に積まれたまま死んだ」「閉じた後に届いた」
   * 「ターンが間に合わなかった」が日誌の上で同じ形になり、切り分けられない。
   *
   * 跡が stderr なのは、この窓が `storage.close()` → `process.exit(0)` の窓
   * そのものだからである（非同期の日誌書き込みは間に合う保証が無い）。
   * 同時に**跡に本文が乗らないこと**も固定する — テスト出力に `GH_TOKEN` が
   * 全文で出た前例がある（`railway/setup.test.ts` の差分アサーション、#52）。
   *
   * **【経緯・期待値を反転した】** ここは元々「捨てる」ことを仕様として固定して
   * いた。その根拠は「処理しようとすると『未読の永続化』という別の設計になる」で
   * あり、当時それは正しかった。**その設計は後から入った**（`#remember` と
   * `#restoreUnread`）ので、根拠のほうが先に消えていた。片付けの窓に落ちた人間の
   * 最後の一言は、いちばん気づかれない失われ方をする。
   *
   * 上の段落の「ここで黙って消えると〜」以下は**そのまま効いている**（跡を残す
   * ことと本文を出さないことは何も変わっていない）。増えたのは、跡に加えて
   * **器にも残す**という保証である。**保証が減っていないこと**を見やすくするため、
   * 元の検証（跡が2行・本文が出ない・時刻が付く・1行に収まる）は1つも消して
   * いない。
   */
  it('止まった後に届いた合図は器へ残し、何が来たかが stderr に残る（本文は出さない）', async () => {
    const s = setup();
    await s.clone.stop();

    const lines = await captureStderr(() => {
      s.clone.post(humanMessage('鍵は ghp_000000000000000000000000000000000000 だ'));
      s.clone.post({
        type: 'manager_message',
        id: 'evt-report',
        at: new Date().toISOString(),
        managerId: 'mgr-1',
        kind: 'report',
        text: 'PR #99 をマージした。鍵は ghp_000000000000000000000000000000000000',
      });
    });

    const dropped = lines.filter((line) => line.includes('このプロセスでは処理しませんでした'));
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain('human_message');
    // どのマネージャーの、どの種類の一件だったかは残る
    expect(dropped[1]).toContain('manager_message managerId=mgr-1 kind=report');
    for (const line of dropped) {
      expect(line).not.toContain('ghp_');
      // 「いつ」。ホスティング先の付ける時刻に頼らない
      expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
    }

    // **跡だけでは足りない。** 次の起動で配り直せる形で器に残っていること。
    // 書き込みは非同期なので、`post` が返った直後には間に合っていない
    await waitFor(async () => (await s.stores.inbox.claimPending()).length === 2, '未読の書き出し');

    // 引き受けた仕事としても載る（人間の最後の一言が、跡だけになって消えない）
    const open = (await s.stores.commitments.list()).entries;
    expect(open.map((entry) => entry.origin)).toEqual(['human', 'manager']);
    // 本文は器の中には**入る**（拾い直せなければ意味が無い）。出さないのは stderr の側だけ
    expect(open[0]?.body).toContain('ghp_');
  });

  /**
   * **片付けの窓（止まった後）でストアへの拾い直しが尽きたら、跡は
   * 「失われた」と名乗ること（issue #1144）。**
   *
   * 直上の歯（`ghp_…` の2件）は `stores.inbox.put` が成功する前提で、
   * 「器へは残る」ところまでしか確かめていない。ここは `put` そのものを
   * 無条件で失敗させ、`REMEMBER_RETRY_ATTEMPTS` を使い切らせる——この窓
   * （`this.#stopped || this.#inbox.closed`）は `#inbox.push` を一度も
   * 通らないので、拾い直しが尽きた合図はストアにもメモリの待ち行列にも
   * 無く、本当に失われる。PR #1118（issue #1085）はこの経路でも
   * 通常経路と同じ「ただし失ってはいない」を名乗っていた——それが嘘に
   * なることが issue #1144 の指摘であり、ここが直った証拠になる。
   */
  it('片付けの窓（止まった後）で書き込みが尽きたら、跡は「失われた」と名乗る（issue #1144）', async () => {
    const stores = failingInboxPut(createMemoryStores(), '器が閉じている');
    const s = setup(undefined, stores);
    await s.clone.stop();

    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';
    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage(secret));
      // 拾い直しの間隔（`REMEMBER_RETRY_MS` × (1+2) ≒ 600ms）ぶん待って
      // 諦めきるのを待つ（`inbox-persistence.test.ts` の issue #1085 の歯と
      // 同じ待ち方）。
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    const trace = lines.filter((line) => line.includes('未読の合図をストアへ書けませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('器が閉じている');
    // **通常経路の文言は使わない。** この窓は `#inbox.push` を一度も通らない
    // ので、「メモリの待ち行列には残っており」は嘘になる（issue #1144）。
    expect(trace[0]).not.toContain('ただし失ってはいない');
    expect(trace[0]).not.toContain('メモリの待ち行列には残って');
    expect(trace[0]).toContain('この合図は失われた');
    // 本文は出さない（テスト出力に GH_TOKEN が全文で出た前例がある。#52）。
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    // 長さだけは出す（「空だった」と「書けなかった」の区別が付く）。
    expect(trace[0]).toContain(`chars=${secret.length}`);
  }, 10_000);
});

/**
 * 人間の発言が日誌へ載る時点と、その瞬間に出す合図。
 *
 * **「一件ずつ判断する」と「発言の記録も一件ずつ待たせる」は別のことである。**
 * ターンの直列は意図された設計（`docs/architecture.md` の同時実行モデル）だが、
 * 記録をその直列の後ろに置いていたのは帰結であって設計ではなかった。後ろに置くと、
 * 先客（蒸留・マネージャーとの往復・自律の起点）が走っているあいだ**日誌にその
 * 発言が存在しない** — 日誌から組み立てる `GET /conversations` にも出ないので、
 * 器（端末・タブ・アプリ）を替えた人からは発言そのものが消えて見える。
 *
 * ここで固定するのは「直列を壊さずに記録だけを前へ出した」ことである。
 */
describe('クローン — 発言を受理した瞬間の記録と合図', () => {
  /**
   * 1本目のターンを、明示的に解くまで握ったままにする偽 SDK。
   *
   * **時間で近似しない。** 「先客のターンが走っているあいだに届いた発言」を
   * `delayMs` で作ると、遅延の長さと poll の待ち時間の綱引きになる（速い器で通り、
   * 遅い器で落ちる）。止めたターンを明示的に解く形にすれば、「順番待ちのあいだ」を
   * 時計から切り離せる。
   */
  function fakeGatedSdk() {
    const calls: FakeCall[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let held = true;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = {
        options: params.options ?? {},
        inputs: [],
        kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
      };
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          // **本文を控えてから止める。** 止めてから控えると「ターンが始まった」を
          // テストから観測できず、順番待ちを作れたことが確かめられない。
          call.inputs.push(String(message.message.content));
          if (held) await gate;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return {
      fn,
      calls,
      /** 握っていたターンを解く。以降のターンは止まらない（`stop()` の蒸留が返る）。 */
      release: () => {
        held = false;
        open();
      },
    };
  }

  interface Gated {
    clone: CloneHost;
    stores: Stores;
    calls: FakeCall[];
    release: () => void;
  }

  function setupGated(stores: Stores = createMemoryStores()): Gated {
    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls, release };
  }

  /** 先客の内部ターンを走らせたまま止める（＝以後に届く発言は順番待ちになる）。 */
  async function occupy(gated: Gated): Promise<void> {
    gated.clone.post({
      type: 'self_initiative',
      id: 'evt-busy',
      at: new Date().toISOString(),
      reason: '先客のターン',
    });
    await waitFor(() => (gated.calls[0]?.inputs ?? []).length === 1, '1本目の入力');
    expect((gated.calls[0]?.inputs ?? []).length).toBe(1);
  }

  /**
   * 追記の1本目だけを遅らせる（受理の瞬間の追記だけが遅い形）。
   *
   * 全部を等しく遅らせると、受理の瞬間に書き始める側と応答を待ってから書く側の
   * 差が出ない（どちらも同じだけ遅れて着順は変わらない）。
   */
  function delayFirstJournalAppend(stores: Stores, delayMs: number): Stores {
    let first = true;
    return {
      ...stores,
      journal: {
        ...stores.journal,
        async append(entry) {
          if (first) {
            first = false;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return stores.journal.append(entry);
        },
      },
    };
  }

  async function inboundTexts(stores: Stores): Promise<string[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as {
      role: string;
      text: string;
    }[];
    return entries.filter((entry) => entry.role === 'inbound').map((entry) => entry.text);
  }

  it('順番待ちのあいだに日誌へ載る（ターンが回るのを待たない）', async () => {
    const gated = setupGated();
    await occupy(gated);

    gated.clone.post(humanMessage('MSG-WAITING', 'conv-2'));

    // 先客のターンは握ったまま。**ここで載ることがこの直しの主題である。**
    await waitFor(
      async () => (await inboundTexts(gated.stores)).includes('MSG-WAITING'),
      'MSG-WAITING が台帳へ届く',
    );
    expect(await inboundTexts(gated.stores)).toContain('MSG-WAITING');
    // 載ったのは順番が来たからではない（この発言はまだモデルへ渡っていない）。
    expect(gated.calls[0]?.inputs).toHaveLength(1);

    gated.release();
    await gated.clone.stop();
  }, 10_000);

  it('日誌には一度だけ載る（受理の瞬間とターンの入口で二重に書かない）', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('MSG-ONCE'));
    await waitForDone(s.events);

    expect((await inboundTexts(s.stores)).filter((text) => text === 'MSG-ONCE')).toHaveLength(1);

    await s.clone.stop();
  });

  it('`queued` は受理したその同期の中で届く（往復を待たない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    // **`await` を1つも挟まない。** `post` から戻った時点で既に届いていること。
    expect(s.events).toEqual([{ type: 'queued' }]);

    await waitForDone(s.events);
    await s.clone.stop();
  });

  it('順番待ちのあいだ `thinking` は来ない（2つの状態を1つの語に潰していない）', async () => {
    const gated = setupGated();
    const { events } = wireEvents(gated.clone, 'conv-2');
    await occupy(gated);

    gated.clone.post(humanMessage('MSG-QUEUED', 'conv-2'));

    // 受理はされている（`queued`）。だが誰も考えていない（`thinking` は無い）。
    expect(events.map((event) => event.type)).toEqual(['queued']);

    gated.release();
    await gated.clone.stop();
  }, 10_000);

  it('順番が来たら `thinking` が続く（`queued` を置き換えるのではなく後に来る）', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const types = s.events.map((event) => event.type);
    expect(types.indexOf('queued')).toBe(0);
    expect(types.indexOf('thinking')).toBeGreaterThan(0);

    await s.clone.stop();
  });

  it('追記が遅くても、発言は応答より先に日誌へ載る', async () => {
    // 待たずにターンを走らせると、短いターンでは応答の追記が先に着き、**日誌の上で
    // クローンが問われる前に答えたことになる**。追記の順序が会話の順序である
    // （`GET /conversations` は並べ直さない）ので、ここは着順で守る。
    const s = setup(() => 'こんにちは', delayFirstJournalAppend(createMemoryStores(), 200));

    s.clone.post(humanMessage('MSG-ORDER'));
    await waitForDone(s.events);

    // `list` は新しい順。
    // **`with: ['human']` で絞る（Issue #1060）。** `#commit` 段1 が足す
    // `exchange with=self` の1行と混ざると、この歯が測りたい「人間との往復の
    // 着順」が読み取れなくなる（上の「人間の発言に応答し、往復が日誌に残る」の
    // 歯と同じ理由）。
    const roles = (
      (await s.stores.journal.list({ types: ['exchange'], with: ['human'] })) as {
        role: string;
      }[]
    ).map((entry) => entry.role);
    expect(roles).toEqual(['outbound', 'inbound']);

    await s.clone.stop();
  }, 10_000);

  it('2発言が続けて届いても、日誌には受け取った順で載る', async () => {
    // 追記が `#pump` の中に在ったあいだ、この直列は受信箱のループが与えていた。
    // 受理の瞬間へ移した以上、**2本の追記が同時に飛ぶ**（`PgJournalStore` は
    // 自分で直列化していない）。1本目だけを遅くして、着順が入れ替わらないかを見る。
    const s = setup(() => 'こんにちは', delayFirstJournalAppend(createMemoryStores(), 200));

    s.clone.post(humanMessage('MSG-FIRST', 'conv-1'));
    s.clone.post(humanMessage('MSG-SECOND', 'conv-1'));

    // `list` は新しい順なので、受け取った順に入っていれば後の発言が先に出る。
    await waitForExpect(
      async () => expect(await inboundTexts(s.stores)).toEqual(['MSG-SECOND', 'MSG-FIRST']),
      '受信テキストが並び替わって2件揃う',
    );

    await s.clone.stop();
  }, 10_000);

  it('日誌へ書けなくても応答は返る（記録できないことで応答を止めない）', async () => {
    const stores = failingJournalAppend(createMemoryStores(), '器が閉じている');

    await captureStderr(async () => {
      const s = setup(() => 'こんにちは', stores);
      s.clone.post(humanMessage('やあ'));
      // 落ちるなら `waitForDone` が投げる。
      await waitForDone(s.events);
      expect(s.events.some((event) => event.type === 'done')).toBe(true);
      await s.clone.stop();
    });
  });

  it('ターンが失敗しても、発言そのものは日誌に残る（#59 の保証を落とさない）', async () => {
    const stores = createMemoryStores();
    // 聞き手の居ない会話（`setup` が購読するのは conv-1 だけ）で、ターンを失敗させる。
    const s = setup(undefined, stores, { failWith: 'セッションを起こせない' });

    s.clone.post(humanMessage('MSG-FAILED', 'conv-9'));

    await waitFor(
      async () => (await inboundTexts(stores)).includes('MSG-FAILED'),
      'MSG-FAILED が台帳へ届く',
    );
    expect(await inboundTexts(stores)).toContain('MSG-FAILED');

    await s.clone.stop();
  });

  it('人間以外の起点は起点ごとの型のまま（受理の瞬間へ寄せていない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '見た', stores);

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: 'MSG-REPORT',
    });

    await waitForExpect(
      async () =>
        expect(
          (await stores.journal.list({ types: ['exchange'] })).filter(
            (entry) => entry.type === 'exchange' && entry.with === 'manager',
          ).length,
        ).toBe(1),
      'manager 向け exchange が1件、日誌に積まれる',
    );

    await s.clone.stop();
  });
});

/**
 * クローン自身の消費を台帳へ載せる。
 *
 * **ここが無かったことが依頼の出発点である。** `clone.ts` の `case 'result'` は
 * 本文を日誌へ書くだけで `modelUsage` を1バイトも読んでいなかった。人間は
 * `claude.ai/settings/usage` で自分の消費を見られるのだから、その写像である
 * クローンが自分の分を読めないのは能力の削除である（north_star 禁止1）。
 */
