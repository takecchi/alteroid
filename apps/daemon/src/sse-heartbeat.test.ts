import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_SSE_HEARTBEAT_MS, startSseHeartbeat } from './sse-heartbeat.js';

/**
 * `startSseHeartbeat` の単体試験。
 *
 * **時計は手で進める。** 既定間隔は15秒なので実時間で待つ形にすると試験が遅く、
 * しかも「短い間隔に差し替えたから通った」のか「本当に周期で書いている」のかが
 * 見分けられなくなる。ここで見たいのは周期そのものなので、`vi.useFakeTimers()`
 * で刻みを支配する。
 *
 * **`stream` は本物の `SSEStreamingApi` ではない。** ここで検証するのは
 * 「`aborted` / `closed` を見て止まるか」「1回の `write()` で書き切るか」
 * 「stop でタイマーが消えるか」の3つで、いずれも hono の中身に依存しない。
 * hono 側の挙動（`write` が失敗を握り潰す・`outgoing` の close が `abort()` へ
 * 繋がる）は `./sse-heartbeat.ts` の JSDoc に読んだ根拠として書いてあり、
 * **ここで再現できるものではない**（再現しようとすると hono の実装を写した
 * 偽物を書くことになり、写し間違えたときに嘘のまま緑になる）。
 */
function fakeStream() {
  const writes: string[] = [];
  const stream = {
    aborted: false,
    closed: false,
    write(input: string) {
      writes.push(input);
      return Promise.resolve(stream as never);
    },
  };
  return { stream, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('間隔ごとに1回だけ書く（周期そのものを見る）', () => {
  const { stream, writes } = fakeStream();
  const stop = startSseHeartbeat(stream, 1000, () => undefined);

  // まだ1度も刻んでいない。**開始時には書かない**（`open` の前に何か流れると
  // 「最初のフレームは open」を前提にした読み手が崩れる）。
  expect(writes).toEqual([]);

  vi.advanceTimersByTime(999);
  expect(writes).toEqual([]);

  vi.advanceTimersByTime(1);
  expect(writes).toHaveLength(1);

  vi.advanceTimersByTime(3000);
  expect(writes).toHaveLength(4);

  stop();
});

/**
 * **1フレーム＝1回の `write()` であることを、書かれた文字列そのもので見る。**
 *
 * 分割して書くと、進行中の `writeSSE()` の chunk の中へバイトが混ざりうる
 * （`./sse-heartbeat.ts` の JSDoc「なぜ1回の `write()` で書き切るか」）。だから
 * 「コメント行が流れた」ではなく「1回の呼びで `:` 始まり・空行終わりが揃って
 * いる」ことを見る。
 */
it('1回の write() で、コメント行1本ぶんを空行まで書き切る', () => {
  const { stream, writes } = fakeStream();
  const stop = startSseHeartbeat(stream, 1000, () => undefined);

  vi.advanceTimersByTime(1000);

  expect(writes).toHaveLength(1);
  const frame = writes[0] ?? '';
  // SSE の仕様上クライアントが捨てる形（`:` 始まり）である
  expect(frame.startsWith(':')).toBe(true);
  // メッセージの区切りまで含める（空行が無いと次のフィールド行と混ざる）
  expect(frame.endsWith('\n\n')).toBe(true);
  // `data:` / `event:` を1つも含まない——含めた瞬間に SSE の1メッセージになる
  expect(frame).not.toContain('data:');
  expect(frame).not.toContain('event:');

  stop();
});

it('stop でタイマーが消える（ストリームが終わった後に書き続けない）', () => {
  const { stream, writes } = fakeStream();
  const stop = startSseHeartbeat(stream, 1000, () => undefined);

  vi.advanceTimersByTime(1000);
  expect(writes).toHaveLength(1);

  stop();

  vi.advanceTimersByTime(10_000);
  // **止めた後は1本も増えない。** 増えるなら `finally { stopHeartbeat() }` が
  // 意味を持たず、接続ごとにタイマーが溜まる。
  expect(writes).toHaveLength(1);
});

it('aborted が立っていたら書かずに止まり、待っているループを起こす', () => {
  const { stream, writes } = fakeStream();
  let woke = 0;
  const stop = startSseHeartbeat(stream, 1000, () => (woke += 1));

  stream.aborted = true;
  vi.advanceTimersByTime(1000);

  expect(writes).toEqual([]);
  expect(woke).toBe(1);

  // 止まっている＝以後 wake も write も増えない（`clearInterval` した証拠）
  vi.advanceTimersByTime(10_000);
  expect(woke).toBe(1);
  expect(writes).toEqual([]);

  stop();
});

it('closed が立っていたら書かずに止まり、待っているループを起こす', () => {
  const { stream, writes } = fakeStream();
  let woke = 0;
  const stop = startSseHeartbeat(stream, 1000, () => (woke += 1));

  stream.closed = true;
  vi.advanceTimersByTime(1000);

  expect(writes).toEqual([]);
  expect(woke).toBe(1);

  vi.advanceTimersByTime(10_000);
  expect(woke).toBe(1);

  stop();
});

/**
 * **`write()` が拒否した Promise を返しても、拾われない拒否にしない。**
 *
 * Node 15 以降の既定は `--unhandled-rejections=throw` で、拾われない拒否は
 * プロセスを落とす。heartbeat は全 SSE 接続で回るので、ここが投げると1本の
 * 死んだ接続がデーモン全体を落とす（`./sse-heartbeat.ts` の該当コメント）。
 *
 * いまの hono は中で握り潰すのでこの経路は踏まれない。**踏まれないことを
 * 確かめているのではなく、踏んでも落ちないことを確かめている。**
 */
it('write() が拒否しても、拾われない拒否を作らず次の刻みも回る', async () => {
  const writes: string[] = [];
  const stream = {
    aborted: false,
    closed: false,
    write(input: string) {
      writes.push(input);
      return Promise.reject(new Error('相手はもう居ない')) as never;
    },
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const stop = startSseHeartbeat(stream, 1000, () => undefined);
    vi.advanceTimersByTime(1000);
    // 拒否が拾われる機会をマイクロタスク1周ぶん与える
    await Promise.resolve();
    // **次の刻みも来る。** 1回目の拒否でタイマーが死んでいたらここが 1 のまま
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    stop();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  expect(writes).toHaveLength(2);
  expect(unhandled).toEqual([]);
});

/**
 * **既定値をここで固定する。** 環境変数を増やさない設計（`AppDeps.sseHeartbeatMs`
 * の JSDoc）なので、既定が実質の唯一の設定である。
 *
 * 見ているのは「よくある無通信切断（30秒）の窓に、少なくとも2回入るか」である
 * ——1回ぶんちょうどだと、刻みと窓の位相がずれた回に取りこぼす。**この 30_000 は
 * 実測ではなく、よくある既定として置いた仮定である**（プロキシごとに違う）。
 */
it('既定間隔は、よくある無通信切断（30秒）の窓に2回入る', () => {
  expect(DEFAULT_SSE_HEARTBEAT_MS * 2).toBeLessThanOrEqual(30_000);
  // 短すぎもしない（接続数×頻度で無駄な書き込みになる）
  expect(DEFAULT_SSE_HEARTBEAT_MS).toBeGreaterThanOrEqual(5_000);
});
