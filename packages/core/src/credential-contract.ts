import { InvalidCredentialNameError } from './credential-input.js';
import { NulNotAllowedError } from './nul-guard.js';
import type { CredentialVaultStore } from './store.js';

/**
 * `CredentialVaultStore.put` の入口の約束（issue #2927。決めは teto の判断、2026-10-05）を、
 * **実装1つに対して**測る。3実装（インメモリ `testing.ts` / fs / pg）が同じ関数を呼ぶ
 * （`permission-grant-contract.ts` と同じ作法。vitest に依存しない素の非同期関数）。
 *
 * 測る性質:
 *
 * 1. 名前に NUL → `NulNotAllowedError`。何も書かない（同じ呼び出しの他の行も）
 * 2. 値に NUL → `NulNotAllowedError`。何も書かない
 * 3. `CREDENTIAL_NAME` に合わない名前（空文字を含む）→ `InvalidCredentialNameError`。
 *    戻り値にも `list()` にも出ない（以前は fs だけ戻り値に含めた）。値が空文字（「外す」）でも断る
 * 4. 例外の文に名前・値を載せない
 * 5. 正しい入力は従来どおり往復する
 *
 * 呼ぶ前のストアは空であること。終わったときは空に戻す。
 */
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

  // 1. 名前の NUL（同じ呼び出しの正しい行も書かない）。
  await rejects(
    '名前のNUL',
    [
      { name: 'CONTRACT_OK', value: 'ok' },
      { name: 'CONTRACT_\u0000NAME', value: 'v' },
    ],
    NulNotAllowedError,
    'CONTRACT_',
  );

  // 2. 値の NUL。
  await rejects(
    '値のNUL',
    [
      { name: 'CONTRACT_OK', value: 'ok' },
      { name: 'CONTRACT_NUL_VALUE', value: 'sec\u0000ret-value' },
    ],
    NulNotAllowedError,
    'ret-value',
  );

  // 3. 不正な名前。
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

  // 5. 正しい入力は往復する。
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

/**
 * `CredentialVaultStore.seedOnce`（印つきの1度だけの書き込み。2026-10-06）の約束を、
 * **実装1つに対して**測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * 測る性質:
 *
 * 1. 印が無ければ、行が無い名前だけを書き、**実際に書いた名前**を返す。scope / secret は
 *    渡したとおり（省略は `all` / `true`）
 * 2. 同じ印でもう1度呼んでも何も書かない（`[]`）
 * 3. **印は「消した」を覚える**——人間が消した名前を、同じ印の再呼び出しで蘇らせない
 * 4. 既に在る行は上書きしない（別の印で呼んでも。人間が置いた値が勝つ）
 * 5. 不正な入力は断り（`InvalidCredentialNameError` / `NulNotAllowedError`）、**印を消費しない**
 * 6. 空文字の値は書かない（「外す」の意味を持たせない）
 *
 * 呼ぶ前のストアは空であること。終わったときは空に戻す（印は残る。印の名前は呼び出しごとに
 * 一意にしてあるので、同じストアで何度呼んでも干渉しない）。
 */
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

  // 1. 初回: 行が無い名前を書き、書いた名前を返す。空文字は書かない。
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

  // 2. 同じ印の2回目は何も書かない。
  const second = await store.seedOnce(`${tag}-a`, [{ name: 'SEED_C', value: 'c-1' }]);
  if (second.length !== 0 || (await names()).includes('SEED_C')) {
    fail('同じ印の2回目は何も書かない', { second, now: await names() });
  }

  // 3. 人間が消した名前を、同じ印で蘇らせない。
  await store.put([{ name: 'SEED_A', value: '' }]);
  const third = await store.seedOnce(`${tag}-a`, [{ name: 'SEED_A', value: 'a-2' }]);
  if (third.length !== 0 || (await names()).includes('SEED_A')) {
    fail('消した名前は同じ印で蘇らない', { third, now: await names() });
  }

  // 4. 別の印でも、既に在る行は上書きしない。
  const fourth = await store.seedOnce(`${tag}-b`, [
    { name: 'SEED_B', value: 'b-2' },
    { name: 'SEED_D', value: 'd-1' },
  ]);
  if (!sameSet(fourth, ['SEED_D'])) fail('既に在る行は上書きしない', fourth);
  const keptB = (await store.list()).find((row) => row.name === 'SEED_B');
  if (keptB?.value !== 'b-1') fail('既に在る行の値が変わっていない', keptB?.value);

  // 5. 不正な入力は断り、印を消費しない。
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

  // 後始末。
  await store.put((await names()).map((name) => ({ name, value: '' })));
  const left = await names();
  if (left.length !== 0) fail('後始末: ストアが空に戻る', left);
}
