import type { CodexChatgptAuthRecord, CodexChatgptAuthStore } from './codex-chatgpt-auth.js';

export async function verifyCodexChatgptAuthContract(store: CodexChatgptAuthStore): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(
      `CodexChatgptAuthStore contract violated: ${label} — ${JSON.stringify(detail)}`,
    );
  }
  const record = (patch: Partial<CodexChatgptAuthRecord>): CodexChatgptAuthRecord => ({
    value: '{"tokens":{"refresh_token":"rt-0"}}',
    revision: 'rev-0',
    updatedAt: '2026-10-07T00:00:00.000Z',
    email: 'me@example.com',
    planType: 'plus',
    failure: null,
    ...patch,
  });

  if ((await store.get()) !== null) fail('空のストアの get は null', await store.get());
  if (await store.compareAndSwap('rev-0', record({})))
    fail('空のストアへの compareAndSwap は置かない', null);
  if ((await store.get()) !== null) fail('置かなかったものが残っている', await store.get());

  const first = record({});
  await store.replace(first);
  const read = await store.get();
  if (JSON.stringify(read) !== JSON.stringify(first)) fail('replace が往復する', read);

  const fromA = record({ value: '{"tokens":{"refresh_token":"rt-A"}}', revision: 'rev-A' });
  const fromB = record({ value: '{"tokens":{"refresh_token":"rt-B"}}', revision: 'rev-B' });
  if (!(await store.compareAndSwap('rev-0', fromA))) fail('読んだ版と同じなら置く', null);
  if (await store.compareAndSwap('rev-0', fromB)) fail('古い版からの書き戻しは置かない', null);
  const afterRace = await store.get();
  if (afterRace?.value !== fromA.value || afterRace.revision !== 'rev-A') {
    fail('古い版からの書き戻しが新しい値を潰さない', afterRace?.revision);
  }

  const failed = record({
    value: fromA.value,
    revision: 'rev-A',
    failure: { at: '2026-10-07T01:00:00.000Z', reason: 'refresh に失敗した' },
    email: null,
    planType: null,
  });
  if (!(await store.compareAndSwap('rev-A', failed))) fail('同じ版のまま失敗を記録できる', null);
  const afterFailure = await store.get();
  if (JSON.stringify(afterFailure) !== JSON.stringify(failed)) {
    fail('失敗の記録と null の欄が往復する', afterFailure);
  }

  if (!(await store.remove())) fail('remove は消したら true', null);
  if ((await store.get()) !== null) fail('remove の後の get は null', await store.get());
  if (await store.remove()) fail('無いものの remove は false', null);
  if (await store.compareAndSwap('rev-A', fromB))
    fail('消した後の compareAndSwap は置かない', null);
  if ((await store.get()) !== null) fail('消した後に置かれた', await store.get());
}
