import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { systemErrorFactsOf } from './system-error.js';

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

/** 反復した瞬間に投げる偽 SDK（起動そのものに失敗した回の形）。 */
function throwingSdk(error: unknown): typeof sdkQuery {
  return ((): Query => {
    async function* generate(): AsyncGenerator<never, void> {
      // **何も yield しない。** 実際の spawn 失敗では `readMessages()` が最初の
      // 1件を出す前に投げる（`init` すら来ない）。
      await Promise.resolve();
      throw error;
    }
    return Object.assign(generate(), {
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

/** `error` を投げるセッションを1本起こし、降りてきた `closed` を返す。 */
async function closedAfterThrowing(
  error: unknown,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-713',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: throwingSdk(error),
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });

  let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
  await vi.waitFor(() => {
    closed = events.find(
      (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
    );
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');
  });
  if (closed === undefined) throw new Error('closed がまだ降りてきていない');
  return closed;
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
  return Object.assign(
    new Error('spawn /app/node_modules/.bin/claude EAGAIN'),
    { code: 'EAGAIN', errno: -11, syscall: 'spawn /app/node_modules/.bin/claude' },
  );
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
    expect(
      systemErrorFactsOf(Object.assign(new Error('code だけ'), { code: 'ENOENT' })),
    ).toEqual({ code: 'ENOENT' });
  });
});
