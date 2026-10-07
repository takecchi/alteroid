import { McpServersConflictError, mcpServersVersionOf } from './mcp-servers.js';
import type { McpServers } from './mcp-servers.js';
import type { McpServerStore } from './store.js';

/**
 * `McpServerStore.write` の前提の版（`ifMatch`。Issue #3984）の契約を、実装1つに対して測る。
 * fs / pg / インメモリの3つが同じ関数を呼ぶ（`schedule-if-match-contract.ts` と同じ形）。
 * 版は内容の sha256（`mcpServersVersionOf`）。実時間の待ちは使わない。
 *
 * ⚠️ この関数は器の中身を書き換える。最後に登録を外した状態で終わる。
 */
export async function verifyMcpServersIfMatchContract(store: McpServerStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`MCP サーバの登録の器の契約違反（ifMatch）: ${message}`);
  }
  const one: McpServers = { 'if-match-one': { command: 'dummy-one' } };
  const two: McpServers = { ...one, 'if-match-two': { command: 'dummy-two' } };
  const three: McpServers = { 'if-match-three': { command: 'dummy-three' } };

  async function conflictOf(run: () => Promise<unknown>): Promise<McpServersConflictError | null> {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof McpServersConflictError) return error;
      throw error;
    }
  }
  const namesOf = async () => Object.keys((await store.read())?.mcpServers ?? {}).sort();

  // 置かれていない状態の版は、空の `{}` の版と同じ。その版で書ける。
  await store.write({});
  const emptyVersion = mcpServersVersionOf(null);
  if (emptyVersion !== mcpServersVersionOf({ mcpServers: {} })) {
    fail('置かれていない版と空の登録の版が違う');
  }
  const first = await store.write(one, { ifMatch: emptyVersion });
  if (Object.keys(first.mcpServers).join() !== 'if-match-one') fail('空の版で書けない');

  // 書いた後の版は、読み戻した内容の版と同じ（次の ifMatch に使える）。
  const v1 = mcpServersVersionOf(await store.read());
  if (v1 !== mcpServersVersionOf(first)) fail('write の戻りの版と、読み戻した版が違う');
  if (v1 === emptyVersion) fail('内容が変わったのに版が変わらない');

  // 古い版（空）を前提にした書き込みは、書かずに衝突し、current が最新。
  const stale = await conflictOf(() => store.write(two, { ifMatch: emptyVersion }));
  if (stale === null) fail('古い版を前提にした書き込みが断られない');
  if (Object.keys(stale.current?.mcpServers ?? {}).join() !== 'if-match-one') {
    fail('衝突の current が最新でない');
  }
  if ((await namesOf()).join() !== 'if-match-one') fail('衝突したのに本文が書き換わった');

  // いまの版なら書ける。
  await store.write(two, { ifMatch: v1 });
  if ((await namesOf()).join() !== 'if-match-one,if-match-two') fail('いまの版で書けない');

  // 版つきで空（外す）にしたあと、置かれていない current は null。
  const v2 = mcpServersVersionOf(await store.read());
  await store.write({}, { ifMatch: v2 });
  if ((await store.read()) !== null) fail('版つきの空の書き込みで外れない');
  const gone = await conflictOf(() => store.write(three, { ifMatch: v2 }));
  if (gone === null || gone.current !== null) fail('外した後の古い版が current: null で衝突しない');

  // 省略は従来どおり無条件の全文置換（CLI を壊さない）。
  await store.write(one);
  await store.write(three);
  if ((await namesOf()).join() !== 'if-match-three') fail('ifMatch 省略の書き込みが後勝ちでない');

  // 同じ版を前提にした同時の書き込みは、ちょうど1つだけが通る。
  const base = mcpServersVersionOf(await store.read());
  const racers = [1, 2, 3, 4].map((n) =>
    conflictOf(() => store.write({ [`if-match-racer-${String(n)}`]: { command: 'dummy' } }, { ifMatch: base })),
  );
  const outcomes = await Promise.all(racers);
  if (outcomes.filter((o) => o === null).length !== 1) {
    fail('同じ版を前提にした同時の書き込みが、ちょうど1つだけ通らない');
  }
  if ((await namesOf()).length !== 1) fail('同時の書き込みの後に、勝った1件だけが残っていない');

  await store.write({});
}
