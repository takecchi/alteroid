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
