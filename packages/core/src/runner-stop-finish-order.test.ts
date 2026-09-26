import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * **Issue #1533 の「測り方の案 1」の実装。⛔ これは測定であって修正ではない。**
 *
 * `RunnerSession` には畳む手続きが2本ある（`stop()` と `#finish()`）。#1533 は、
 * 2026-09-25 観測の時点でこの2本が部品はほぼ同じだが並びが違うことを指摘した
 * （`shipArchive`/`flushUnreported` と `query.close()` の前後・`settleAll` の位置・
 * `noteUnclassifiedFailuresSummary` と `flushUsage` の前後の3点）。
 *
 * **このファイルが固定するのは「いま実際にどう並んでいるか」だけである。**
 * どちらの並びが正しいか・揃えるべきかは一切主張しない（オーナー判断待ち、
 * Issue #1533 本文）。**このテストが赤くなったら「順序が変わった」という事実
 * だけを報告し、直す・戻すの判断はオーナーに委ねること。**
 *
 * **2026-09-25 追記: 上の3点のうちオーナーが選んだ形が入った。** `stop()` の
 * `#shipArchive`/`#flushUnreported` を `query.close()` → `await this.#reader`
 * の後ろへ動かした（`#settleAll` の位置はそのまま）。**これは「揃えた」の
 * ではなく「報告を後ろへ動かした」結果、経路Aの並びが経路Bの並びに実質的に
 * 近づいた形である**（PR 本文に同じ断り書きがある）。下の `経路A（stop()）`
 * と `(a)〜(c)` のテストは、この変更を受けて期待値を書き換えてある——元の
 * 期待値・コメントは各テストに history として残してある。
 *
 * ## 何を1本の時系列に積むか
 *
 * `RunnerHost` の `emit` コールバックが呼ばれた順に、そのまま `timeline` へ
 * 積む（`RunnerEvent.type` を主に、`closed`/`report`/`settled` は区別のため
 * 値も添える）。加えて、偽 SDK の `Query#close()` が呼ばれた瞬間にも
 * `'query.close()'` を同じ配列へ積む——`emit` も `close()` もどちらも同期関数
 * で、JS はシングルスレッドなので、**この1本の配列に積まれた順序がそのまま
 * 実際に呼ばれた順序である**（`usage-flush.test.ts` の `order` と同じ発想。
 * あちらは `'usage'` / `'close'` の2値だけだったが、ここでは全種類を1本に
 * まとめる）。
 *
 * `onClosed`（`Host` 側が `#sessions` から削除する側）はこの配列には現れない
 * ——`emit` を経由しないからである。**その位置は間接的に確かめる**——
 * 最後に積まれたイベントの `emit` コールバックの中で `host.list()` を覗くと、
 * その時点ではまだ削除されていない（`onClosed()` は最後の `emit` の**次の**
 * 同期文なので、コールバックの中では絶対にまだ実行されていない）。そして
 * `stop()`/`#finish` を待ち終えた後（またはイベントを検知した後）に
 * `host.list()` を見ると消えている。これで「最後の emit より後、待ち終える
 * までの間のどこか」までは絞れる——**1呼びの中のどちらが先かという精度では
 * 測れていない**（詳しくは下の `AGENTS.md` 断り）。
 *
 * ## 足場について
 *
 * `say`/`finish`/`end`/`crash` は `runner-unreported.test.ts` の `fakeSdk`、
 * `postToolUse`/`askPermission` は `runner-archive-leg.test.ts` の
 * `fakeSdk`、`taskStarted` は `runner-wakeup.test.ts` の `fakeSdk` をそれぞれ
 * 真似た（このリポジトリの既存の型・組み立て方に倣う）。
 */

interface FakeSession {
  options: Options;
  /** マネージャーが本文を1つ喋る。積んだ本文を運ぶ assistant メッセージの uuid を返す。 */
  say(text: string): Promise<string>;
  /** PostToolUse フックを鳴らす（`transcript_path` を控えさせるため）。 */
  postToolUse(input: Record<string, unknown>): Promise<unknown>;
  /** `canUseTool` を直接叩き、確認を1件積む。settle するまで解決しない。 */
  askPermission(toolName: string, requestId: string): Promise<PermissionResult>;
  /** `system/task_started` を流し、作業者を待つ窓を開く。 */
  taskStarted(taskId: string): Promise<void>;
  /**
   * ストリームが `result` を伴わずに自然終了する（SDK 側が黙って閉じる）。
   * `#read` の `for await` がそのまま抜け、`#finish('done', …)` へ落ちる
   * ——**この歯が選んだ「経路B」の代表**（下の doc を見よ）。
   */
  end(): void;
  /**
   * `deferCloseEnd: true` のときだけ意味を持つ。**`Query#close()` が呼ばれても
   * ストリームをまだ終わらせない**（本物の SDK が `close()` の後も CLI の
   * 終了・生ログの書き切りを待つ「やわらかい停止」を模す——PR 本文の
   * 「未確認の前提」）。この呼び出しで初めてストリームを終える。
   */
  endAfterClose(): void;
  /**
   * `deferCloseEnd: true` のときだけ意味を持つ。`endAfterClose()` の代わりに
   * ——ストリームを**例外で**終わらせる。`close()` を呼んだこと自体とは
   * 独立の、transport 側の故障（壊れた pipe 等）を模す（Issue #1533 の
   * SDK 調査コメント: 本物の `Query#close()` は `inputStream.done()` で
   * 正常終了させるだけで、例外にするのは `readMessages()` の別ループの
   * catch である）。Issue #1589 / PR #1590 が固定した「`stop()` の後にこれが
   * 起きても `#finish('failed', …)` は呼ばれない」を、#1533 の並べ替え後の
   * 形（生ログ・報告が `#reader` の後ろ）でも保つことを確かめる歯専用。
   */
  crashAfterClose(reason: string): void;
  /**
   * **Issue #1597 専用。** `result` を、成功ではない `subtype`（既定は
   * `error_during_execution`）かつ `session_id` を伴って流す——resume 直後で
   * まだ一度も手が動いていない状態でこれを受けると、`#apply` の
   * `case 'turn_ended'` は `#recoverFromFailedResume` を `unresumable` と
   * 判定し、`void this.#finish('lost', …)` を**待たずに**発火して次のメッセージ
   * 待ちへ戻る（`runner.ts` の当該コメント「他5箇所のように `await` へ揃える
   * ことはしていない」）。**同期関数**（`say`/`taskStarted` と違い、呼んだ後に
   * 一呼吸置かない）——呼んだ直後に `host.stop()` を重ねることで、Issue の
   * 再現手順（`session.finish(...)` の直後に `await host.stop(...)`）と同じ
   * 「`#finish('lost', …)` が完了する前に `stop()` が割り込む」窓を作る。
   */
  resultFailed(text: string, subtype?: string): void;
}

/**
 * @param onClose `Query#close()` が呼ばれた瞬間に鳴らす（timeline へ積むため）。
 * @param testOptions.deferCloseEnd `true` なら `close()` が呼ばれても
 *   `for await` を終わらせない——`FakeSession#endAfterClose()` を呼ぶまで
 *   `#reader` は生きたままになる。新しい歯（「archive は #reader の終わりの
 *   後」）専用。既定 (`false`) は他のテストと同じ「`close()` が即座に終わらせる」
 *   動き。**名前を `testOptions` にしてあるのは、下の `params.options`（SDK の
 *   `Options`）と同じ名前にすると後者にシャドウされて無効化されるため**
 *   （実装中に一度その事故を踏んで直した——`options` という名前は下で
 *   `const options = params.options ?? {};` として再定義される）。
 */
function fakeSdk(
  onClose: () => void,
  testOptions: { deferCloseEnd?: boolean } = {},
): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  let sayCounter = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    let fail: ((error: unknown) => void) | null = null;
    const buffered: SDKMessage[] = [];

    const push = (message: SDKMessage | null) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        fail = null;
        resolve(message);
      } else if (message !== null) {
        buffered.push(message);
      }
    };

    const session: FakeSession = {
      options,
      async say(text) {
        sayCounter += 1;
        const uuid = `uuid-say-${String(sayCounter)}`;
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-mgr',
          uuid,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return uuid;
      },
      async postToolUse(input) {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        return hook(input as never, undefined, { signal: new AbortController().signal } as never);
      },
      async askPermission(toolName, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const result = await canUseTool(toolName, { command: 'rm -rf /' }, {
          signal: new AbortController().signal,
          requestId,
          toolUseID: `tool-${requestId}`,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した');
        return result;
      },
      async taskStarted(taskId) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      end() {
        push(null);
      },
      endAfterClose() {
        push(null);
      },
      crashAfterClose(reason) {
        if (fail) {
          const reject = fail;
          emit = null;
          fail = null;
          reject(new Error(reason));
        }
      },
      resultFailed(text, subtype = 'error_during_execution') {
        push({
          type: 'result',
          subtype,
          is_error: true,
          result: text,
          session_id: 'sess-mgr',
          uuid: 'uuid-result-failed',
        } as unknown as SDKMessage);
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve, reject) => {
          emit = resolve;
          fail = reject;
        });
        emit = null;
        fail = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        onClose();
        if (testOptions.deferCloseEnd) return;
        push(null);
      },
      interrupt: async () => undefined,
      // **`#flushUsage()` の材料。** 常に非ゼロの消費を返す——`readSessionUsage`
      // は「全部ゼロなら降ろさない」ので、これが無いと `usage` が1本も
      // timeline に乗らない（`usage-flush.test.ts` の `getUsageResponse` と
      // 同じ形）。
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        session: {
          total_cost_usd: 0.1,
          total_api_duration_ms: 0,
          total_duration_ms: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
          model_usage: {
            'claude-opus-4-8': {
              inputTokens: 10,
              outputTokens: 10,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.1,
              contextWindow: 200_000,
              maxOutputTokens: 64_000,
            },
          },
        },
        subscription_type: 'max',
        rate_limits_available: false,
        rate_limits: null,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];
let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-stop-finish-order-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

/** `timeline` に積むための1行を作る。区別に要る値だけ添える。 */
function labelOf(event: RunnerEvent): string {
  switch (event.type) {
    case 'closed':
      return `emit:closed(status=${event.status})`;
    case 'report':
      return `emit:report(status=${event.status},unreported=${String(event.unreported !== undefined)})`;
    case 'settled':
      return `emit:settled(requestId=${event.requestId})`;
    case 'worker_wait':
      return `emit:worker_wait(settled=${String(event.settled)})`;
    case 'archive':
      return `emit:archive(len=${String(event.body.length)})`;
    case 'usage':
      return 'emit:usage';
    case 'ask':
      return `emit:ask(requestId=${event.requestId})`;
    default:
      return `emit:${event.type}`;
  }
}

/**
 * `host` と、`emit`/`Query#close()` の両方が同じ1本へ積む `timeline` を作る。
 *
 * **`host.list()` を覗く仕掛けもここに入れる**——`onClosed` の位置を間接的に
 * 確かめるため（ファイル冒頭の doc）。`snapshotStillListed` は「この emit の
 * 時点でまだ `host.list()` に載っているか」を記録する——載っていれば
 * `onClosed` はまだ呼ばれていない証拠になる。
 */
function setup(sdkOptions: { deferCloseEnd?: boolean } = {}): {
  host: RunnerHost;
  events: RunnerEvent[];
  timeline: string[];
  sessions: FakeSession[];
  stillListedAtLastEmit: () => boolean;
  /**
   * **仕込み（say/postToolUse/taskStarted/askPermission）が積んだ雑音を消す。**
   *
   * `session`（起動時の system/init）・`tool_use`（`postToolUse` を鳴らした
   * ことそのもの）・`ask`（確認を1件積んだこと）は、この歯が測りたい「畳む
   * ときの並び」より前の、状態づくりの一部である。畳む手続き
   * （`stop()`/`#finish()`）を呼ぶ直前にここで切り詰め、**そこから先だけ**を
   * characterization の対象にする。
   */
  resetTimeline: () => void;
} {
  const events: RunnerEvent[] = [];
  const timeline: string[] = [];
  const managerId = 'mgr-1';
  const { fn, sessions } = fakeSdk(() => timeline.push('query.close()'), sdkOptions);
  let stillListedAtLastEmit = false;

  const host = createRunnerHost({
    runnerId: 'runner-order-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      timeline.push(labelOf(event));
      // **`onClosed()` はこの関数呼び出しの外（呼び出し元の次の同期文）でしか
      // 起こらない。** だからここで観測できるのは「まだ削除されていない」側
      // だけである——常に true になるはずで、崩れたら仮定そのものが壊れている。
      stillListedAtLastEmit = host.list().some((m) => m.managerId === managerId);
    },
    queryFn: fn,
    env: {},
  });
  hosts.push(host);
  return {
    host,
    events,
    timeline,
    sessions,
    stillListedAtLastEmit: () => stillListedAtLastEmit,
    resetTimeline: () => {
      timeline.length = 0;
    },
  };
}

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

/**
 * 共通の初期状態を作る(issue #1533 の「測り方の案 1」が指定する4条件)。
 *
 * 1. 喋った本文が有る（`result` が来ていない）—— `say()`
 * 2. 未決の確認が1件有る —— `askPermission()`（settle するまで解決しない）
 * 3. 作業者を待つ窓が開いている —— `taskStarted()`（通知を送らないので開いたまま）
 * 4. 生ログの在り処が分かっている —— `postToolUse()` に実在するファイルの
 *    `transcript_path` を持たせる
 */
async function primeState(
  session: FakeSession,
  transcriptPath: string,
): Promise<{ askPromise: Promise<PermissionResult>; saidUuid: string }> {
  const saidUuid = await session.say('畳まれる前に喋った本文');
  await session.postToolUse({
    tool_name: 'Bash',
    tool_input: {},
    transcript_path: transcriptPath,
  });
  await session.taskStarted('task-1');
  // settle するまで解決しない——ここでは await しない。
  const askPromise = session.askPermission('Bash', 'req-1');
  // `canUseTool` 内部の Promise 生成・`#pending` への push が終わるのを待つ
  // ための一呼吸（他の3つと同じく同期的に処理されるが、`askPermission` 自体は
  // async 関数なので、呼び出し直後は pending の可能性がある）。
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { askPromise, saidUuid };
}

describe('#1533: stop() と #finish の畳みの順序を、現状のまま固定する（characterization。正しさは主張しない）', () => {
  it('経路A（stop()）: いまの呼び出し順序', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-a.jsonl');
    const archivedBody = '経路Aの生ログ本文';
    writeFileSync(transcriptPath, archivedBody, 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);
    // ここから先だけを畳む手続きの並びとして固定する（雑音の除去は setup() の doc）。
    s.resetTimeline();

    await s.host.stop('mgr-1');
    const settledAnswer = await askPromise;

    // --- 生の時系列（そのまま報告へ載せる） -----------------------------
    console.log('経路A timeline:', JSON.stringify(s.timeline));

    // **characterization —— 現状の並びをそのまま固定する。**
    // ⛔ この配列が変わったら「順序が変わった」という事実だけを報告し、直す
    // ・戻すの判断はしない（ファイル冒頭の doc）。
    //
    // **2026-09-25 追記（Issue #1533 の直し）。** 元は次の並びだった:
    //
    // ```
    // 'emit:usage', 'emit:worker_wait(settled=false)', 'emit:archive(len=9)',
    // 'emit:report(status=waiting_human,unreported=true)',
    // 'emit:settled(requestId=req-1)', 'query.close()',
    // ```
    //
    // `stop()` の `#shipArchive`/`#flushUnreported` を `query.close()` →
    // `await this.#reader` の後ろへ動かした（生ログを CLI の読み手が終わって
    // から読む——PR 本文の「未確認の前提」を見よ）ことで、下の並びへ変わった。
    // `#settleAll` の位置そのものは動かしていない——動いたのは
    // `archive`/`report` の側で、結果として `settled` より後ろへ回った。
    //
    // **`status` が `waiting_human` から `running` に変わった理由も同じ移動の
    // 副作用である。** `#onPermission` が確認を積んだ時点で
    // `#status = 'waiting_human'` になり、`settle()` は「`waiting_human` かつ
    // `#pending` が空になった」時点で `running` へ戻す
    // （`packages/core/src/runner.ts` の `settle:` コールバック）。以前は
    // `#flushUnreported` が `settleAll` より先に走っていたので、まだ
    // `waiting_human` のまま報告していた。いまは `settleAll` が先に確認を
    // deny で解いてから `#flushUnreported` が走るので、報告の時点ではもう
    // `running` に戻っている——クローンへ届く報告としては、むしろこちらの方が
    // 「もう確認は待っていない」という実情に合っている。
    //
    // **2026-09-26 追記: オーナーはこの判断を採らなかった。** 「報告は
    // stop が指示された時点の状態を名乗る」という以前の挙動を保つ方を選び、
    // `stop()` の入口（`#stopped = true` の直後、`#settleAll` より前）で
    // `this.#status` を `statusAtStop` として控え、`#flushUnreported` には
    // その控えた値を渡す形に直した（`runner.ts` の `stop()` 冒頭のコメントを
    // 見よ）。だから `status` は `waiting_human` のまま——上の「むしろ実情に
    // 合っている」という判断は、実装のログとして残すが不採用である。
    expect(s.timeline).toEqual([
      'emit:usage',
      'emit:worker_wait(settled=false)',
      'emit:settled(requestId=req-1)',
      'query.close()',
      'emit:archive(len=9)',
      'emit:report(status=waiting_human,unreported=true)',
    ]);

    // stop() は closed を emit しない（doc「あちらは closed すら出さない」）。
    expect(s.events.some((e) => e.type === 'closed')).toBe(false);

    // settleAll が deny で解決する。`message` は stop() が渡した理由そのもの。
    expect(settledAnswer).toEqual({
      behavior: 'deny',
      message: 'デーモンから停止を指示された。',
    });

    // onClosed の間接観測: 最後の emit の時点ではまだ list に残っている。
    expect(s.stillListedAtLastEmit()).toBe(true);
    // stop() を待ち終えた後には消えている。
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);
  });

  it('経路B（#finish、ストリームが自然終了する代表経路）: いまの呼び出し順序', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-b.jsonl');
    const archivedBody = '経路Bの生ログ本文';
    writeFileSync(transcriptPath, archivedBody, 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);
    s.resetTimeline();

    session.end();
    await vi.waitFor(() => {
      if (!s.events.some((e) => e.type === 'closed')) throw new Error('closed がまだ来ていない');
    });
    const settledAnswer = await askPromise;

    console.log('経路B timeline:', JSON.stringify(s.timeline));

    expect(s.timeline).toEqual([
      'emit:usage',
      'emit:worker_wait(settled=false)',
      'emit:settled(requestId=req-1)',
      'query.close()',
      'emit:archive(len=9)',
      'emit:report(status=done,unreported=true)',
      'emit:closed(status=done)',
    ]);

    expect(settledAnswer).toEqual({
      behavior: 'deny',
      message: 'マネージャーのセッションが閉じた。',
    });

    expect(s.stillListedAtLastEmit()).toBe(true);
    await vi.waitFor(() => {
      if (s.host.list().some((m) => m.managerId === 'mgr-1')) {
        throw new Error('まだ list に残っている');
      }
    });
  });
});

/**
 * **(a)〜(e) を実測で答える歯。** 上の2本（timeline の `toEqual`）が正本で、
 * ここは同じ実測から導ける具体的な問いに答え直す形の歯である——`toEqual` の
 * 生の並びだけでは「report は close の前か後か」のような問いに一目で答え
 * にくいので、同じ状態から取り直して個別に検算する。
 */
describe('#1533 (a)〜(e): 観測できる差があるかどうか', () => {
  it('(a) report の emit は query.close() の前か後か——#1533 の直しで揃った（以前は経路で違った）', async () => {
    // **2026-09-25 追記（Issue #1533 の直し）。** このテストは元は
    // 「経路A: report が close より前 / 経路B: report が close より後」という
    // **食い違い**を固定していた（タイトルも「経路で違う」だった）。`stop()` の
    // `#shipArchive`/`#flushUnreported` を `query.close()` → `await this.#reader`
    // の後ろへ動かしたことで、経路Aも「report は close より後」になり、
    // **この食い違いそのものが無くなった**——揃えるのが直しの目的だったので、
    // ここでは「揃っている」ことを固定し直す。

    // 経路A
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const reportIdxA = a.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closeIdxA = a.timeline.indexOf('query.close()');
    expect(reportIdxA).toBeGreaterThanOrEqual(0);
    expect(closeIdxA).toBeGreaterThanOrEqual(0);
    expect(reportIdxA).toBeGreaterThan(closeIdxA); // 経路A: report は close より後（直しで動いた）

    // 経路B
    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const reportIdxB = b.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closeIdxB = b.timeline.indexOf('query.close()');
    expect(reportIdxB).toBeGreaterThanOrEqual(0);
    expect(closeIdxB).toBeGreaterThanOrEqual(0);
    expect(reportIdxB).toBeGreaterThan(closeIdxB); // 経路B: report が close より後（以前と同じ）

    // ⟹ 差が無くなった（実測）。
  });

  it('(b) 未決の確認の解決（settled）は report の emit の前か後か——#1533 の直しで揃った（以前は経路で違った）', async () => {
    // **2026-09-25 追記（Issue #1533 の直し）。** 元は「経路A: settled が
    // report より後 / 経路B: settled が report より前」という食い違いを固定
    // していた。`#settleAll` の呼び出し位置そのものは動かしていない
    // （PR 本文の断り）——動いたのは `report`（`#flushUnreported`）の側で、
    // それが `settleAll` より後ろへ回った結果、経路Aも「settled が report より
    // 前」になった。
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    const { askPromise: askA } = await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');
    const answerA = await askA;

    const settledIdxA = a.timeline.findIndex((l) => l.startsWith('emit:settled'));
    const reportIdxA = a.timeline.findIndex((l) => l.startsWith('emit:report'));
    // 経路A: settleAll は flushUnreported（report）より前（直しで動いた）
    expect(settledIdxA).toBeLessThan(reportIdxA);

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    const { askPromise: askB } = await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });
    const answerB = await askB;

    const settledIdxB = b.timeline.findIndex((l) => l.startsWith('emit:settled'));
    const reportIdxB = b.timeline.findIndex((l) => l.startsWith('emit:report'));
    // 経路B: settleAll は flushUnreported（report）より前
    expect(settledIdxB).toBeLessThan(reportIdxB);

    // 解決される「値」（behavior）は同じ形——message だけが reason 分だけ違う。
    expect(answerA.behavior).toBe('deny');
    expect(answerB.behavior).toBe('deny');
    expect((answerA as { message?: string }).message).not.toBe(
      (answerB as { message?: string }).message,
    );

    // ⟹ 前後関係の差は無くなった（実測）。解決される決定（behavior）は以前と
    // 同じ、message（reason の文言）が違うのも以前と同じ——経路ごとに違う
    // reason 文字列を渡しているためで、これは順序とは別の軸のまま変わっていない。
  });

  it('(c) 生ログの書き出し（archive）は query.close() の前か後か——#1533 の直しで揃った（以前は経路で違った）。fake が close 後の破損まで模していないことも書く', async () => {
    // **2026-09-25 追記（Issue #1533 の直し）。** 元は「経路A: archive が close
    // より前 / 経路B: archive が close より後」という食い違いを固定していた
    // ——これがまさに #1533 が問題にした食い違いそのものである。`stop()` の
    // `#shipArchive` を `query.close()` → `await this.#reader` の後ろへ動かした
    // ことで、経路Aも「archive は close より後」になった。
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const archiveIdxA = a.timeline.findIndex((l) => l.startsWith('emit:archive'));
    const closeIdxA = a.timeline.indexOf('query.close()');
    expect(archiveIdxA).toBeGreaterThan(closeIdxA); // 経路A: archive は close より後（直しで動いた）

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const archiveIdxB = b.timeline.findIndex((l) => l.startsWith('emit:archive'));
    const closeIdxB = b.timeline.indexOf('query.close()');
    expect(archiveIdxB).toBeGreaterThan(closeIdxB); // 経路B: archive が close より後（以前と同じ）

    // ⟹ 順序自体の差は無くなった（実測）。
    //
    // ただし「close の後に読むと壊れる／欠ける」かどうかは、**この足場では
    // 測れない**——`#shipArchive()` は `node:fs/promises` の実物の `readFile`
    // を、実在するローカルの一時ファイルに対して呼ぶ（`fakeSdk` は
    // `transcript_path` という文字列を運ぶだけで、SDK の `Query#close()` を
    // 模した `close()` はこのファイルを一切触らない）。だから両経路で
    // 「close の後に archive を読んでいる」ことは実測できても、**本物の SDK
    // が close 時にこのファイルへ何をするか（閉じる／削除する／書きかけで
    // 止める等）は、この fake では検証できない**——これは案2（SDK の
    // `Query.close()` が生ログファイルに何をするか）の側で読むしかない。
    // **さらに、「close の前に読んでいた」ときの取りこぼし（読んだ後に CLI が
    // 書く最後の数行）は、この fake では最初から再現できない**——`close()` は
    // ファイルに触らないので、いつ読んでも同じ内容が返る。だから、この歯は
    // 「順序が動いたこと」だけを固定し、それが実際に生ログの完全性を上げたか
    // どうかは主張しない（PR 本文「未確認の前提」）。
  });

  it('(d) closed の emit（経路Bだけ）は report の前か後か', async () => {
    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const reportIdx = b.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closedIdx = b.timeline.findIndex((l) => l.startsWith('emit:closed'));
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    expect(closedIdx).toBeGreaterThanOrEqual(0);
    expect(reportIdx).toBeLessThan(closedIdx);

    // 経路Aには closed そのものが無い（doc のとおり。上の
    // 「経路A（stop()）」の歯が `expect(s.events.some((e) => e.type === 'closed')).toBe(false)`
    // で既に固定している——ここでは繰り返さない）。
  });

  it('(e) それ以外に、経路で外から見える出来事の集合そのものが違う', async () => {
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const typesA = new Set(a.events.map((e) => e.type));
    const typesB = new Set(b.events.map((e) => e.type));

    // 経路Bにしか出ない: closed。
    expect(typesA.has('closed')).toBe(false);
    expect(typesB.has('closed')).toBe(true);

    // それ以外の種類の集合（usage/worker_wait/archive/report/ask/settled）は
    // 両経路とも同じ——今回の初期状態（4条件）では「片方にしか出ない」種類は
    // closed 以外に見つからなかった（実測。もっと違う初期状態を作れば別かも
    // しれないが、確かめていない）。
    const withoutClosed = (set: Set<string>) => {
      const copy = new Set(set);
      copy.delete('closed');
      return copy;
    };
    expect([...withoutClosed(typesA)].sort()).toEqual([...withoutClosed(typesB)].sort());
  });
});

/**
 * **新しい歯（Issue #1533 の直し本体）。** `stop()` の生ログの送り出し
 * （`#shipArchive`）は、`#reader`（CLI の読み手）が終わるまで出ないことを
 * 固定する——「並びが変わった」ことだけでなく、「`close()` を呼んだ直後には
 * まだ出ていない」という**時間的な余白**そのものを歯にする。
 *
 * `deferCloseEnd: true` の fake は、`Query#close()` が呼ばれてもストリームを
 * 終わらせない（`FakeSession#endAfterClose()` を呼ぶまで `#reader` が生き
 * 続ける）。これで「`close()` は呼ばれたが CLI 側の後始末（本物の SDK なら
 * stdin の EOF を受けてから最後の行を書き切るまでの猶予）がまだ終わっていない」
 * 状態を作れる——このとき `archive` が出ていなければ、`#shipArchive` が本当に
 * `#reader` の終わりを待っていることの直接証拠になる。
 *
 * **変異（`#shipArchive`/`#flushUnreported` を `#reader` の前へ戻す）で赤に
 * なることを実測した**（このテストを書いた直後に `runner.ts` を一時的に
 * 元の並びへ戻して確認し、戻した。PR 本文に実測のログを載せる）。
 */
describe('#1533 新しい歯: stop() の生ログの送り出しは #reader の終わりの後', () => {
  it('query.close() の直後にはまだ archive が出ない。#reader が終わって初めて出る', async () => {
    const s = setup({ deferCloseEnd: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-defer.jsonl');
    writeFileSync(transcriptPath, '遅延後に読まれる生ログ', 'utf8');
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    s.resetTimeline();

    const stopPromise = s.host.stop('mgr-1');

    // close() は呼ばれるが、deferCloseEnd により #reader はまだ終わらない
    // ——一呼吸置いて確かめる（`stop()` 自身もまだ解決していないはず）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.timeline).toContain('query.close()');
    // ⭐ ここが歯の本体: close() は呼ばれても、archive はまだ出ていない。
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(false);
    // まだ list に残っている——`stop()` がまだ終わっていない証拠
    // （`onClosed()` は `stop()` の最後の同期文である）。
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(true);

    // #reader をここで初めて終わらせる——本物の SDK でいえば、CLI が
    // stdout を閉じて `for await` が自然に終わる瞬間に当たる。
    session.endAfterClose();
    await stopPromise;

    // ⭐ #reader が終わって初めて archive/report が出る。
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(true);
    const closeIdx = s.timeline.indexOf('query.close()');
    const archiveIdx = s.timeline.findIndex((l) => l.startsWith('emit:archive'));
    expect(archiveIdx).toBeGreaterThan(closeIdx);
  });
});

/**
 * **新しい歯（Issue #1533 + #1589、置き場所はここに決めた）。** `stop()` が
 * `query.close()` した後、`#reader` が例外で抜ける経路（Issue #1589 / PR #1590
 * が「`#finish('failed', …)` を呼ばない」で塞いだ経路）を、**#1533 の並べ替え
 * （生ログ・報告を `#reader` の後ろへ動かした形）の上で**もう一度確かめる。
 *
 * `runner-unreported.test.ts` にも `fakeSdk({ closeThrows: true })` を使った
 * 同種の歯（#1590 が足したもの）があるが、あちらは `close()` が呼ばれた瞬間に
 * 即座にストリームを例外で終わらせる作りで、「`#reader` がまだ終わっていない
 * 間は report/closed が出ていない」という**時間的な余白**までは見れない。
 * ここは `deferCloseEnd` + `crashAfterClose` で「`close()` は呼ばれたが
 * `#reader` はまだ生きている」→「そこで初めて例外が起きる」という2段階を
 * 作れる、この `timeline` 付きの足場でしか測れない——だからここに置いた。
 *
 * `primeState` で未決の確認を1件開いたまま（`#status = 'waiting_human'`）
 * `stop()` を呼ぶ——`statusAtStop` の断り（`runner.ts` の `stop()` 冒頭）が
 * 効いていることも同時に確かめる（`#settleAll` が確認を deny で解いて
 * `#status` が `running` に戻った**後**でも、report は `waiting_human` を
 * 名乗り続けるはず）。
 */
describe('#1533 + #1589 新しい歯: stop() の後に #reader が例外で抜けても、報告は stop() からの1本だけ', () => {
  it('report は1本だけ・reason/status は stop() のもの・closed は出ない・報告は #reader の終わりの後', async () => {
    const s = setup({ deferCloseEnd: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-crash.jsonl');
    writeFileSync(transcriptPath, '例外経路の生ログ', 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);
    s.resetTimeline();

    const stopPromise = s.host.stop('mgr-1');

    // close() は呼ばれるが、deferCloseEnd により #reader はまだ終わらない
    // ——この時点では report も closed もまだ出ていないはず。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.timeline).toContain('query.close()');
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:closed'))).toBe(false);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(true);

    // #reader をここで初めて例外で抜けさせる——`close()` を呼んだこと自体とは
    // 独立の transport 障害を模す（Issue #1533 の SDK 調査コメント: 本物の
    // `close()` は `inputStream.done()` で正常終了させるだけで、例外にする
    // のは `readMessages()` の別ループの catch である）。
    session.crashAfterClose('SDK が close 時に例外を投げた');
    await stopPromise;
    const settledAnswer = await askPromise;

    // ⭐ closed は1本も出ない（Issue #1589 / PR #1590 が固定した挙動が、
    // #1533 の並べ替え後もそのまま効いている）。
    expect(s.events.some((e) => e.type === 'closed')).toBe(false);

    // ⭐ report はちょうど1本、stop() のもの。
    const reports = s.events.filter(
      (e): e is Extract<RunnerEvent, { type: 'report' }> => e.type === 'report',
    );
    expect(reports).toHaveLength(1);
    // reason は stop() の reason（#finish が合成する
    // 「マネージャーのセッションが落ちた: …」ではない）。
    expect(reports[0]?.unreported).toEqual({ reason: 'デーモンから停止を指示された。' });
    // status は stop が指示された時点の値（`waiting_human`）。`#settleAll` が
    // 確認を deny で解いた後の `running` ではない——`statusAtStop` の断りが
    // 効いている証拠。
    expect(reports[0]?.status).toBe('waiting_human');

    // ⭐ その report は #reader の終わりの後に出る（timeline 上でも close より後）。
    const reportIdx = s.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closeIdx = s.timeline.indexOf('query.close()');
    expect(reportIdx).toBeGreaterThan(closeIdx);

    // settleAll は deny で解決する。
    expect(settledAnswer).toEqual({
      behavior: 'deny',
      message: 'デーモンから停止を指示された。',
    });
  });
});

/**
 * **Issue #1597 の再現。** `#apply` の `case 'turn_ended'` にある
 * `unresumable` の枝（`void this.#finish('lost', …)`）には `#stopped` の門が
 * 無い——`#read` の catch 節（Issue #1589 / PR #1590 が塞いだ箇所）と同じ形の
 * 穴が、resume に失敗した直後の経路に残っている。
 *
 * 条件（Issue 本文の「再現の条件」）:
 *
 * 1. `resume()` で開いたセッションである（`start()` では `#resumeAttempt` が
 *    立たない）——`host.resume()` を使う
 * 2. まだ一度も手が動いていない——`resume()` の後、`say`/`finish` を一度も
 *    呼ばない
 * 3. 生ログから作り直せる記録が無い——`entries` を渡さない
 *    （`renderSessionLog(undefined)` は `null`）
 * 4. `subtype: 'error_during_execution'` の `result`（結果なし）を流した直後に、
 *    await を挟まず `host.stop(id)` を呼ぶ——`resultFailed()` は同期関数
 *    （`FakeSession.resultFailed` の doc）
 *
 * **直す前は赤くなる**——`void this.#finish('lost', …)` が `stop()` と
 * 競合し、`stop()` が `host.list()` から消した後に `closed(status=lost)` が
 * 1本出る（Issue 本文の実測ログと同じ形）。**直した後（`#apply` の
 * `unresumable` の枝を `if (!this.#stopped)` で囲む）は緑になる。**
 */
describe('#1597: resume 直後に結果なし result（unresumable）と stop() が重なっても、closed は出ない', () => {
  it('closed が0本のまま、stop() が host.list() からセッションを消す', async () => {
    const s = setup();
    await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-mgr',
      cwd: dir,
      request: '調べて',
      // entries を渡さない → renderSessionLog が null → unresumable
      // （`decideResumeRecoveryOutcome` の doc）。
    });
    const session = await firstSession(s.sessions);
    s.resetTimeline();

    // **await を挟まない（Issue 本文の再現手順そのもの）。** `resultFailed`
    // は同期関数なので、この行が返った時点では `#apply` はまだ
    // `unresumable` の枝へすら到達していない——`#read` の `for await` が
    // 次のマイクロタスクでこのメッセージを受け取ってから処理する。
    session.resultFailed('失敗した', 'error_during_execution');
    await s.host.stop('mgr-1');
    // `stop()` が戻った後も、競合していた `void this.#finish('lost', …)` が
    // 遅れて emit することがある——一呼吸置いてから数える。
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.log('#1597 timeline:', JSON.stringify(s.timeline));

    // ⭐ ここが歯の本体。closed が1本も出ない——`stop()` は closed を出さない
    // 設計であり（`runner.ts` の `stop()` の doc）、`unresumable` を畳む
    // `#finish('lost', …)` がそれを覆してはいけない。
    expect(s.events.filter((e) => e.type === 'closed')).toHaveLength(0);

    // stop() は host.list() からセッションを消し終えている。
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);
  });
});

describe('#1586: 畳むときに解いた確認の settled には withdrawn(reason) が載る（answer() の経路には載らない）', () => {
  it('stop() で畳むと、未決の確認の settled に withdrawn(reason) が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'stop-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await primeState(session, transcriptPath);

    await s.host.stop('mgr-1');

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-1',
    );
    // reason は stop() が渡す固定文言（`runner.ts` の `RunnerHost#stop`）。
    expect(settled?.withdrawn).toEqual({ reason: 'デーモンから停止を指示された。' });
  });

  it('#finish の自然終了（経路B）で畳んでも、未決の確認の settled に withdrawn(reason) が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'finish-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await primeState(session, transcriptPath);

    session.end();
    await vi.waitFor(() => {
      if (!s.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-1',
    );
    // reason は自然終了の経路が合成する固定文言（`runner.ts` の `#finish` 呼び出し箇所）。
    expect(settled?.withdrawn).toEqual({ reason: 'マネージャーのセッションが閉じた。' });
  });

  it('answer()（クローンの回答）の経路では withdrawn が載らない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'answer-not-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);

    await s.host.answer('mgr-1', { requestId: 'req-1', decision: 'allow', message: 'どうぞ' });
    const answer = await askPromise;
    expect(answer.behavior).toBe('allow');

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-1',
    );
    expect(settled).toBeDefined();
    expect(settled?.withdrawn).toBeUndefined();
  });

  it('マネージャー側の中断（onAbort）の経路でも withdrawn が載らない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'abort-not-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');

    // `primeState` と同じ形で1件積むが、signal はこちらで握る
    // （abort させるため）。
    await session.say('喋った');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    const controller = new AbortController();
    const canUseTool = session.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      extra: { signal: AbortSignal; requestId?: string },
    ) => Promise<PermissionResult>;
    const askPromise = canUseTool(
      'Bash',
      { command: 'echo hi' },
      { signal: controller.signal, requestId: 'req-abort' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();
    const answer = await askPromise;
    expect(answer.behavior).toBe('deny');

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-abort',
    );
    expect(settled).toBeDefined();
    expect(settled?.withdrawn).toBeUndefined();
  });
});
