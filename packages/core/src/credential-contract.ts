import { InvalidCredentialNameError } from './credential-input.js';
import { NulNotAllowedError } from './nul-guard.js';
import type { CredentialVaultStore } from './store.js';

// vitest に依存しない素の非同期関数にする。呼ぶ前のストアは空であること
export async function verifyCredentialVaultContract(store: CredentialVaultStore): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(`CredentialVaultStore contract violated: ${label} — ${JSON.stringify(detail)}`);
  }

  async function rejects(
    label: string,
    entries: Parameters<CredentialVaultStore['put']>[0],
    expected: typeof NulNotAllowedError | typeof InvalidCredentialNameError,
    secret: string,
  ): Promise<void> {
    let thrown: unknown;
    try {
      await store.put(entries);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof expected)) {
      fail(`${label}は${expected.name}で断る`, {
        thrown: thrown === undefined ? '(投げなかった)' : String(thrown),
      });
    }
    if (secret.length > 0 && thrown.message.includes(secret)) {
      fail(`${label}の例外の文に値を載せない`, thrown.message);
    }
    const after = await store.list();
    if (after.length !== 0) {
      fail(
        `${label}では何も書かない`,
        after.map((row) => row.name),
      );
    }
  }

  const initial = await store.list();
  if (initial.length !== 0)
    fail(
      '前提: ストアが空',
      initial.map((row) => row.name),
    );

  await rejects(
    '名前のNUL',
    [
      { name: 'CONTRACT_OK', value: 'ok' },
      { name: 'CONTRACT_\u0000NAME', value: 'v' },
    ],
    NulNotAllowedError,
    'CONTRACT_',
  );

  await rejects(
    '値のNUL',
    [
      { name: 'CONTRACT_OK', value: 'ok' },
      { name: 'CONTRACT_NUL_VALUE', value: 'sec\u0000ret-value' },
    ],
    NulNotAllowedError,
    'ret-value',
  );

  for (const bad of ['', 'lower_case', '1ABC', '../../etc/x', 'HAS SPACE']) {
    await rejects(
      `不正な名前(${JSON.stringify(bad)})`,
      [{ name: bad, value: 'v' }],
      InvalidCredentialNameError,
      bad,
    );
  }
  await rejects(
    '不正な名前(値が空文字)',
    [{ name: '', value: '' }],
    InvalidCredentialNameError,
    '',
  );
  await rejects(
    '不正な名前(正しい行と同居)',
    [
      { name: 'CONTRACT_OK', value: 'ok' },
      { name: 'bad name', value: 'v' },
    ],
    InvalidCredentialNameError,
    'bad name',
  );

  const written = await store.put([{ name: 'CONTRACT_OK', value: 'ok' }]);
  if (written.length !== 1 || written[0]?.name !== 'CONTRACT_OK' || written[0].value !== 'ok') {
    fail('正しい入力は書ける', written);
  }
  await store.put([{ name: 'CONTRACT_OK', value: '' }]);
  const cleaned = await store.list();
  if (cleaned.length !== 0)
    fail(
      '空文字で外れて空に戻る',
      cleaned.map((row) => row.name),
    );
}

// 印の名前を呼び出しごとに一意にする: 終わったあとも印は残るので、同じストアで何度呼んでも干渉しないため
export async function verifyCredentialSeedOnceContract(store: CredentialVaultStore): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(
      `CredentialVaultStore.seedOnce contract violated: ${label} — ${JSON.stringify(detail)}`,
    );
  }
  const tag = `contract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const names = async (): Promise<string[]> => (await store.list()).map((row) => row.name);
  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    [...a].sort().join(',') === [...b].sort().join(',');

  const initial = await names();
  if (initial.length !== 0) fail('前提: ストアが空', initial);

  const first = await store.seedOnce(`${tag}-a`, [
    { name: 'SEED_A', value: 'a-1' },
    { name: 'SEED_B', value: 'b-1', scope: 'app', secret: false },
    { name: 'SEED_EMPTY', value: '' },
  ]);
  if (!sameSet(first, ['SEED_A', 'SEED_B'])) fail('初回は行が無い名前だけ書く', first);
  const rows = await store.list();
  const a = rows.find((row) => row.name === 'SEED_A');
  const b = rows.find((row) => row.name === 'SEED_B');
  if (a?.value !== 'a-1' || a.scope !== 'all' || a.secret !== true) {
    fail('省略した scope / secret は all / true', a);
  }
  if (b?.value !== 'b-1' || b.scope !== 'app' || b.secret !== false) {
    fail('渡した scope / secret のまま書く', b);
  }
  if (rows.some((row) => row.name === 'SEED_EMPTY')) fail('空文字の値は書かない', rows);

  const second = await store.seedOnce(`${tag}-a`, [{ name: 'SEED_C', value: 'c-1' }]);
  if (second.length !== 0 || (await names()).includes('SEED_C')) {
    fail('同じ印の2回目は何も書かない', { second, now: await names() });
  }

  await store.put([{ name: 'SEED_A', value: '' }]);
  const third = await store.seedOnce(`${tag}-a`, [{ name: 'SEED_A', value: 'a-2' }]);
  if (third.length !== 0 || (await names()).includes('SEED_A')) {
    fail('消した名前は同じ印で蘇らない', { third, now: await names() });
  }

  const fourth = await store.seedOnce(`${tag}-b`, [
    { name: 'SEED_B', value: 'b-2' },
    { name: 'SEED_D', value: 'd-1' },
  ]);
  if (!sameSet(fourth, ['SEED_D'])) fail('既に在る行は上書きしない', fourth);
  const keptB = (await store.list()).find((row) => row.name === 'SEED_B');
  if (keptB?.value !== 'b-1') fail('既に在る行の値が変わっていない', keptB?.value);

  let invalid: unknown;
  try {
    await store.seedOnce(`${tag}-c`, [{ name: 'lower_case', value: 'x' }]);
  } catch (error) {
    invalid = error;
  }
  if (!(invalid instanceof InvalidCredentialNameError)) {
    fail('不正な名前は InvalidCredentialNameError で断る', String(invalid));
  }
  let nul: unknown;
  try {
    await store.seedOnce(`${tag}-c`, [{ name: 'SEED_NUL', value: 'se\u0000cret' }]);
  } catch (error) {
    nul = error;
  }
  if (!(nul instanceof NulNotAllowedError))
    fail('値の NUL は NulNotAllowedError で断る', String(nul));
  const afterInvalid = await store.seedOnce(`${tag}-c`, [{ name: 'SEED_E', value: 'e-1' }]);
  if (!sameSet(afterInvalid, ['SEED_E'])) fail('断った呼び出しは印を消費しない', afterInvalid);

  await store.put((await names()).map((name) => ({ name, value: '' })));
  const left = await names();
  if (left.length !== 0) fail('後始末: ストアが空に戻る', left);
}
