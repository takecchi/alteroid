// マネージャーの委譲の状態を文にする補助（`manager_list` と `manager_report` などの複数の道具が使うもの）。
// `clone-tools-manager.ts` と `clone-tools-manager-list.ts` の両方から読むために、ここへ置く（互いを import すると循環になる）。
// このファイルから道具のファイルを import しない（一方向）。

import { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote } from './cgroup-events.js';
import { formatSystemErrorFacts, SYSTEM_ERROR_UNKNOWN_NOTE } from './system-error.js';
import { isManagerOutcomeUnobserved } from './digest.js';
import { denialActorTag, describeDenialFollowUp } from './denial-format.js';
import { HELD_MESSAGE_TTL_MS } from './held-messages.js';
import { type ManagerSummary } from './manager.js';
import type { ManagerDenial } from './denial-key.js';
import {
  externalOutputLimits,
  type ExternalOutput,
  type LastUnpushedWorkObservation,
  type RescueRemovalReason,
} from './schema.js';
import {
  RESTART_BEFORE_CHECK_ADVICE,
  limitRecoveryOf,
  limitRecoveryOfAssistantError,
  withRecoveryNote,
} from './usage-limits.js';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  formatUnpushedWorkObservationWorktrees,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from './unpushed-work-observation-format.js';
import { formatElapsedAgo } from './format-elapsed.js';
import { RESCUE_NOT_PUSHED_TEXT, rescueNotPushedDetail } from './workspace-swap-hints.js';

const LIST_DENIED_TOOLS = 3;

// 長さの上限もエスケープも掛けない: journal 側に無い制約をここにだけ足す理由が無いため
function denialReasonTag(
  denial: Pick<ManagerDenial, 'reasonType' | 'reason' | 'message' | 'inputHead'>,
): string {
  const parts = [
    denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
    denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
    denial.message === undefined ? undefined : `モデルへの拒否文: ${denial.message}`,
    denial.inputHead === undefined ? undefined : `入力の先頭: ${denial.inputHead}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` [${parts.join(' / ')}]` : '';
}

// 拒否の出所を断定しない: 器の分類器と alteroid 自身のフックの拒否は同じイベントで通り、帰結が違うため
// 「0 件」を「止められていない」と読ませない: 数は器を作り直せば消えるため
export function describeDenials(
  denials: ManagerDenial[],
  lastReportAt: string | undefined,
): string | null {
  if (denials.length === 0) return null;
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件${denialActorTag(e.actor)}${denialReasonTag(e)}`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。まず担い手自身に返っている拒否文を読ませること。出所はこの数からは取れない —— ' +
    '(a) 器の分類器か deny 規則なら、この確認はクローンには回ってきていないので手が止まる。' +
    '(b) alteroid 自身の `PreToolUse` フック（`bash-wait-guard.ts` 等）なら、理由と代替案は' +
    '担い手へ直接返っており、自力で抜けられることがある' +
    '（全件は journal_read に残っている。件数はデーモンを作り直すと数え直しになる）。' +
    (followUp === null ? '' : `${followUp}。`)
  );
}

// `status` を `failed` へ置き換えない: 支出上限に当たった回もセッションは生きており、「もう続けられない」と読ませると起こし直す判断を誤るため
// SDK の語（`code` / `via`）をそのまま出す: 言い換えると型定義や生ログで引ける手がかりが消えるため
// 終端した枝には RESTART_BEFORE_CHECK_ADVICE を付けない: 二重起動の危険は死んでいるか確認できていないときにしか成り立たないため
export function describeManagerFailure(
  failure: ManagerSummary['lastFailure'],
  lastReport: string | undefined,
  status: ManagerSummary['status'],
  staleToken = false,
): string | null {
  if (failure === undefined) return null;
  const opening =
    `⚠ 直近のターンは報告ではなく失敗で終わっている: ${failure.code}（${failure.via}, ${failure.at}）。` +
    'この行の下に出る本文は runner が包んだエラー文（「このターンは応答を返さずに終わった: …」）で' +
    'あって報告ではない——**完遂して畳んだと読まないこと。** ';
  // 終端した枝のクォート内の言い換えを、生きている側の文言の部分文字列にしない: `.not.toContain(ALIVE_CLAIM)` の陰性対照がクォートの中身にも当たるため
  const base = isManagerOutcomeUnobserved(status)
    ? opening +
      `ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションが生きていて原因が解ければ進められる」という前提は' +
      'ここでは成り立たない——起こし直すには manager_send で resume を試みるしかなく、' +
      '届く保証は無い（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
    : status === 'stopped'
      ? opening +
        'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
        '停止させ、確かめたうえで既に終端している（`abort()` が runner の一覧を探って' +
        'セッションが消えたことを確かめた事実。`manager-liveness.ts` の `isLive()` の doc）。' +
        '「セッションが生きていて原因が解ければ進められる」という前提はここでは成り立たない' +
        '——起こし直すには manager_send で resume を試みるしかなく、届く保証は無い' +
        '（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
      : opening +
        'セッションは生きているので、原因が解ければ manager_send で続きから進む' +
        '（status が done のままなのはそのためで、この委譲が死んだという意味ではない）。' +
        RESTART_BEFORE_CHECK_ADVICE;
  // `stopped` でも「resume を試みるしかなく、届く保証は無い」を言う: `manager_send` からの起こし直し自体は塞がれていないため
  if (lastReport === undefined) return base;
  const fromText = limitRecoveryOf(lastReport);
  const recovery =
    fromText !== 'unknown'
      ? fromText
      : failure.via === 'assistant_error'
        ? limitRecoveryOfAssistantError(failure.code)
        : 'unknown';
  return withRecoveryNote(base, recovery, { staleToken });
}

// `failureLine` と排他にしない: 走行中は `usage_notice` が先に届き、まだ `lastFailure` が立っていない回があるため
// `stopped` も「セッションは生きている」と言わない: `abort()` は死を確かめて終端させ、印が残ったまま `stopped` になりうるため
export function describeUsageStopped(manager: ManagerSummary): string | null {
  if (manager.usageStoppedAt === undefined) return null;
  if (isManagerOutcomeUnobserved(manager.status)) {
    return (
      `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
      `ただし status: ${manager.status}——セッションそのものが、依頼者が望まない` +
      '終わり方で既に終端している。「セッションは生きているので鍵が回れば続く」' +
      'はここでは成り立たない——起こし直すには manager_send で resume を試みる' +
      'しかなく、届く保証は無い（届いた事実の判定は `systemErrorLine` 等の' +
      '別の行を見ること）。'
    );
  }
  if (manager.status === 'stopped') {
    return (
      `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
      'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
      '停止させ、確かめたうえで既に終端している（`abort()` が runner の一覧を探って' +
      'セッションが消えたことを確かめた事実。`manager-liveness.ts` の `isLive()` の doc）。' +
      '「セッションは生きているので鍵が回ればこの委譲は続く」はここでは成り立たない' +
      '——起こし直すには manager_send で resume を試みるしかなく、届く保証は無い' +
      '（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
    );
  }
  return (
    `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
    'セッションは生きているので、鍵が回ればこの委譲は続く' +
    '——status はそれまで動かさない（仕様である）。'
  );
}

// `status` を置き換えない: entry が消えていても `sessionId` が残っていれば `manager_send` は resume から入り直せることがあるため
export function describeRunnerVanished(manager: ManagerSummary): string | null {
  if (manager.runnerVanished === undefined) return null;
  return (
    `⚠ 宛先の runner が名簿から消えている（この委譲の走り始めは ${manager.startedAt}。` +
    '消えた時刻は名簿に残っていないので分からない）。resume を試したわけではないので lost ではない' +
    '——manager_list status: ["lost"] の絞りには掛からない。'
  );
}

// 本文の文言を見て判定しない: 判定は構造化された印だけで行う
export function isFoldedTurnReport(
  manager: Pick<ManagerSummary, 'lastFailure' | 'lastUnreported'>,
): boolean {
  return manager.lastFailure !== undefined || manager.lastUnreported !== undefined;
}

// D が A（枠 429）を飲み込まない: この欄には枠 429 も乗るため、D の文言自身が判定できなかったと名乗る
export function describeManagerSystemError(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastSystemError === undefined) {
    return `⚠ セッションは失敗で畳まれた。${SYSTEM_ERROR_UNKNOWN_NOTE}。`;
  }
  return (
    `⚠ セッションは器の資源による落ち方で畳まれた可能性 ` +
    `（${manager.lastSystemError.at}）: ${formatSystemErrorFacts(manager.lastSystemError)}`
  );
}

// 因果は名乗らない: 言えるのは「同じ時間帯に器でそれが起きた／起きなかった」までのため
export function describeManagerCgroupEvents(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastCgroupEvents === undefined) {
    return `⚠ ${CGROUP_EVENTS_UNKNOWN_NOTE}。`;
  }
  return `${formatCgroupEventsNote(manager.lastCgroupEvents)}（${manager.lastCgroupEvents.at}）。`;
}

function unpushedWorkObservationIncompleteSuffix(
  observation: Extract<LastUnpushedWorkObservation, { kind: 'observed' }>,
): string {
  const note = describeUnpushedWorkObservationIncompleteness(observation);
  return note === null ? '' : `\n  ${note}`;
}

// 一覧では外へ出した成果も退避 ref も件数と最後の1件だけにする: 一覧は予算で打ち切られ、1件の委譲が最大20行を取ると出る委譲の数が減るため。全件は `manager_report` が出す
export function describeUnpushedWorkObservation(
  manager: ManagerSummary,
  outputs: 'brief' | 'full' | 'report' = 'brief',
  now?: Date,
): string | null {
  const lines = [
    describeUnpushedWorkObservationOnly(manager),
    describeRescue(manager, outputs, now),
    describeRescueStash(manager),
    // 'report' でも外へ出した成果は畳まない: 畳むのは退避 ref だけで、成果の記録は件数が上限で締まっている
    describeExternalOutputs(manager, outputs === 'report' ? 'full' : outputs),
    describeHeldMessages(manager),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join('\n');
}

// 一覧で見えないと、クローンは届いたかを台帳で手書きで追い、送り直して二重に届ける（預かりそのものの理由と同じ）
export function describeHeldMessages(manager: ManagerSummary): string | null {
  const held = manager.heldMessages;
  if (held === undefined) return null;
  const expiresAt = new Date(Date.parse(held.oldestHeldAt) + HELD_MESSAGE_TTL_MS).toISOString();
  return (
    `  預かっている伝言（manager_send が届けられなかった分）: ${String(held.count)} 通` +
    `（最初の預かり ${held.oldestHeldAt}・その期限 ${expiresAt}）。` +
    '届けられるようになったら自動で届けて知らせる。送り直さないこと（二重に届く）'
  );
}

function formatExternalOutput(output: ExternalOutput): string {
  return (
    `${output.kind}: ${output.where}` +
    (output.summary === undefined ? '' : `（${output.summary}）`) +
    `、${output.at}`
  );
}

export function describeExternalOutputs(
  manager: ManagerSummary,
  mode: 'brief' | 'full',
): string | null {
  const outputs = manager.externalOutputs;
  if (outputs === undefined || outputs.length === 0) return null;
  const head = `  外へ出した成果（マネージャーの記録。直近 ${String(externalOutputLimits.keptPerJob)} 件まで）`;
  if (mode === 'brief') {
    const last = outputs[outputs.length - 1];
    return `${head}: ${String(outputs.length)} 件。最後: ${last === undefined ? '' : formatExternalOutput(last)}`;
  }
  return [`${head}:`, ...outputs.map((output) => `    ${formatExternalOutput(output)}`)].join('\n');
}

const RESCUE_REMOVAL_REASON_TEXT: Record<RescueRemovalReason, string> = {
  landed: '内容が origin の枝に入っていた',
  done: '委譲が done のまま猶予を過ぎた',
  failed: '委譲が failed のまま猶予を過ぎた',
  stopped: '委譲が stopped のまま猶予を過ぎた',
};

// 在りかを辿れるように件数と合計を出す。パスは出さない（担当へは器が入れ替わった後の知らせと `rescue_restore` の返事が運ぶ）
export function describeRescueStash(manager: ManagerSummary): string | null {
  const stash = manager.rescueStash;
  if (stash === undefined) return null;
  return (
    `  預かっている未追跡のファイル（デーモンの置き場。猶予は退避 ref と同じ）: ${String(stash.count)} 件・合計 ${String(stash.totalBytes)} バイト` +
    `（最後の預かり ${stash.latestAt}）。器が入れ替わった後、担当は rescue_restore で取り戻せる`
  );
}

type RescuePushed = NonNullable<
  NonNullable<ManagerSummary['lastRescue']>['worktrees'][number]['pushed']
>;

function describeRescuePushed(pushed: RescuePushed): string {
  const removal = pushed.removal;
  // 消した ref を「在る」と読ませない
  const state =
    removal === undefined
      ? ''
      : removal.failureKind === 'no-remote'
        ? '・送り先が台帳に無いので自動では消せない（手で消す）'
        : removal.failureKind === undefined
          ? `・${removal.at} に消した（${RESCUE_REMOVAL_REASON_TEXT[removal.reason]}）`
          : `・消せなかった（${removal.failureKind}。${removal.at} 時点で ${String(removal.attempts ?? 1)} 回目。次の機会に再試行する）`;
  return `${pushed.ref}（${pushed.commit.slice(0, 8)}, ${pushed.at}${state}）`;
}

// 一覧（brief）は件数と最新の1件だけにする: 作業ツリーごとに数行が付くと1件の委譲が予算を占有し、出る委譲の数が減って頁をめくらされるため。全部は `manager_report`（full）が出す
// 退避されなかったもの（push 失敗・未追跡・submodule）は件数だけ残す: 消すと「全部退避できた」と読めるため
// いまの器で、送るものが在るのに送れていない作業ツリー（#5117）。`goneAt` の行と、前の器の行（最新の行と `instanceId` が違う）は外す: 担当に push を促しても届かない分のため
function stuckRescueTrees(rescue: NonNullable<ManagerSummary['lastRescue']>): RescueTree[] {
  const newest = rescue.worktrees.reduce<RescueTree | undefined>(
    (best, tree) => (best === undefined || tree.at > best.at ? tree : best),
    undefined,
  );
  return rescue.worktrees.filter(
    (tree) =>
      tree.notPushed !== undefined &&
      tree.notPushed.reason !== 'nothing-tracked' &&
      tree.goneAt === undefined &&
      tree.instanceId === newest?.instanceId,
  );
}

function rescueNotPushedSinceOf(tree: RescueTree): string {
  return tree.notPushed?.since ?? tree.at;
}

// 一覧には、いちばん長く続いている1本と残りの本数だけを出す: 作業ツリーごとに並べると1件の委譲が予算を占有するため（`describeRescueBrief` と同じ理由）
function describeStuckRescueBrief(
  rescue: NonNullable<ManagerSummary['lastRescue']>,
  now: Date | undefined,
): string {
  const stuck = stuckRescueTrees(rescue);
  const oldest = stuck.reduce<RescueTree | undefined>(
    (best, tree) =>
      best === undefined || rescueNotPushedSinceOf(tree) < rescueNotPushedSinceOf(best)
        ? tree
        : best,
    undefined,
  );
  if (oldest?.notPushed === undefined) return '';
  const since = rescueNotPushedSinceOf(oldest);
  const elapsed =
    now === undefined
      ? ''
      : `・${formatElapsedAgo(since, now.getTime()).replace(/前$/, '')}続いている`;
  const rest = stuck.length > 1 ? ` ほか ${String(stuck.length - 1)} 本` : '';
  // too-large と secret-like は、担当が push すれば退避そのものが要らなくなる: 消える前に声を掛けられるよう、取れる手を添える
  const hint =
    oldest.notPushed.reason === 'too-large' || oldest.notPushed.reason === 'secret-like'
      ? '。担当が push すれば消えずに済む'
      : '';
  return (
    `。退避できていない: ${oldest.relativePath}（${oldest.notPushed.reason}。${since} から${elapsed}）${rest}` +
    hint
  );
}

function describeRescueBrief(
  rescue: NonNullable<ManagerSummary['lastRescue']>,
  now?: Date,
): string {
  const pushedTrees = rescue.worktrees.filter((tree) => tree.pushed !== undefined);
  const latest = pushedTrees.reduce<RescuePushed | undefined>(
    (best, tree) =>
      tree.pushed !== undefined && (best === undefined || tree.pushed.at > best.at)
        ? tree.pushed
        : best,
    undefined,
  );
  const unsavedTrees = rescue.worktrees.filter(
    (tree) =>
      tree.notPushed !== undefined ||
      tree.untracked !== undefined ||
      tree.submoduleCount !== undefined,
  ).length;
  const refs =
    latest === undefined
      ? '0 本'
      : `${String(pushedTrees.length)} 本（最新: ${describeRescuePushed(latest)}）`;
  const unsaved =
    unsavedTrees === 0 ? '' : `。退避されなかったものがある作業ツリー ${String(unsavedTrees)} 本`;
  return `  退避 ref ${refs}${unsaved}${describeStuckRescueBrief(rescue, now)}（走行中に自動で push。${rescue.at} に最後に更新。全部は manager_report を rescueAll: true で読む）`;
}

type RescueTree = NonNullable<ManagerSummary['lastRescue']>['worktrees'][number];

// manager_report の既定は件数に畳む。畳まないのは、退避できていない（push 失敗・未追跡・submodule で、失われうる）作業ツリーの存在だけ:
// 件数と代表の1本を必ず残す。生きている ref・消せなかった ref・生きている間に消えた作業ツリーは、読み手が何もできないか、ref 名が要るのは取り戻すときだけなので件数でよい（#5028 の続き）
// 軸は独立に数える（排他の分類にしない）: 作業ツリーが消えても、退避できていないものが在っても、ref が残っていれば「生きている ref」に数えるため
function isUnsavedRescueTree(tree: RescueTree): boolean {
  return (
    tree.untracked !== undefined ||
    tree.submoduleCount !== undefined ||
    (tree.notPushed !== undefined && tree.notPushed.reason !== 'nothing-tracked')
  );
}

function hasLiveRescueRef(tree: RescueTree): boolean {
  const removal = tree.pushed?.removal;
  return tree.pushed !== undefined && (removal === undefined || removal.failureKind !== undefined);
}

function describeRescueTreeRows(tree: RescueTree): string[] {
  const rows: string[] = [];
  const parts: string[] = [];
  if (tree.pushed !== undefined) {
    parts.push(describeRescuePushed(tree.pushed));
  } else {
    parts.push('退避された ref は無い');
  }
  if (tree.notPushed !== undefined) {
    parts.push(
      `直近の回: ${RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]}${rescueNotPushedDetail(tree.notPushed)}` +
        (tree.notPushed.since === undefined || tree.notPushed.reason === 'nothing-tracked'
          ? ''
          : `（${tree.notPushed.since} から続いている）`),
    );
  }
  // 消さず印を添える: 台帳の項目は退避の記録そのもので、生きている間に消えた作業ツリーの ref も取り戻す材料として残す
  if (tree.goneAt !== undefined) {
    parts.push(`生きている間に消えた（観測 ${tree.goneAt}）`);
  }
  rows.push(`    ${tree.relativePath}: ${parts.join('。')}`);
  const unsaved: string[] = [];
  if (tree.untracked !== undefined) {
    const shown = tree.untracked.paths.slice(0, 5).join(', ');
    const rest = tree.untracked.count - Math.min(5, tree.untracked.paths.length);
    unsaved.push(
      `未追跡 ${tree.untracked.count} 件（${shown}${rest > 0 ? ` ほか ${rest} 件` : ''}）`,
    );
  }
  if (tree.submoduleCount !== undefined) {
    unsaved.push(`submodule ${tree.submoduleCount} 本（中の変更は退避されない）`);
  }
  if (unsaved.length > 0) rows.push(`      退避されなかったもの: ${unsaved.join('、')}`);
  return rows;
}

// 代表は、いまも担当が手を打てる（消えていない）ものの中でいちばん長く続いているもの。無ければ消えたものから選ぶ
function representativeUnsavedTree(unsaved: RescueTree[]): RescueTree | undefined {
  const pool = unsaved.some((tree) => tree.goneAt === undefined)
    ? unsaved.filter((tree) => tree.goneAt === undefined)
    : unsaved;
  return pool.reduce<RescueTree | undefined>(
    (best, tree) =>
      best === undefined || rescueNotPushedSinceOf(tree) < rescueNotPushedSinceOf(best)
        ? tree
        : best,
    undefined,
  );
}

function describeRescueReport(rescue: NonNullable<ManagerSummary['lastRescue']>): string[] {
  const trees = rescue.worktrees;
  const unsaved = trees.filter(isUnsavedRescueTree);
  const liveTrees = trees.filter(hasLiveRescueRef);
  const rest = trees.filter((tree) => !hasLiveRescueRef(tree));
  const goneWithRef = liveTrees.filter((tree) => tree.goneAt !== undefined).length;
  const stuckFailed = liveTrees.filter(
    (tree) => tree.pushed?.removal !== undefined && tree.pushed.removal.failureKind !== 'no-remote',
  ).length;
  const noRemote = liveTrees.filter(
    (tree) => tree.pushed?.removal?.failureKind === 'no-remote',
  ).length;
  // ref が無い側の内訳: 消し終えた ref は理由ごと、消えた作業ツリーで ref が最初から無いもの、送るもの無し
  const goneNoRef = rest.filter(
    (tree) => tree.goneAt !== undefined && tree.pushed === undefined,
  ).length;
  const nothing = rest.filter(
    (tree) => tree.goneAt === undefined && tree.pushed === undefined && !isUnsavedRescueTree(tree),
  ).length;
  const removedGroups = (Object.keys(RESCUE_REMOVAL_REASON_TEXT) as RescueRemovalReason[])
    .map((reason) => ({
      reason,
      count: rest.filter((tree) => tree.pushed?.removal?.reason === reason).length,
    }))
    .filter((group) => group.count > 0)
    .map((group) => `${RESCUE_REMOVAL_REASON_TEXT[group.reason]} ${String(group.count)} 本`);
  const latestLive = liveTrees.reduce<RescuePushed | undefined>(
    (best, tree) =>
      tree.pushed !== undefined && (best === undefined || tree.pushed.at > best.at)
        ? tree.pushed
        : best,
    undefined,
  );
  const counts = [
    latestLive === undefined
      ? null
      : `生きている ref ${String(liveTrees.length)} 本（最新: ${describeRescuePushed(latestLive)}）` +
        (goneWithRef === 0
          ? ''
          : `・うち作業ツリーが生きている間に消えて ref だけ残っている ${String(goneWithRef)} 本（取り戻す材料）`) +
        (stuckFailed === 0 ? '' : `・うち消せなかった ${String(stuckFailed)} 本`) +
        (noRemote === 0
          ? ''
          : `・うち送り先が台帳に無く自動では消せない ${String(noRemote)} 本（手で消す）`),
    removedGroups.length === 0 ? null : `消した ref: ${removedGroups.join('・')}`,
    goneNoRef === 0 ? null : `生きている間に消えた（ref は無い） ${String(goneNoRef)} 本`,
    nothing === 0 ? null : `送るもの無し ${String(nothing)} 本`,
  ].filter((part): part is string => part !== null);
  const lines = [
    `  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）: 作業ツリー ${String(rescue.worktrees.length)} 本`,
  ];
  if (counts.length > 0) lines.push(`    ${counts.join('、')}`);
  const representative = representativeUnsavedTree(unsaved);
  if (representative !== undefined) {
    // 種類ごとの本数も添える: 代表の1本だけだと、残りが別の種類（too-large など担当が打てる手が違うもの）でも見えないため
    const causeCounts = new Map<string, number>();
    for (const tree of unsaved) {
      const causes = [
        tree.notPushed !== undefined && tree.notPushed.reason !== 'nothing-tracked'
          ? RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]
          : null,
        tree.untracked === undefined ? null : '未追跡',
        tree.submoduleCount === undefined ? null : 'submodule',
      ];
      for (const cause of causes) {
        if (cause !== null) causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
      }
    }
    const causes = [...causeCounts].map(([cause, count]) => `${cause} ${String(count)}`).join('・');
    lines.push(
      `    ⚠ 退避できていない作業ツリー ${String(unsaved.length)} 本（失われうる。${causes}）。代表の1本:`,
      ...describeRescueTreeRows(representative).map((row) => `  ${row}`),
    );
  }
  lines.push('    全部は manager_report を rescueAll: true で読む');
  return lines;
}

export function describeRescue(
  manager: ManagerSummary,
  mode: 'brief' | 'full' | 'report' = 'full',
  now?: Date,
): string | null {
  const rescue = manager.lastRescue;
  if (rescue === undefined || rescue.worktrees.length === 0) return null;
  if (mode === 'brief') return describeRescueBrief(rescue, now);
  if (mode === 'report') return describeRescueReport(rescue).join('\n');
  const lines = [`  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）:`];
  for (const tree of rescue.worktrees) lines.push(...describeRescueTreeRows(tree));
  return lines.join('\n');
}

// `cwd`（探索の起点の絶対パス）は載せない: 絶対パスそのものは出さない線を、この欄の写しにも適用するため
// 時刻だけを出さず、観測自身の `source` から出どころを行の中に書く: 読み手が「いまの状態」と誤読するため
// 観測が `undefined` でも器の入れ替えで応答不能な分岐では `null` を返さない: 「0件」と「沈黙」が読み手から区別できなくなるため
function describeUnpushedWorkObservationOnly(manager: ManagerSummary): string | null {
  const observation = manager.lastUnpushedWorkObservation;

  if (manager.sessionMissingSince !== undefined) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return (
          `  未push観測: 器が止まる直前（${observation.at}）に取ろうとしたが取れなかった: ` +
          observation.reason
        );
      }
      if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
      return (
        `  未push観測: 器が止まる直前（${observation.at}）の観測: ` +
        formatUnpushedWorkObservationWorktrees(observation.worktrees) +
        unpushedWorkObservationIncompleteSuffix(observation)
      );
    }
    const shown =
      observation === undefined
        ? '表示中の観測は無い（一度も取れていない）'
        : observation.kind === 'unavailable'
          ? `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの（取れなかった: ${observation.reason}）`
          : `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの: ${formatUnpushedWorkObservationWorktrees(observation.worktrees)}` +
            unpushedWorkObservationIncompleteSuffix(observation);
    return `  ${UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE}` + shown;
  }

  if (observation === undefined) return null;
  if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
  const provenance = describeUnpushedWorkObservationProvenance(observation.source, 'manager_list');
  if (observation.kind === 'unavailable') {
    return (
      `  未push観測（${provenance}）: 取れなかった（${observation.at}）: ` + observation.reason
    );
  }
  return (
    `  未push観測（${provenance}、${observation.at}）: ` +
    formatUnpushedWorkObservationWorktrees(observation.worktrees) +
    unpushedWorkObservationIncompleteSuffix(observation)
  );
}
