import { definedProps } from './defined-props.js';
import type {
  ManagerSummary,
  RunnerBacklogSnapshot,
  RunnerManagerEntry,
  RunnerOverview,
} from './manager.js';
import type { RunnerFingerprintProbe } from './runner-probe.js';
import type { PidsSaturation, RunnerEntry, RunnerPlacementResources } from './runner-protocol.js';
import type { RunnerPushHealth } from './push-ledger.js';

// `Pool#runners`（`manager.ts`）が組み立てる 3 つの形を、状態にも時計にも触れない同期の純関数として切り出したもの。
// `await`・`Promise.all`・`probeRunnerFingerprint` の呼び順・`#runnerBacklog.set`・`this.#nowIso()`・`healthOf`・`pidsSaturationOf`・`managerPeersOf` の
// 呼び出しは `Pool#runners` に残り、ここへは結果だけが引数で届く（評価の順は切り出し前と同じ）。

/** `probeRunnerFingerprint` の戻り（`value` と、それを併せて返す `probe`）。 */
interface Probed<T> {
  value: T | undefined;
  probe: RunnerFingerprintProbe | undefined;
}

export function bucketManagersByRunner(managers: readonly ManagerSummary[]): {
  byRunner: Map<string, RunnerManagerEntry[]>;
  unassigned: RunnerManagerEntry[];
} {
  // `runnerId` が無い分はどの器にも混ぜず別枠へ: 0 に畳むと「記録が無いマネージャーは存在しない」と読める。
  const byRunner = new Map<string, RunnerManagerEntry[]>();
  const unassigned: RunnerManagerEntry[] = [];
  for (const manager of managers) {
    // `live` を落とさない: 落とすと `runner_list` の側でだけ「走行中」と「走行中だがセッション切断」が潰れる（`RunnerManagerEntry` の doc）。
    const item: RunnerManagerEntry = {
      managerId: manager.managerId,
      status: manager.status,
      live: manager.live,
      ...definedProps({
        awaitingBackground: manager.awaitingBackground,
        tokenGeneration: manager.tokenGeneration,
        activeTokenGeneration: manager.activeTokenGeneration,
        tokenGenerationUnknownReason: manager.tokenGenerationUnknownReason,
      }),
    };
    if (manager.runnerId === undefined) {
      unassigned.push(item);
      continue;
    }
    const bucket = byRunner.get(manager.runnerId);
    if (bucket) bucket.push(item);
    else byRunner.set(manager.runnerId, [item]);
  }
  return { byRunner, unassigned };
}

/**
 * `entry.runnerId` と `resources.pendingEvents` が在る（`undefined` でない）ときだけ呼ぶ。呼び元の `if` がその門で、
 * `pendingEvents` が `undefined`（古い runner・応答の形が壊れていた）のときは書かない: 0 で埋めない。
 * `observedAt` は呼び元が `this.#nowIso()` を評価して渡す。
 */
export function buildRunnerBacklog(
  entry: { readonly runnerId: string; readonly instanceId: string | undefined },
  resources: {
    readonly pendingEvents: number;
    readonly oldestPendingAt: RunnerPlacementResources['oldestPendingAt'];
  },
  observedAt: string,
): RunnerBacklogSnapshot {
  return {
    runnerId: entry.runnerId,
    pendingEvents: resources.pendingEvents,
    ...(resources.oldestPendingAt === undefined
      ? {}
      : { oldestPendingAt: resources.oldestPendingAt }),
    observedAt,
    // `resources()` は instanceId を運ばないので、名簿がいま知っている値を観測時点のものとして凍結する。
    ...(entry.instanceId === undefined ? {} : { instanceIdAtObservation: entry.instanceId }),
  };
}

export function buildRunnerOverview(
  entry: RunnerEntry,
  managersOfRunner: RunnerManagerEntry[],
  probes: {
    readonly credentialsProbed: Probed<RunnerOverview['credentials']>;
    readonly profileProbed: Probed<RunnerOverview['profile']>;
    readonly mcpServersProbed: Probed<RunnerOverview['mcpServers']>;
    readonly resourcesProbed: Probed<unknown>;
    /** `resourcesProbed.value ?? undefined`（`null` を返す偽物も `undefined` にそろえた後の値）。 */
    readonly resources: RunnerOverview['resources'];
  },
  pushHealth: RunnerPushHealth | undefined,
  pidsSaturation: PidsSaturation | undefined,
  managerPeers: RunnerOverview['managerPeers'],
): RunnerOverview {
  const { credentialsProbed, profileProbed, mcpServersProbed, resourcesProbed, resources } = probes;
  const credentials = credentialsProbed.value;
  const profile = profileProbed.value;
  const mcpServers = mcpServersProbed.value;
  return {
    label: entry.label,
    state: entry.state,
    since: entry.since,
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.runnerId === undefined ? {} : { runnerId: entry.runnerId }),
    ...(entry.workspacePath === undefined ? {} : { workspacePath: entry.workspacePath }),
    ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
    ...(entry.instanceSince === undefined ? {} : { instanceSince: entry.instanceSince }),
    managers: managersOfRunner,
    ...(credentials === undefined ? {} : { credentials }),
    ...(credentialsProbed.probe === undefined ? {} : { credentialsProbe: credentialsProbed.probe }),
    ...(profile === undefined ? {} : { profile }),
    ...(profileProbed.probe === undefined ? {} : { profileProbe: profileProbed.probe }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(mcpServersProbed.probe === undefined ? {} : { mcpServersProbe: mcpServersProbed.probe }),
    ...(resources === undefined ? {} : { resources }),
    ...(resourcesProbed.probe === undefined ? {} : { resourcesProbe: resourcesProbed.probe }),
    ...(pidsSaturation === undefined ? {} : { pidsSaturation }),
    revision: entry.revision,
    // `fingerprints` の要否を見ない: 往復を払わない（記憶を読むだけ）ので opt-in にする理由が無い。
    ...(pushHealth === undefined ? {} : { pushHealth }),
    managerPeers,
  };
}
