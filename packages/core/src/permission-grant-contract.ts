import type { PermissionGrant } from './schema.js';
import type { PermissionGrantStore } from './store.js';
import { expectNulRejected } from './nul-contract-support.js';

/**
 * vitest に依存しない素の非同期関数にする: `storage-fs` / `storage-pg` へ vitest を持ち込まないため。
 * `PermissionGrantStore` の doc に書いてある約束だけを測る。実装が揃っているだけの挙動
 * （`list()` の並び・`put()` の必須欄検査）は契約にしない。1回だけの許可はストアの外にある。
 */
export async function verifyPermissionGrantStoreContract(
  store: PermissionGrantStore,
): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(`PermissionGrantStore contract violated: ${label} — ${JSON.stringify(detail)}`);
  }

  /** オブジェクトのキー順を揃えてから比較する（zod の parse でキー順が変わりうる）。 */
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonicalize(v)]),
      );
    }
    return value;
  }

  function assertSameShape(label: string, expected: unknown, actual: unknown): void {
    if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected))) {
      fail(label, { expected, actual });
    }
  }

  function omitRevokedAt(grant: PermissionGrant): Omit<PermissionGrant, 'revokedAt'> {
    const rest: Partial<PermissionGrant> = { ...grant };
    delete rest.revokedAt;
    return rest as Omit<PermissionGrant, 'revokedAt'>;
  }

  function makeGrant(id: string, grantedAt: string): PermissionGrant {
    return {
      id,
      rule: 'Bash(gh release edit:*)',
      allows: ['gh release edit'],
      denies: ['gh release edit; rm -rf /'],
      approvalId: `ap-${id}`,
      answer: '許可します',
      grantedAt,
      route: { principalKind: 'account', accountId: 'acc-1' },
    };
  }

  const missingId = 'permission-grant-contract-never-put-id';

  if ((await store.get(missingId)) !== null) {
    fail('無いidのget()はnull', await store.get(missingId));
  }

  const grantA = makeGrant('permission-grant-contract-a', '2026-01-01T00:00:00.000Z');
  await store.put(grantA);
  const readA = await store.get(grantA.id);
  if (readA === null) fail('putしたgrantがget()で読み戻る（null）', readA);
  assertSameShape('putしたgrantがget()でそのまま読み戻る（全欄一致）', grantA, readA);

  const listAfterA = await store.list();
  if (!listAfterA.some((g) => g.id === grantA.id)) {
    fail('putしたgrantがlist()に出る', listAfterA);
  }

  const revokeMissing = await store.revoke(missingId, '2026-01-02T00:00:00.000Z');
  if (revokeMissing !== null) fail('revoke(無いid)はnull', revokeMissing);

  const revokeAt = '2026-01-02T00:00:00.000Z';
  const revoked = await store.revoke(grantA.id, revokeAt);
  if (revoked === null) fail('revoke(在るid)はnullではない', revoked);
  if (revoked.revokedAt !== revokeAt) {
    fail('revoke()はrevokedAtを指定した時刻に立てる', revoked);
  }
  assertSameShape(
    'revoke()はrevokedAt以外の欄を変えない',
    omitRevokedAt(grantA),
    omitRevokedAt(revoked),
  );
  const readAfterRevoke = await store.get(grantA.id);
  if (readAfterRevoke === null || readAfterRevoke.revokedAt !== revokeAt) {
    fail('revoke()の結果はget()にも反映される', readAfterRevoke);
  }

  const secondRevokeAt = '2026-01-03T00:00:00.000Z';
  const revokedAgain = await store.revoke(grantA.id, secondRevokeAt);
  if (revokedAgain === null) fail('revoke(取り消し済み)はnullではない', revokedAgain);
  if (revokedAgain.revokedAt !== revokeAt) {
    fail('revoke(取り消し済み)は元のrevokedAtを保つ（上書きしない）', {
      first: revokeAt,
      attempted: secondRevokeAt,
      actual: revokedAgain.revokedAt,
    });
  }
  const readAfterSecondRevoke = await store.get(grantA.id);
  if (readAfterSecondRevoke === null || readAfterSecondRevoke.revokedAt !== revokeAt) {
    fail('二重revoke()後もget()のrevokedAtは最初のまま', readAfterSecondRevoke);
  }

  const markUsedMissing = await store.markUsed(missingId, '2026-01-01T00:00:00.000Z');
  if (markUsedMissing !== false) fail('markUsed(無いid)はfalse', markUsedMissing);

  const grantB = makeGrant('permission-grant-contract-b', '2026-01-01T00:00:00.000Z');
  await store.put(grantB);
  const usedAt1 = '2026-01-05T00:00:00.000Z';
  const markUsedResult1 = await store.markUsed(grantB.id, usedAt1);
  if (markUsedResult1 !== true) fail('markUsed(在るid・未取り消し)はtrue', markUsedResult1);
  const readBAfterUse1 = await store.get(grantB.id);
  if (readBAfterUse1 === null || readBAfterUse1.lastUsedAt !== usedAt1) {
    fail('markUsed()はlastUsedAtを指定した時刻へ進める', readBAfterUse1);
  }
  if (readBAfterUse1.revokedAt !== undefined) {
    fail('markUsed()はrevokedAtに触らない', readBAfterUse1);
  }

  const olderAt = '2026-01-04T00:00:00.000Z';
  const markUsedOlder = await store.markUsed(grantB.id, olderAt);
  if (markUsedOlder !== true) {
    fail('markUsed(既存より古い時刻)でもtrueを返す（doc「進めなかった回もtrue」）', markUsedOlder);
  }
  const readBAfterOlder = await store.get(grantB.id);
  if (readBAfterOlder === null || readBAfterOlder.lastUsedAt !== usedAt1) {
    fail('markUsed(既存より古い時刻)はlastUsedAtを戻さない', {
      expected: usedAt1,
      actual: readBAfterOlder?.lastUsedAt,
    });
  }

  const grantC = makeGrant('permission-grant-contract-c', '2026-01-01T00:00:00.000Z');
  await store.put(grantC);
  const revokedC = await store.revoke(grantC.id, '2026-01-02T00:00:00.000Z');
  if (revokedC === null) fail('準備: revoke(grantC)がnullではない', revokedC);
  const markUsedRevoked = await store.markUsed(grantC.id, '2026-01-06T00:00:00.000Z');
  if (markUsedRevoked !== false) {
    fail(
      'markUsed(取り消し済み)はfalse（doc「取り消されていれば記録せずfalse」）',
      markUsedRevoked,
    );
  }
  const readCAfter = await store.get(grantC.id);
  if (readCAfter === null) fail('markUsed(取り消し済み)後もget()はnullではない', readCAfter);
  if (readCAfter.lastUsedAt !== undefined) {
    fail('markUsed(取り消し済み)はlastUsedAtを記録しない', readCAfter);
  }
  if (readCAfter.revokedAt !== revokedC.revokedAt) {
    fail('markUsed(取り消し済み)はrevokedAtを変えない', readCAfter);
  }

  const before = (await store.list()).length;
  for (const [label, grant, secret] of [
    [
      'idのNUL',
      { ...makeGrant('permission-grant-contract-n\u0000ul', '2026-02-01T00:00:00.000Z') },
      'contract-n',
    ],
    [
      'approvalIdのNUL',
      {
        ...makeGrant('permission-grant-contract-ap', '2026-02-01T00:00:00.000Z'),
        approvalId: 'ap-\u0000-x',
      },
      'ap-',
    ],
    [
      'route.accountIdのNUL',
      {
        ...makeGrant('permission-grant-contract-ac', '2026-02-01T00:00:00.000Z'),
        route: { principalKind: 'account' as const, accountId: 'acc-\u0000-x' },
      },
      'acc-',
    ],
  ] as const) {
    await expectNulRejected(
      (message) => fail(message, null),
      label,
      () => store.put(grant),
      secret,
    );
  }
  if ((await store.list()).length !== before) fail('NULで断ったのに何かを書いた', before);
  const bodyNul: PermissionGrant = {
    ...makeGrant('permission-grant-contract-body', '2026-02-02T00:00:00.000Z'),
    rule: 'Bash(gh \u0000release:*)',
    allows: ['gh re\u0000lease'],
    denies: ['rm\u0000 -rf'],
    answer: '許可\u0000します',
  };
  await store.put(bodyNul);
  const readBody = await store.get(bodyNul.id);
  if (
    readBody === null ||
    readBody.rule !== 'Bash(gh release:*)' ||
    readBody.allows.join() !== 'gh release' ||
    readBody.denies.join() !== 'rm -rf' ||
    readBody.answer !== '許可します'
  ) {
    fail('本文のNULは落として残す', readBody);
  }

  const listBeforeRead = await store.list();
  const nulId = 'permission-grant-contract-n\u0000ul';
  const readOutcomes: Array<[string, () => Promise<unknown>, unknown]> = [
    ['get(NULを含むid)はnull', () => store.get(nulId), null],
    ['revoke(NULを含むid)はnull', () => store.revoke(nulId, '2026-03-01T00:00:00.000Z'), null],
    [
      'markUsed(NULを含むid)はfalse',
      () => store.markUsed(nulId, '2026-03-01T00:00:00.000Z'),
      false,
    ],
  ];
  for (const [label, call, expected] of readOutcomes) {
    let outcome: unknown;
    try {
      outcome = await call();
    } catch (error) {
      fail(`${label}（投げた: ${error instanceof Error ? error.name : typeof error}）`, null);
    }
    if (outcome !== expected) fail(label, outcome);
  }
  let removeOutcome: unknown;
  try {
    removeOutcome = await store.removeUnreadable([nulId]);
  } catch (error) {
    fail(
      `removeUnreadable(NULを含むid)は投げない（${error instanceof Error ? error.name : typeof error}）`,
      null,
    );
  }
  if (
    typeof removeOutcome !== 'object' ||
    removeOutcome === null ||
    (removeOutcome as { kind?: unknown }).kind !== 'unknown'
  ) {
    fail('removeUnreadable(NULを含むid)はunknown', removeOutcome);
  }
  if (JSON.stringify(await store.list()) !== JSON.stringify(listBeforeRead)) {
    fail('NULを含むidで読んだだけなのに行が変わった', null);
  }
}
