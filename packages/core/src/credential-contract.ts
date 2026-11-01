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

  // 外した名前の控え（#6126）
  const pending = async (): Promise<string[]> => store.listPendingRemovals();
  const expectPending = async (label: string, expected: string[]): Promise<void> => {
    const actual = await pending();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(label, { expected, actual });
  };

  await expectPending('前提: 外した名前の控えが空', []);
  await store.updatePendingRemovals({
    add: ['CONTRACT_B', 'CONTRACT_A', 'CONTRACT_B'],
    forget: [],
  });
  await expectPending('足した名前を昇順で返す（重複は1つ）', ['CONTRACT_A', 'CONTRACT_B']);
  await store.updatePendingRemovals({ add: ['CONTRACT_C'], forget: ['CONTRACT_A'] });
  await expectPending('足す・忘れるを一度に渡せる。入力に無い名前は触らない', [
    'CONTRACT_B',
    'CONTRACT_C',
  ]);
  await store.updatePendingRemovals({ add: ['CONTRACT_D'], forget: ['CONTRACT_D'] });
  await expectPending('同じ名前が両方にあれば忘れる側が勝つ', ['CONTRACT_B', 'CONTRACT_C']);
  await store.updatePendingRemovals({ add: [], forget: ['CONTRACT_NEVER_ADDED'] });
  await expectPending('覚えていない名前を忘れても何も起きない', ['CONTRACT_B', 'CONTRACT_C']);

  await store.put([{ name: 'CONTRACT_OK', value: 'ok' }]);
  await expectPending('行の書き込みで控えを消さない', ['CONTRACT_B', 'CONTRACT_C']);
  await store.put([{ name: 'CONTRACT_OK', value: '' }]);

  for (const bad of ['', 'lower_case', '../../etc/x', 'CONTRACT_\u0000NAME']) {
    let thrown: unknown;
    try {
      await store.updatePendingRemovals({ add: ['CONTRACT_E', bad], forget: [] });
    } catch (error) {
      thrown = error;
    }
    const expected = bad.includes('\u0000') ? NulNotAllowedError : InvalidCredentialNameError;
    if (!(thrown instanceof expected)) {
      fail(`外した名前の控えは不正な名前(${JSON.stringify(bad)})を${expected.name}で断る`, {
        thrown: thrown === undefined ? '(投げなかった)' : String(thrown),
      });
    }
    await expectPending('不正な名前が1件でもあれば何も書かない', ['CONTRACT_B', 'CONTRACT_C']);
  }

  await store.updatePendingRemovals({ add: [], forget: ['CONTRACT_B', 'CONTRACT_C'] });
  await expectPending('忘れて空に戻る', []);
}
