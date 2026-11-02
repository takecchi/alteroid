import { judgeLease, type LeaseSighting, type LeaseVerdict } from './lease.js';
import type { RunnerEntry } from './runner-protocol.js';
import type { Job } from './schema.js';

// 名簿（`RunnerRegistry#entries()` の写し）を引数で受けて読むだけの関数群。`Pool` の欄は書かず、runner も叩かない。

/**
 * ここで新たに runner を叩かない: `RunnerRegistry#entries()` が10秒ごとの生存確認で立てた判定を読むだけで、一覧を出すたびに往復を増やさない。
 *
 * `state === 'lost'` だけを採る（ホワイトリスト）: `connecting` / `unreachable` / `unusable` は「まだ一度も開けていない」側で、
 * 数え漏らしても「今までどおり `live` を計算する」に倒れるだけである。
 * `vacating` も数えない: 黙ったのではなく空けると決めた結果で、名乗り自体は続いている。
 * `runnerId` を名乗れていない行も数えない: どの委譲に当たるか決められないまま `live` を倒すことになる。
 */
export function silentRunnersOf(entries: readonly RunnerEntry[]): ReadonlyMap<string, string> {
  const silent = new Map<string, string>();
  for (const entry of entries) {
    if (entry.state !== 'lost') continue;
    if (entry.runnerId === undefined) continue;
    silent.set(entry.runnerId, entry.since);
  }
  return silent;
}

/**
 * `silentRunnersOf` とは見ている軸が違う: あちらは `state === 'lost'` だけを拾い、こちらは state を問わず entry の有無だけを見る
 * （entry がまるごと消えている runnerId を見分けるため）。
 *
 * 名乗っていない entry が1本でも在れば `null`（判定できない）を返す: 起動し直した直後は最初の `#open()` が成功するまで
 * entry は `runnerId` を持たず、読み飛ばすと数秒後に繋がる runner の委譲まで全部「名簿から消えた」と出る。
 * 偽の「消えた」より黙っているほうが安全側で、本当に消えていれば後の呼びで立つ（呼ぶ側は `null` なら印も計器も立てない）。
 * 代償として、名乗らない runner（古い器）が常駐する構成ではこの判定は常に「判定できない」になる。
 */
export function registeredRunnerIdsOf(entries: readonly RunnerEntry[]): ReadonlySet<string> | null {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.runnerId === undefined) return null;
    ids.add(entry.runnerId);
  }
  return ids;
}

/**
 * 同じ `runnerId` の行が複数在るときは和を採る（畳まれつつある旧い器と新しい器が並びうる）: どれか1台でも「抱えている」と答えたなら
 * 抱えている側へ倒す。片方の空の答えで「セッションが消えた」と名乗ると、まだ生きている器を持つ委譲に ⚠ が付く。
 * 聞けていない行（`sessions` が無い）は数に入れない。
 */
export function runnerSessionsOf(
  entries: readonly RunnerEntry[],
): ReadonlyMap<string, { ids: ReadonlySet<string>; observedAt: string }> {
  const seen = new Map<string, { ids: Set<string>; observedAt: string }>();
  for (const entry of entries) {
    if (entry.runnerId === undefined) continue;
    if (entry.sessions === undefined || entry.sessionsObservedAt === undefined) continue;
    const before = seen.get(entry.runnerId);
    if (before === undefined) {
      seen.set(entry.runnerId, {
        ids: new Set(entry.sessions),
        observedAt: entry.sessionsObservedAt,
      });
      continue;
    }
    for (const id of entry.sessions) before.ids.add(id);
    if (entry.sessionsObservedAt.localeCompare(before.observedAt) > 0) {
      before.observedAt = entry.sessionsObservedAt;
    }
  }
  return seen;
}

/**
 * 同じ名前を名乗る器が2台以上開いているときは instanceId を採らず台数を返す: どちらと突き合わせるか決める材料が無く、片方を選べば話しかける相手（`Registry#get` の線形一致）と判定した相手が食い違いうる。
 * 食い違ったまま `same-holder` と答えるのが一番危ない（奪っていないつもりで奪う）ので、台数（`duplicates`）を返して `judgeLease` を `ambiguous` へ倒す。
 * 名簿に居ない回は「一意でない」とは別なので `{ runnerId }` だけを返す。
 */
export function sightingOf(entries: readonly RunnerEntry[], runnerId: string): LeaseSighting {
  const matches = entries.filter((entry) => entry.runnerId === runnerId);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) {
    return matches.length > 1 ? { runnerId, duplicates: matches.length } : { runnerId };
  }
  const since = only.instanceSince === undefined ? NaN : Date.parse(only.instanceSince);
  return {
    runnerId,
    ...(only.instanceId === undefined ? {} : { instanceId: only.instanceId }),
    ...(Number.isNaN(since) ? {} : { instanceSince: since }),
  };
}

/** 行が0本のときは `false`: 「開けていた宛先から動いてよい」と確かめられていない以上、移送してよいとは言えない。`vacating` は「黙った」のではなく「空けると決めた」だけなので `lost` と同じ側に立つ。 */
export function shouldRelocateFromRoster(
  entries: readonly RunnerEntry[],
  runnerId: string,
): boolean {
  const matches = entries.filter((entry) => entry.runnerId === runnerId);
  return (
    matches.length > 0 &&
    matches.every((entry) => entry.state === 'lost' || entry.state === 'vacating')
  );
}

/** 同じ名前の行が2つ以上あれば遅い方を採る: 早い方を採ると、まだ名乗っている側の委譲を引き取れることにしてしまう。 */
export function lastSeenAtOf(
  entries: readonly RunnerEntry[],
  runnerId: string,
): number | undefined {
  const seen = entries
    .filter((entry) => entry.runnerId === runnerId && entry.lastSeenAt !== undefined)
    .map((entry) => Date.parse(entry.lastSeenAt as string))
    .filter((at) => !Number.isNaN(at));
  return seen.length === 0 ? undefined : Math.max(...seen);
}

/**
 * 引き取りの判定の材料を組むのはここだけ: `#claimForResume` の関門と `#reattach` の移送の前の覗き見が別々に組むと、片方だけ材料が欠ける。
 * 持ち主の名乗りを最後に聞けた時刻（`holderSeenAt`）を添える理由は `judgeLease` の doc（#4454）。
 */
export function judgeClaimAgainst(
  entries: readonly RunnerEntry[],
  lease: Job['lease'],
  runnerId: string,
  now: number,
): LeaseVerdict {
  const holderSeenAt = lease === undefined ? undefined : lastSeenAtOf(entries, lease.runnerId);
  return judgeLease({
    lease,
    now,
    answering: sightingOf(entries, runnerId),
    ...(holderSeenAt === undefined ? {} : { holderSeenAt }),
  });
}

/**
 * 判定材料を貸し出し（`job.lease.instanceId`）にしない: `#claimForResume` は `runner.resume()` の前に新しい `instanceId` を書くので、関門を通った後に resume が失敗すると「もう告げた」と読めて二度と告げられなくなる。セッションが実際に載ったと確かめた回にだけ進む `job.sessionInstanceId` を見る。
 * 時刻ではなく `instanceId` 同士を直接比べる: 時刻の比較は初回観測を入れ替えと誤読する。どちらか一方でも取れなければ「判定できない」（`false`）で、併存のときも `sightingOf` が `instanceId` を返さずここへ落ちる。
 * 宛先の名前（`runnerId`）は見ない: 移送された委譲でも `instanceId` が違えば別の `/workspace` で、条件に足すと移送された委譲にだけ告げない穴ができる。
 * 像ではなく `Job` に持たせる: 像にだけ持たせると、デーモンの再起動で判定材料が消え、`done` の委譲は告げる機会を失う。
 * この欄が無い古い行だけ貸し出しへ落とす: 落とさなければ1回も告げず、落とせば失敗した回でも元の穴と同じ所へ落ちるだけで、どの筋でも悪くならない。
 */
export function runnerSwappedSince(
  job: Pick<Job, 'sessionInstanceId' | 'lease'>,
  answeringInstanceId: string | undefined,
): boolean {
  // `??` で書く: `sessionInstanceId` が在ればそれだけを見て、貸し出しは見ない。
  const recorded = job.sessionInstanceId ?? job.lease?.instanceId;
  if (recorded === undefined) return false;
  if (answeringInstanceId === undefined) return false;
  return recorded !== answeringInstanceId;
}

/**
 * `fromRunnerId` を見るのは `case 'closed'` / `case 'resume_failed'` だけ: 古い runner から遅れて届いた出来事が、別の runner へ移った後の委譲の台帳・貸し出しを巻き戻すのを防ぐ。`RunnerEvent` 自身は `runnerId` を運ばない。
 */
export function swapNoteOf(after: string | undefined, before: string | undefined): string {
  if (before === undefined || after === undefined) {
    return 'runner の器の入れ替えの前後かは判定できない（instanceId を名乗っていない）';
  }
  return before === after
    ? `runner の器は入れ替わっていない（instanceId=${after}）`
    : `runner の器が入れ替わっていた（参照を受けた時の instanceId=${before}、取りに行った時=${after}）。預けたプロセスは既に居ない`;
}

// 名簿が判定不能なら移ったとは言わない（`case 'closed'` / `'resume_failed'` と同じ）。
export function movedAwayOf(
  jobRunnerId: string | undefined,
  fromRunnerId: string,
  registered: ReadonlySet<string> | null,
): boolean {
  return (
    jobRunnerId !== undefined &&
    jobRunnerId !== fromRunnerId &&
    registered !== null &&
    registered.has(jobRunnerId)
  );
}
