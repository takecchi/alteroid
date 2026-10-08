import { DuplicateTokenIdError } from './token-pool-input.js';
import { NulNotAllowedError } from './nul-guard.js';
import type { TokenPoolStore } from './store.js';
import type { AgentToken } from './token-pool.js';

export async function verifyTokenPoolContract(store: TokenPoolStore): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(`TokenPoolStore contract violated: ${label} — ${JSON.stringify(detail)}`);
  }

  const base = (id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken => ({
    id,
    label: `label-${id}`,
    value: `value-${id}`,
    source: 'stored',
    order,
    ...extra,
  });

  if ((await store.list()).length !== 0) fail('前提: プールが空', null);
  if ((await store.readActive()) !== null) fail('前提: 現役の指名が無い', null);

  const keep = base('keep-1', 0);
  await store.replace([keep]);

  async function rejectsReplace(
    label: string,
    tokens: readonly AgentToken[],
    expected: typeof NulNotAllowedError | typeof DuplicateTokenIdError,
    secret: string,
  ): Promise<void> {
    let thrown: unknown;
    try {
      await store.replace(tokens);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof expected)) {
      fail(`${label}は${expected.name}で断る`, {
        thrown: thrown === undefined ? '(投げなかった)' : String(thrown),
      });
    }
    if (thrown.message.includes(secret)) fail(`${label}の例外の文に値を載せない`, thrown.message);
    const after = await store.list();
    if (after.length !== 1 || after[0]?.id !== 'keep-1') {
      fail(
        `${label}では何も変えない`,
        after.map((row) => row.id),
      );
    }
  }

  await rejectsReplace(
    '重複id',
    [base('dup-id', 0), base('dup-id', 1)],
    DuplicateTokenIdError,
    'dup-id',
  );
  await rejectsReplace('idのNUL', [base('id-\u0000-nul', 0)], NulNotAllowedError, 'id-');
  await rejectsReplace(
    'valueのNUL',
    [base('tok-v', 0, { value: 'sec\u0000ret-token' })],
    NulNotAllowedError,
    'ret-token',
  );

  const stored = await store.replace([
    base('body-1', 0, {
      label: 'la\u0000bel',
      lastRejectedReason: 'rea\u0000son',
      invalidatedReason: 'inv\u0000alid',
    }),
  ]);
  const row = stored[0];
  if (
    stored.length !== 1 ||
    row?.id !== 'body-1' ||
    row.label !== 'label' ||
    row.lastRejectedReason !== 'reason' ||
    row.invalidatedReason !== 'invalid' ||
    row.value !== 'value-body-1'
  ) {
    fail('本文のNULは落として残す', stored);
  }
  const reread = (await store.list())[0];
  if (reread?.label !== 'label' || reread.lastRejectedReason !== 'reason') {
    fail('本文のNULを落とした形で読み戻る', reread);
  }

  let thrown: unknown;
  try {
    await store.writeActive({
      tokenId: 'act-\u0000-id',
      generation: 1,
      rotatedAt: '2026-10-05T00:00:00.000Z',
    });
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof NulNotAllowedError)) {
    fail('tokenIdのNULはNulNotAllowedErrorで断る', {
      thrown: thrown === undefined ? '(投げなかった)' : String(thrown),
    });
  }
  if ((await store.readActive()) !== null) fail('tokenIdのNULでは指名を変えない', null);

  await store.replace([]);
}
