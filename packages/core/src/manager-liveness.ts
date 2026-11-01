import type { ManagerRecord, ManagerSummary } from './manager.js';
import type { Job } from './schema.js';

// 宛先が書かれていない委譲は引かない: どの器に居たのかをこの情報だけでは決められない。
export function lostSinceOf(
  record: ManagerRecord,
  silentRunners: ReadonlyMap<string, string>,
): string | undefined {
  return record.job.runnerId === undefined ? undefined : silentRunners.get(record.job.runnerId);
}

// `status !== 'running'` なら常に `undefined`: `done` で畳まれた委譲の宛先が後から消えても「running のまま残っている」症状ではない。
// 時刻は返さない（`ManagerSummary.runnerVanished` の doc「時刻を持たない」）。
export function vanishedOf(
  record: ManagerRecord,
  registeredRunnerIds: ReadonlySet<string> | null,
): true | undefined {
  if (record.job.status !== 'running') return undefined;
  // 判定できない回は立てない。
  if (registeredRunnerIds === null) return undefined;
  const runnerId = record.job.runnerId;
  if (runnerId === undefined) return undefined;
  if (registeredRunnerIds.has(runnerId)) return undefined;
  return true;
}

export function runnerListedAtOf(
  job: Pick<Job, 'id' | 'runnerId'>,
  silentRunners: ReadonlyMap<string, string>,
  sessions: ReadonlyMap<string, { ids: ReadonlySet<string>; observedAt: string }>,
): string | undefined {
  const runnerId = job.runnerId;
  if (runnerId === undefined) return undefined;
  if (silentRunners.has(runnerId)) return undefined;
  const observed = sessions.get(runnerId);
  if (observed === undefined) return undefined;
  return observed.ids.has(job.id) ? observed.observedAt : undefined;
}

// 像が `#records` に載っていること自体を「話しかけられる」の根拠にしない: `#load()` が作った像は戻れるかを確かめておらず、`status: lost` と `live: true` の両立しない組が出る。
export function isLive(record: ManagerRecord, silentRunners: ReadonlyMap<string, string>): boolean {
  // `lost` は何より先に見る: `#resume` は `await runner.resume(...)` の直後に楽観的に `attached = true` を書くので、
  // その間に `resume_failed` が届くと `lost` の像が `attached: true` で立つ。
  // `stopped` も同じ列に置く: `abort()` が `runner.list()` を探ってセッションが消えたことを確かめた事実で、`job.sessionId` は消さないので、
  // 下の `sessionId` 分岐に任せると停止後も `live: true` に化ける。
  if (record.job.status === 'lost' || record.job.status === 'stopped') return false;
  // 宛先の器が黙ったなら下の2つを見ない: `attached` / `sessionId` はイベント駆動でしか更新されず、器が合図なしに消えると `attached` が `true` のまま残る。
  // 足すのはデーモンが既に確定させた判定（名簿の `state: 'lost'`）だけ。`status` は動かさない: 黙っているのが器なのか経路なのかは片側から決められない。
  // 言えるのは「置き先として数えない」まで、「いま話しかけられない」とは言えない:
  // この行が `false` を返す委譲へ `ManagerPool.send()` を撃つと `outcome: 'delivered'` が返り、runner の resume の口が実際に叩かれた実測がある。
  // `silentRunners` と `send()` が通る `Registry#get()` は同じ名簿の違う面で、`#markSilent` は `entry.client` を落とさず `get()` は `entry.state` を見ない。
  // `live: false` を「送っても届かない」と読み替えない。
  //
  // `vacating`（意図して空けている最中）は `false` に倒さない:
  // 1. `live: false` には理由を1つだけ名指しする欄（`runnerLostSince`）が対に在り、`vacating` を倒すと理由を名乗れない `false` ができる。
  // 2. `live` は「話しかけられるか」しか言わない。`vacating` な器は heartbeat が続いており、置き先から外れることとは別である。
  // 3. `#silentRunners` のホワイトリストに `vacating` を足さない（黙った結果ではなく空けると決めた結果）。
  if (record.job.runnerId !== undefined && silentRunners.has(record.job.runnerId)) return false;
  if (record.attached) return true;
  // 「戻れなかった（`lost`）」と「戻る先が無い（session_id なし）」を潰さない: `status` と `sessionId` が別々に持つ。
  // ここで言えるのは「戻せないことの証明ではない」水準まで（`#runnerNotOpenDetail` と同じ）。
  return record.job.sessionId !== undefined;
}

// `isLive()` の返り値は読まない独立した集計にする: 数えるのは「`isLive()` が嘘をついている本数」ではなく、それを包む「宛先が名簿からまるごと消えている本数」。
export function vanishedRunnerBacklog(
  summaries: readonly ManagerSummary[],
  registeredRunnerIds: ReadonlySet<string>,
): ReadonlyMap<string, { count: number; oldestStartedAt: string }> {
  const backlog = new Map<string, { count: number; oldestStartedAt: string }>();
  for (const summary of summaries) {
    if (summary.status !== 'running') continue;
    if (summary.runnerId === undefined) continue;
    if (registeredRunnerIds.has(summary.runnerId)) continue;
    const existing = backlog.get(summary.runnerId);
    if (existing === undefined) {
      backlog.set(summary.runnerId, { count: 1, oldestStartedAt: summary.startedAt });
    } else {
      existing.count += 1;
      if (summary.startedAt < existing.oldestStartedAt) {
        existing.oldestStartedAt = summary.startedAt;
      }
    }
  }
  return backlog;
}
