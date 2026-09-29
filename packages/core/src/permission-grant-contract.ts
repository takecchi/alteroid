import type { PermissionGrant } from './schema.js';
import type { PermissionGrantStore } from './store.js';

/**
 * `PermissionGrantStore`（Issue #863。doc は `store.ts`）の契約を、
 * **実装1つに対して**測る。
 *
 * 3実装（インメモリ `packages/core/src/testing.ts` / fs
 * `packages/storage-fs/src/permission-grants.ts` / pg
 * `packages/storage-pg/src/permission-grants.ts`）が同じ関数を呼ぶ形にして
 * あるのは `mcp-server-contract.ts` と同じ理由 —— 検査が器ごとに書き分け
 * られていると、乖離した器が緑のまま残る（#370）。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`storage-fs` /
 * `storage-pg` へ vitest を持ち込まないため。`mcp-server-contract.ts` と同じ）。
 *
 * **測るのは `PermissionGrantStore` interface の doc（`store.ts`）に書いて
 * ある約束だけである。** doc に書いていない挙動は、実装が3つとも揃って
 * いても新しい契約として決めない——迷ったら入れない:
 *
 * - **`list()` の並び**（`grantedAt` 昇順）は3実装とも揃っているが、それは
 *   各実装のコード注釈（例: `FsPermissionGrantStore.list()` の「3実装で
 *   揃える」コメント）が申し合わせているだけで、`PermissionGrantStore`
 *   interface の doc には書かれていない。ここでは測らない（fs / pg 個別の
 *   `index.test.ts` が「list は grantedAt 昇順で返る」を別途持つ）。
 * - **`put()` が必須欄の欠けた grant を拒むこと**（issue #2052 / PR #2065）も
 *   同様——fs / pg は書く前に `permissionGrantSchema.parse` を通し、
 *   インメモリも #2065 で揃えたが、`PermissionGrantStore.put` の doc
 *   自体はこれを約束していない（`McpServerStore.write` の doc が
 *   「書く前に `parseMcpServers` を通すこと（3実装とも）」と明示している
 *   のとは対照的）。ここでは測らない
 *   （`apps/daemon/src/permission-grant-put-validation.test.ts` が別に測る）。
 * - **1回だけの許可（issue #1768 / #1809 の `<=` 境界）** は
 *   `PermissionGrantStore` の外——`runner.ts` の `#consumeOneShotAllow` /
 *   `ONE_SHOT_ALLOW_TTL_MS`（クローン内の `Map`）にある別の仕組みで、この
 *   ストアの契約ではない。ここでは測らない。
 *
 * 測る性質:
 *
 * 1. `get()` / `list()` の基本往復。put した行がそのまま読み戻る
 *    （`route.principalKind` を含む全欄が一致）。無い id の `get()` は
 *    `null`。put した行は `list()` にも出る
 * 2. `revoke()`: 無い id は `null`
 * 3. `revoke()`: 在る id は `revokedAt` を立てて「書いた後の全体」を返す。
 *    `revokedAt` 以外の欄は変わらない
 * 4. `revoke()`: 既に取り消し済みの行への再度の `revoke()` は、元の
 *    `revokedAt` を保つ（上書きしない）——doc「既に取り消し済みなら元の
 *    revokedAt を保つ（上書きしない）」の逐語
 * 5. `markUsed()`: 無い id は `false`（何もしない）
 * 6. `markUsed()`: 在る id（取り消されていない）は `lastUsedAt` を進めて
 *    `true`。`revokedAt` には触らない
 * 7. `markUsed()`: 取り消し済みの行は記録せず `false` を返す——doc
 *    「取り消されていれば記録せず false を返す（Issue #1687）」の逐語。
 *    `lastUsedAt` / `revokedAt` のどちらも変わらない
 * 8. `markUsed()`: 既存より古い時刻では戻さない（それでも `true` を返す）
 *    ——doc「既存より古い時刻では戻さないこと」「既存より古い時刻で進め
 *    なかった回も true」の逐語
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

  // 1. get/list の基本往復。無い id の get() は null。
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

  // 2. revoke(): 無い id は null。
  const revokeMissing = await store.revoke(missingId, '2026-01-02T00:00:00.000Z');
  if (revokeMissing !== null) fail('revoke(無いid)はnull', revokeMissing);

  // 3. revoke(): 在る id は revokedAt を立てて全体を返す。revokedAt 以外は
  // 変わらない。
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

  // 4. revoke(): 既に取り消し済みの行への再度の revoke() は、元の
  // revokedAt を保つ（上書きしない）。
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

  // --- markUsed() ---

  // 5. markUsed(): 無い id は false（何もしない）。
  const markUsedMissing = await store.markUsed(missingId, '2026-01-01T00:00:00.000Z');
  if (markUsedMissing !== false) fail('markUsed(無いid)はfalse', markUsedMissing);

  // 6. markUsed(): 在る id（取り消されていない）は lastUsedAt を進めて
  // true。revokedAt には触らない。
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

  // 8. markUsed(): 既存より古い時刻では戻さない（それでも true を返す）。
  const olderAt = '2026-01-04T00:00:00.000Z'; // usedAt1 (01-05) より古い。
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

  // 7. markUsed(): 取り消し済みの行は記録せず false。lastUsedAt / revokedAt
  // のどちらも変わらない。
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
}
