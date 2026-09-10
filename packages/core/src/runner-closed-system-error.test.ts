import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { systemErrorFactsOf, withSystemErrorNote } from './system-error.js';

/**
 * **落ちた理由の分類が、判定できる形で `closed` に載ること**（#713 段1）。
 *
 * `runner.ts` の `#read()` の catch は `String(error)` で人が読む一文（`reason`）を
 * 作る。**語そのものは文字列にも残る** —— Node の `Error` は `message` に `syscall`
 * と `code` を織り込むので、器の資源で起動に失敗した回に実際に届いた一文は
 * `EAGAIN` を含んでいた。**失われるのは語ではなく、機械が判定できる形のほうである。**
 *
 * だから測るのは3つで、**2本目が本題である**:
 *
 * 1. `code` を持つ例外 ⟹ `closed.systemError` にその `code` が乗る
 * 2. `code` を持たない例外 ⟹ **欄そのものが付かない**（`''` や `'unknown'` で
 *    埋めない）。これが無いと「常に何か入れる」実装でも緑になる
 * 3. `reason`（人が読む一文）がこれまでと1文字も変わらない
 *
 * **daemon まで届くところも測る。** `apps/daemon/src/runner-client.ts` は受け取った
 * JSON を `runnerEventSchema.safeParse` に通してから配るので、**スキーマに無い欄は
 * そこで黙って落ちる。** emit した中身だけを見ていると、境界で消えていることに
 * 気づけない。
 *
 * ## `EAGAIN` は合成する
 *
 * 本物の pids 枯渇を再現しない —— 走っている器を壊す操作である。使うのは、実際に
 * 届いた文言と、Node のシステムエラーが持つ3つの欄を合成したものである。
 */

/**
 * 最初の1件を読もうとした瞬間に投げる偽 SDK（起動そのものに失敗した回の形）。
 *
 * **1件も流さない。** 実際の spawn 失敗では、SDK の `readMessages()` が最初の1件を
 * 出す前に例外を投げる（`init` すら来ない）。だから generator ではなく、`next()`
 * が最初から reject する非同期イテレータを手で組む。
 */
function throwingSdk(error: unknown): typeof sdkQuery {
  return ((): Query => {
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<never>> => Promise.reject(error),
      return: (): Promise<IteratorResult<never>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
    return Object.assign(stream, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

/** `error` を投げる偽 SDK で host を1つ起こし、`closed` を待つ土台。 */
function hostThatThrows(error: unknown): {
  host: RunnerHost;
  waitForClosed: () => Promise<Extract<RunnerEvent, { type: 'closed' }>>;
} {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-713',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: throwingSdk(error),
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  const waitForClosed = async (): Promise<Extract<RunnerEvent, { type: 'closed' }>> => {
    let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
    await vi.waitFor(() => {
      closed = events.find(
        (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
      );
      if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    });
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    return closed;
  };
  return { host, waitForClosed };
}

/**
 * 新規に開いたセッションが落ちた回の `closed`（`status: 'failed'`）。
 *
 * `start` は `#resumeAttempt` を立てないので `#recoverFromFailedResume` は必ず
 * `'not-a-resume-failure'` を返し、catch は `failed` の枝へ倒れる。
 */
async function closedAfterThrowing(
  error: unknown,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const { host, waitForClosed } = hostThatThrows(error);
  await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });
  return waitForClosed();
}

/**
 * **戻れないと確定した回の `closed`（`status: 'lost'`）。**
 *
 * catch から出る枝は2つあり（`failed` と `lost`）、**分類を渡す口も2つある。**
 * 片方だけを測ると、もう片方から `{ systemError }` を落とす変更が緑のまま通る。
 *
 * `lost` へ倒すには `#recoverFromFailedResume` に `'unresumable'` を返させる ——
 * `resume` で `#resumeAttempt` を立て、一度も手が動かないうちに例外を出し、
 * **引き継ぎ先を作る材料（`entries`）を渡さない**（`renderSessionLog` が `null` を
 * 返す）。
 */
async function lostAfterThrowing(
  error: unknown,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const { host, waitForClosed } = hostThatThrows(error);
  await host.resume({
    managerId: 'mgr-1',
    sessionId: 'sess-dead',
    cwd: '/work/project',
    request: '最初の依頼',
    message: '続きの一言',
  });
  return waitForClosed();
}

/**
 * runner → daemon の境界を実際に通す（`runner-client.ts` と同じ形）。
 *
 * **`JSON.parse(JSON.stringify(…))` を挟むのは、配線が JSON を跨ぐからである。**
 * `undefined` のキーはここで丸ごと落ちるので、「欄が付かない」が本当に付かない形で
 * 届くかも同時に測れる。
 */
function throughDaemonBoundary(event: RunnerEvent): Extract<RunnerEvent, { type: 'closed' }> {
  const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
  if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
  if (parsed.data.type !== 'closed') throw new Error(`closed ではない: ${parsed.data.type}`);
  return parsed.data;
}

/**
 * 実際に届いた文言（クローンの受信箱、2026-09-08）と同じ形の、器の資源で起動に
 * 失敗した例外。**SDK は包み直した側にも `code` を付け直す**ので `code` は在るが、
 * `errno` / `syscall` は元の spawn エラーにしか無い —— ここでは3つ揃った側
 * （元の spawn エラーがそのまま上がってくる回）を使い、欠ける側は別の歯で測る。
 */
function eagainSpawnError(): Error {
  return Object.assign(new Error('spawn /app/node_modules/.bin/claude EAGAIN'), {
    code: 'EAGAIN',
    errno: -11,
    syscall: 'spawn /app/node_modules/.bin/claude',
  });
}

describe('落ちた理由の分類が、判定できる形で closed に載る（#713 段1）', () => {
  it('code を持つ例外は、closed.systemError にその code が乗って daemon まで届く', async () => {
    const closed = await closedAfterThrowing(eagainSpawnError());
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.systemError).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
  });

  it('errno / syscall が無くても code だけは乗る（SDK が包み直した回の形）', async () => {
    // 包み直された側の Error は `code` しか持たない（`sdk.mjs` は元の code だけを
    // 付け直す）。**取れた分だけを載せ、取れなかった欄は付けない。**
    const wrapped = Object.assign(
      new Error('Failed to spawn Claude Code process: spawn /app/…/claude EAGAIN'),
      { code: 'EAGAIN' },
    );
    const delivered = throughDaemonBoundary(await closedAfterThrowing(wrapped));

    expect(delivered.systemError).toEqual({ code: 'EAGAIN' });
    expect(Object.hasOwn(delivered.systemError as object, 'errno')).toBe(false);
    expect(Object.hasOwn(delivered.systemError as object, 'syscall')).toBe(false);
  });

  it('code を持たない例外では、欄そのものが付かない（「取れなかった」を値で埋めない）', async () => {
    const closed = await closedAfterThrowing(new Error('何か'));

    // **emit した時点で付いていない。**
    expect(Object.hasOwn(closed, 'systemError')).toBe(false);
    expect(closed.systemError).toBeUndefined();

    // **daemon の境界を通した後も付いていない。** ここを見ないと、
    // スキーマの既定値や `catch` の埋め合わせで復活したことに気づけない。
    const delivered = throughDaemonBoundary(closed);
    expect(Object.hasOwn(delivered, 'systemError')).toBe(false);
    expect(delivered.systemError).toBeUndefined();
  });

  it('lost（戻れないと確定した回）にも同じ分類が乗る（枝を片方だけ測らない）', async () => {
    const closed = await lostAfterThrowing(eagainSpawnError());
    const delivered = throughDaemonBoundary(closed);

    // **前提の確認。** ここが `failed` になっていたら、この歯は `lost` の枝を
    // 一度も通っていない ＝ 何も測っていない。
    expect(delivered.status).toBe('lost');
    expect(delivered.systemError).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    // `lost` の `reason` は `String(error)` そのままで、`failed` の定型文で
    // 包まれない。**こちらも1文字も変えていない。**
    expect(delivered.reason).toBe('Error: spawn /app/node_modules/.bin/claude EAGAIN');
  });

  it('lost でも、code を持たない例外では欄そのものが付かない', async () => {
    const delivered = throughDaemonBoundary(await lostAfterThrowing(new Error('何か')));

    expect(delivered.status).toBe('lost');
    expect(Object.hasOwn(delivered, 'systemError')).toBe(false);
    expect(delivered.systemError).toBeUndefined();
  });

  it('reason（人が読む一文）はこれまでと変わらない', async () => {
    const withCode = await closedAfterThrowing(eagainSpawnError());
    const withoutCode = await closedAfterThrowing(new Error('何か'));

    // `String(error)` の結果がそのまま同じテンプレートで包まれている。
    expect(withCode.reason).toBe(
      'マネージャーのセッションが落ちた: Error: spawn /app/node_modules/.bin/claude EAGAIN',
    );
    expect(withoutCode.reason).toBe('マネージャーのセッションが落ちた: Error: 何か');
    expect(withCode.status).toBe('failed');
    expect(withoutCode.status).toBe('failed');
  });
});

describe('systemErrorFactsOf は「取れなかった」を値で埋めない', () => {
  it('code を持たないものは undefined（欄を作らない）', () => {
    expect(systemErrorFactsOf(new Error('素の Error'))).toBeUndefined();
    expect(systemErrorFactsOf('投げられた文字列')).toBeUndefined();
    expect(systemErrorFactsOf(null)).toBeUndefined();
    expect(systemErrorFactsOf(undefined)).toBeUndefined();
    // **数値の code は名乗らない。** この欄が名乗るのは Node が付けた文字列の
    // 分類であって、「何か code らしきものが在った」ではない。
    expect(systemErrorFactsOf(Object.assign(new Error('数値'), { code: 111 }))).toBeUndefined();
    // 空文字も「取れた」に数えない。
    expect(systemErrorFactsOf(Object.assign(new Error('空'), { code: '' }))).toBeUndefined();
  });

  it('取れた欄だけを載せる', () => {
    expect(systemErrorFactsOf(eagainSpawnError())).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    expect(systemErrorFactsOf(Object.assign(new Error('code だけ'), { code: 'ENOENT' }))).toEqual({
      code: 'ENOENT',
    });
  });
});

/**
 * `withSystemErrorNote`（#713 段2）——`closed_failed` の受信箱本文へ
 * `event.systemError` を運ぶ。`withRecoveryNote`（`usage-limits.ts`）と同じ形
 * （base を1文字も変えず、末尾に改行1本と1行を足す）だが、**`systemError` が
 * 無いときも行を省かない**（`withRecoveryNote` は `recovery === 'unknown'` で
 * 何も足さない。ここでは真似ない——理由は `system-error.ts` の doc）。
 */
describe('withSystemErrorNote は base を変えず、末尾に分類の1行を足す（#713 段2）', () => {
  const base = 'マネージャーのセッションが落ちた: Error: 何か';

  it('base（event.reason）は1文字も変わらない——先頭が base + 改行のまま', () => {
    const withFacts = withSystemErrorNote(base, { code: 'EAGAIN' });
    const withoutFacts = withSystemErrorNote(base, undefined);
    expect(withFacts.startsWith(`${base}\n`)).toBe(true);
    expect(withoutFacts.startsWith(`${base}\n`)).toBe(true);
  });

  it('B: systemError が在るとき、code / errno / syscall を言い換えずにそのまま連ねる', () => {
    const decorated = withSystemErrorNote(base, {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    expect(decorated).toContain('code=EAGAIN');
    expect(decorated).toContain('errno=-11');
    expect(decorated).toContain('syscall=spawn /app/node_modules/.bin/claude');
  });

  it('B: errno / syscall が無い回（SDK が包み直した回の形）は、その欄を書かない', () => {
    const decorated = withSystemErrorNote(base, { code: 'EAGAIN' });
    expect(decorated).toContain('code=EAGAIN');
    expect(decorated).not.toContain('errno=');
    expect(decorated).not.toContain('syscall=');
  });

  it(
    'D: systemError が無いとき、withRecoveryNote と違って行を省略しない。' +
      '「取れなかった」を明示的な1行として書く',
    () => {
      const decorated = withSystemErrorNote(base, undefined);
      // withRecoveryNote の unknown 側は `return base;`（1文字も足さない）。
      // ここではそれをしない——長さが base より必ず伸びる。
      expect(decorated.length).toBeGreaterThan(base.length);
      expect(decorated).toContain('器の資源');
    },
  );

  it(
    'D の行は「器の資源の軸」に限定して名乗り、他の軸（枠・セッション切断）は' +
      'この欄の対象外だと明示する——A（枠）を D に飲み込ませない',
    () => {
      const decorated = withSystemErrorNote(base, undefined);
      // **A（枠）や C（セッション切断）を「分からない」へ一括りにしない。**
      // 読む側が「本文と lastFailure を見ればよい」と分かる形で書く。
      expect(decorated).toContain('枠');
      expect(decorated).toContain('lastFailure');
      // **「分類が取れなかった」という無限定な言い方だけで終わらせない。**
      // 無限定な文言では、A で落ちた回（`systemError` も無い）にも同じ行が出て、
      // 「何も分からない」と読める——次のテストがこの区別を実際の2文言で測る。
    },
  );

  it(
    'D の行は、枠（A）で落ちた回の本文（reason）を上書きしない——' +
      '合成した最終本文には枠の文言と D の行が両方残る',
    () => {
      // A: 枠で落ちた回は systemError が付かない。reason 本文に枠の文言が
      // そのまま入っている（`manager-synthesized-notices.test.ts` の実測と
      // 同じ文言）。
      const quotaReason =
        'マネージャーのセッションが落ちた: Error: ' +
        "You've hit your individual spend limit for this account.";
      const decorated = withSystemErrorNote(quotaReason, undefined);
      // **枠の文言はそのまま残る**（base を変えていない）。
      expect(decorated).toContain("You've hit your individual spend limit for this account.");
      // **D の行も付くが、「器の資源」の軸に限定されている**——
      // 「分類できない」という無限定な文言なら、枠の文言と組み合わさったときに
      // 読み手が「枠かどうかも分からない」と誤読しうる。実際には reason 本文に
      // 枠の事実がそのまま書いてあるので、誤読ではないことを行の中で示す。
      expect(decorated).toContain('器の資源による落ち方かどうかは');
    },
  );
});
