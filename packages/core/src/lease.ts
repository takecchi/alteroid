import type { JobLease } from './schema.js';

// 写しである: 正本は `railway/runner.json` の `drainingSeconds` と `compose.yaml`（`runner`）の `stop_grace_period` で、実行中のプロセスからは読めない。runner 側にも同じ数の写し（`apps/runner/src/index.ts` の `SHUTDOWN_GRACE_MS`）があり、変えるときは両方変えること。
export const LEASE_DRAIN_MS = 60_000;

// デーモン自身の入れ替えより長くする: 短いと、デーモンだけを再デプロイしている間に runner が走行中のマネージャーを自分で畳んでしまう。
// 長すぎると経路だけが分かれたときの二重実行の窓がこの長さになり、短すぎると連絡が切れただけで走行中のターンの手が止まる。
export const LEASE_TTL_MS = 10 * 60_000;

// 0 にしない: 期限ちょうどで引き取ると、相手が畳み終わる前に新しい方が動き出しうる。
export const LEASE_MARGIN_MS = 30_000;

export interface LeaseSighting {
  runnerId: string;
  instanceId?: string;
  // 「入れ替えを観測した時刻」ではなく「いまの相手を初めて見た時刻」: デーモンの再起動直後は入れ替えの瞬間を知らず、知らない時刻を過去に見積もると、まだ畳まれていない器の仕事を奪いに行く。
  instanceSince?: number;
  // 名簿は `label` ごとに行を持つので、同じ名前の行が2つ並びうる。そのときは、どちらの instanceId と突き合わせるかを決める材料が無い。
  duplicates?: number;
}

export type LeaseVerdict =
  | { kind: 'unheld' }
  // `unheld` と進み方は同じだが言えることが違う: こちらは持ち主が終わったと言った。世代（`fence`）は残るので、貸し直しは数え直しではなく続きになる。
  | { kind: 'released'; lease: JobLease }
  | { kind: 'same-holder'; lease: JobLease }
  | { kind: 'expired'; because: 'drained' | 'ttl'; lease: JobLease }
  | { kind: 'held'; claimableAt: number; lease: JobLease }
  // 引き取りは許す: 許さないと、名乗らない runner のジョブが永久に引き取れなくなる。ただし「奪っていない」とは言えない。
  | { kind: 'undecidable'; lease: JobLease }
  // `undecidable`（判定材料が無い）とは別: こちらは「宛先が一意でない」と分かっていて、それ自体が危険の証拠。1つに畳むと、`undecidable` を許す理由が併存の危険まで通してしまう。
  // `claimableAt` を持たない: 併存は人間が `ALTEROID_RUNNER_ID` を直すまで解けず、時刻を返すと待てば通ると誤って伝える。
  // `runnerId` は `answering.runnerId`（`lease.runnerId` ではない）: この判定は `lease.runnerId !== answering.runnerId` の枝より前に成り立つので、`lease.runnerId` を報告すると重複していない方の名前を出してしまう。
  | { kind: 'ambiguous'; lease: JobLease; runnerId: string; duplicates: number };

// ホワイトリストにする: `verdict.kind !== 'held'` だと、判定を足すたびにその既定が「引き取ってよい」（危険側）になる。未知の判定は断る側へ落とす。
// 断られた側は挑み直しで回復できるが、誤って許して二重に走らせると `gh pr create` のような操作が二度走り取り返しがつかない。
export function mayClaim(verdict: LeaseVerdict): boolean {
  return (
    verdict.kind === 'unheld' ||
    verdict.kind === 'released' ||
    verdict.kind === 'same-holder' ||
    verdict.kind === 'expired' ||
    verdict.kind === 'undecidable'
  );
}

export function judgeLease(input: {
  lease: JobLease | undefined;
  now: number;
  answering: LeaseSighting;
}): LeaseVerdict {
  const { lease, now, answering } = input;
  if (lease === undefined) return { kind: 'unheld' };
  if (lease.releasedAt !== undefined) return { kind: 'released', lease };

  /*
   * 併存（同じ `runnerId` を名乗る器が2台以上）はここで即答し、`decideAfterSwap` へ流さない: あれは「器が入れ替えのときに古いプロセスを畳む」前提だが、併存は2台とも生きたまま並んでいるので成り立たない。流すと、猶予を過ぎた瞬間にもう一方が動いたままなのに「奪ってよい」となり、「もう動いていないと言えた」という嘘が記録に残る。
   * `unheld` / `released` より後に置く: あの2つは `answering` を見ずに台帳だけで言えるので宛先が一意でなくても意味が変わらず、これより下は全部 `answering` を見る。
   * `unheld` は併存でも引き取れる（塞がない）: 塞ぐと「この欄より前の委譲を締め出さない」という `unheld` 自身の約束を壊す。
   */
  if (answering.duplicates !== undefined && answering.duplicates > 1) {
    return {
      kind: 'ambiguous',
      lease,
      runnerId: answering.runnerId,
      duplicates: answering.duplicates,
    };
  }

  const seenAt = Date.parse(lease.seenAt);
  /*
   * 読めない時刻で `expired` と断言しない: 「もう動いていない」という主張は読めない時刻から出てこない。`held` にもしない: 直せるのは書いた側だけで、永久に引き取れなくなる。
   * 到達性が低くても断言してよい理由にならない。
   */
  if (Number.isNaN(seenAt)) return { kind: 'undecidable', lease };
  const ttlDeadline = seenAt + lease.ttlMs + LEASE_MARGIN_MS;

  if (lease.runnerId !== answering.runnerId) {
    return now >= ttlDeadline
      ? { kind: 'expired', because: 'ttl', lease }
      : { kind: 'held', claimableAt: ttlDeadline, lease };
  }

  /*
   * 貸したときの持ち主が名乗っていなかった場合も、一律に「判定できない」へ倒さない: 倒すと、その委譲は以後ずっと無防備になり、器が入れ替わっても猶予を待たずに引き取られる。
   * いま応えているプロセスを貸す前から見ているなら貸した相手はこのプロセスで、貸した後に現れたなら入れ替わっている。
   */
  if (lease.instanceId === undefined && answering.instanceId !== undefined) {
    const since = answering.instanceSince;
    const granted = Date.parse(lease.grantedAt);
    if (since === undefined || Number.isNaN(granted)) return { kind: 'undecidable', lease };
    if (since <= granted) return { kind: 'same-holder', lease };
    return decideAfterSwap({ lease, now, answering, ttlDeadline });
  }

  // 名乗らない側を「入れ替わっていない」と読まない。
  if (lease.instanceId === undefined || answering.instanceId === undefined) {
    return { kind: 'undecidable', lease };
  }

  if (lease.instanceId === answering.instanceId) return { kind: 'same-holder', lease };

  return decideAfterSwap({ lease, now, answering, ttlDeadline });
}

// `drained` は「器が入れ替えのときに古いプロセスを畳む」約束（Railway の `drainingSeconds` / compose の `stop_grace_period`）に乗っていて、`ttl` と独立な材料ではない。
// 古いプロセスを畳まない構成では `drained` が `ttl` を追い越して先に成立し、その差のあいだ二重実行が起きうる。約束が変わったらここも変えること。
// 遅い方を待つ形にしない: 通常の再デプロイのたびに引き取りが自己失効の猶予（既定10分）まで遅れる。
function decideAfterSwap(input: {
  lease: JobLease;
  now: number;
  answering: LeaseSighting;
  ttlDeadline: number;
}): LeaseVerdict {
  const { lease, now, answering, ttlDeadline } = input;
  const drainDeadline = (answering.instanceSince ?? now) + LEASE_DRAIN_MS + LEASE_MARGIN_MS;
  if (now >= drainDeadline) return { kind: 'expired', because: 'drained', lease };
  if (now >= ttlDeadline) return { kind: 'expired', because: 'ttl', lease };
  return { kind: 'held', claimableAt: Math.min(drainDeadline, ttlDeadline), lease };
}

// 世代は返却済みの貸し出しからも進める（数え直さない）: 数え直すと、返却の知らせが遅れて届いたとき runner が覚えている世代より小さい世代を渡し、生きているマネージャーへの命令が拒まれ続ける。
export function grantLease(input: {
  previous: JobLease | undefined;
  runnerId: string;
  instanceId?: string;
  now: number;
  ttlMs?: number;
}): JobLease {
  const at = new Date(input.now).toISOString();
  return {
    runnerId: input.runnerId,
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    fence: (input.previous?.fence ?? 0) + 1,
    grantedAt: at,
    seenAt: at,
    ttlMs: input.ttlMs ?? LEASE_TTL_MS,
  };
}

// 確かめていない停止で返さない: まだ走っているセッションを別の器が期限を待たずに引き取れてしまう。
// 移送先が resume を 4xx で断った場合は返してよい（命令を受け取っていないと確かめられている）。408 / 429 / 5xx や応答なしは、受け取ったかが分からないので返さない。
export function releaseLease(lease: JobLease, now: number): JobLease {
  return { ...lease, releasedAt: new Date(now).toISOString() };
}

// 世代を進めない: 生存の確認は引き取りではなく、進めると runner が持つ世代より新しい世代が台帳に載り、次の命令が拒まれる。
export function touchLease(lease: JobLease, now: number): JobLease {
  return { ...lease, seenAt: new Date(now).toISOString() };
}

// `runnerId` は `answering.runnerId` を渡すこと（`lease.runnerId` ではない）。`describeVerdict` と `manager.ts` の `#reattach` の両方から呼ぶ: 同じ状態を別の文言で伝えると、別の問題が2つ在ると誤解される。
export function describeAmbiguousSighting(runnerId: string, duplicates: number): string {
  return (
    `runnerId=${runnerId} を名乗る器が ${duplicates} 台開いている（名前が一意でない）。` +
    'どちらが持ち主か決められない（名簿は線形一致で先に見つかった方を黙って返すので、判定した相手と話す相手が食い違いうる）。' +
    '**引き取らない。** 時間では解けない — このまま待っても宛先の一意性は自然には戻らない。' +
    '直し方: 器ごとに違う ALTEROID_RUNNER_ID を設定すること（既定は runner-primary なので、2台目の置き忘れで重なる）。' +
    'Railway なら ./railway/scale-runners.sh が id を振る。直れば自動で引き取る'
  );
}

export function describeVerdict(verdict: LeaseVerdict): string {
  switch (verdict.kind) {
    case 'unheld':
      return '貸し出しの記録が無い（この欄より前の委譲か、まだ貸し出していない）';
    case 'released':
      return `持ち主が返している（そのセッションは終わったと本人が言った。返却=${verdict.lease.releasedAt ?? '不明'} / 世代=${verdict.lease.fence}）`;
    case 'same-holder':
      return `いま応えているプロセスが持ち主である（instanceId=${verdict.lease.instanceId ?? '未名乗り'} / 世代=${verdict.lease.fence}）。奪ってはいない`;
    case 'expired':
      return verdict.because === 'drained'
        ? `持ち主のプロセスは器の入れ替えで畳まれている（畳む猶予を過ぎた。前の instanceId=${verdict.lease.instanceId ?? '未名乗り'}）`
        : `持ち主のプロセスは自分で失効したと言える（貸し出し期限 ${verdict.lease.ttlMs}ms を過ぎた。最後の生存確認=${verdict.lease.seenAt}）`;
    case 'held':
      return `まだ持ち主が握っている（instanceId=${verdict.lease.instanceId ?? '未名乗り'} / 引き取れるのは ${new Date(verdict.claimableAt).toISOString()} 以降）`;
    case 'undecidable':
      return `入れ替わったかを**判定できない**（どちらかが instanceId を名乗らない）。引き取るが、生きている器の仕事を奪っていないことは確かめられていない`;
    case 'ambiguous':
      // `verdict.lease.runnerId` ではなく `verdict.runnerId` を使う: 台帳が別の宛先を指していると、重複していない方の名前を報告してしまう。
      return describeAmbiguousSighting(verdict.runnerId, verdict.duplicates);
  }
}
