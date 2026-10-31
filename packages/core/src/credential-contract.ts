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
