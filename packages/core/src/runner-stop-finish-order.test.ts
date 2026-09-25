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
}

function fakeSdk(onClose: () => void): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  let sayCounter = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];

    const push = (message: SDKMessage | null) => {
      if (emit) {
        const resolve = emit;
        emit = null;
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
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        onClose();
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
function setup(): {
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
  const { fn, sessions } = fakeSdk(() => timeline.push('query.close()'));
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
    expect(s.timeline).toEqual([
      'emit:usage',
      'emit:worker_wait(settled=false)',
      'emit:archive(len=9)',
      // **`status` は `waiting_human`。** 未決の確認（`askPermission`）がまだ
      // 解けていない時点で `#flushUnreported` が呼ばれるため——`#onPermission`
      // が確認を積んだ時点で `#status = 'waiting_human'` にしており、解けるのは
      // この直後の `settleAll`（次の行）である。
      'emit:report(status=waiting_human,unreported=true)',
      'emit:settled(requestId=req-1)',
      'query.close()',
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
  it('(a) report の emit は query.close() の前か後か——経路で違う', async () => {
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
    expect(reportIdxA).toBeLessThan(closeIdxA); // 経路A: report が close より前

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
    expect(reportIdxB).toBeGreaterThan(closeIdxB); // 経路B: report が close より後

    // ⟹ 差が有る（実測）。
  });

  it('(b) 未決の確認の解決（settled）は report の emit の前か後か——経路で違うか、値は同じか', async () => {
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
    // 経路A: settleAll は flushUnreported（report）より後
    expect(settledIdxA).toBeGreaterThan(reportIdxA);

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

    // ⟹ 前後関係に差が有る（実測）。解決される決定（behavior）は同じ、
    // message（reason の文言）は違う——経路ごとに違う reason 文字列を渡している
    // ためで、これは順序とは別の軸である。
  });

  it('(c) 生ログの書き出し（archive）は query.close() の前か後か——経路で違う。fake が close 後の破損まで模していないことも書く', async () => {
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const archiveIdxA = a.timeline.findIndex((l) => l.startsWith('emit:archive'));
    const closeIdxA = a.timeline.indexOf('query.close()');
    expect(archiveIdxA).toBeLessThan(closeIdxA); // 経路A: archive が close より前

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
    expect(archiveIdxB).toBeGreaterThan(closeIdxB); // 経路B: archive が close より後

    // ⟹ 順序自体は差が有る（実測）。
    //
    // ただし「close の後に読むと壊れる／欠ける」かどうかは、**この足場では
    // 測れない**——`#shipArchive()` は `node:fs/promises` の実物の `readFile`
    // を、実在するローカルの一時ファイルに対して呼ぶ（`fakeSdk` は
    // `transcript_path` という文字列を運ぶだけで、SDK の `Query#close()` を
    // 模した `close()` はこのファイルを一切触らない）。だから経路Bで
    // 「close の後に archive を読んでいる」ことは実測できても、**本物の SDK
    // が close 時にこのファイルへ何をするか（閉じる／削除する／書きかけで
    // 止める等）は、この fake では検証できない**——これは案2（SDK の
    // `Query.close()` が生ログファイルに何をするか）の側で読むしかない。
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
