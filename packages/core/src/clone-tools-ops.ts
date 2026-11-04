// 生ログ・退避・器の一覧（manager_transcript / archive_remove / archive_remove_many / runner_list）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import { filterTranscriptLinesYielding } from './transcript-filter.js';
import {
  TranscriptPageCache,
  transcriptPageCacheKey,
  type TranscriptPageSnapshot,
} from './transcript-page-cache.js';
import {
  describeOffsetRequiredTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  isOffsetQualifiedTimeBoundary,
  isReadableJournalTimeBoundary,
} from './journal-time.js';
import { describePidsSaturation } from './runner-protocol.js';
import { describeManagerState } from './digest.js';
import { journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { encodeRunnerCursor, resolveRunnerCursor } from './runner-cursor.js';
import { describePage, excerptLine, page, renderListing } from './excerpt.js';
import {
  removeArchiveChunkJournalFirst,
  removeArchiveJournalFirst,
} from './removal-journal-first.js';
import {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  selectArchiveRemovalTargets,
  type ArchiveRemovalSelection,
  type ArchiveRemoveManyFilter,
} from './archive-prune.js';
import type { JournalEntryInput } from './schema.js';
import {
  guardArchiveRemoval,
  type ManagerPool,
  type RunnerFleetOverview,
  type RunnerManagerEntry,
  type RunnerOverview,
} from './manager.js';
import type { RunnerPushOutcome } from './push-ledger.js';
import { describeRevisionStatus } from './revision.js';
import { describeManagerPeers } from './manager-peers-format.js';
import type { ArchiveEntry } from './store.js';
import { STALE_TOKEN_RESTART_ADVICE } from './usage-limits.js';
import { formatMinutesAgo } from './format-elapsed.js';
import { chunkIdsByChars } from './chunk-ids.js';
import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringArrayElementLengthViolation,
  describeStringLengthViolation,
  formatArrayLengthJa,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import {
  describeRunnerLegState,
  tool,
  text,
  NO_POOL,
  TRANSCRIPT_PAGE,
  JournalNotRecordedError,
  RUNNER_MANAGER_PEERS_EXCERPT,
  isSubagentCaller,
  NO_FIXED_FOLD,
  type FixedFold,
} from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

// ネットワークを叩かない: `runnerBacklog()` のキャッシュとストアの読み出しだけで言い分ける
// `describeRunnerLegState` を再利用する: 同じ判定を2箇所へ書くと字面が割れるため
async function describeTranscriptMissingLeg(pool: ManagerPool, managerId: string): Promise<string> {
  const runnerId = await pool.runnerIdOf(managerId);
  if (runnerId === undefined) {
    return (
      '判定できない（この委譲に runner が割り当てられたことを、走行中の像・' +
      '台帳のどちらからも確認できない —— 一度も割り当てられなかったのか、' +
      'id 自体が存在しないのかは、この応答だけでは区別できない）。'
    );
  }

  const snapshot = pool.runnerBacklog().find((entry) => entry.runnerId === runnerId);
  if (snapshot === undefined || snapshot.pendingEvents === 0) {
    return (
      `判定できない（runner ${runnerId} について、生ログが無い理由と結び付けられる` +
      '未送出の滞留を観測できていない。滞留が実際に0件だったのか、まだ一度も' +
      '観測していないだけなのかは、この応答だけでは区別できない）。'
    );
  }

  const prefix =
    snapshot.instanceSwapped === true
      ? '引き渡せずに消えた可能性が高い。'
      : 'まだ引き渡していない可能性がある（この生ログもその中に含まれるかは' + '分からない）。';

  return (
    `${prefix} runner ${runnerId} について ${snapshot.observedAt} 時点で観測できた` +
    `未送出の出来事: ${snapshot.pendingEvents} 件（内訳は runner から届いていないので` +
    `不明——archive が含まれていたかもここからは言えない）。${describeRunnerLegState(snapshot)}`
  );
}

// 道具の応答だけの関心事: 一括削除の口は道具だけ（HTTP の口は無い）なので、`removedIds` の間引きはテキスト応答の側で持つ
const ARCHIVE_REMOVE_MANY_IDS_SHOWN = 20;

// `LIST_BUDGET` を使い回さない: 値が同じでも、片方だけ直したくなったときに一緒に動くため
const RUNNER_LIST_BUDGET = 8_000;

const RUNNER_MANAGER_LIST_LIMIT = 20;

const RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT = 400;

// 内訳が無い（古い runner・材料を渡さない構成）ときは合計だけを出す: 内訳を0に潰さないため
function describeUnrecognised(
  total: number,
  split: { ownerLive: number; ownerListed: number; ownerUnknown: number } | undefined,
): string {
  if (split === undefined) return `sid 未認識 ${total}`;
  return (
    `sid 未認識 ${total}（持ち主が生きている ${split.ownerLive}・` +
    `持ち主が名簿に居るので守っている ${split.ownerListed}・持ち主不明 ${split.ownerUnknown}）`
  );
}

function describeZombieAge(seconds: number): string {
  return seconds < 60 ? `${seconds}秒前` : formatMinutesAgo(seconds * 1000);
}

function describeAgeBucketLabel(upToSec: number | undefined): string {
  switch (upToSec) {
    case 60:
      return '1分未満';
    case 600:
      return '10分未満';
    case 3600:
      return '1時間未満';
    case 21600:
      return '6時間未満';
    default:
      return upToSec === undefined ? 'それ以上' : `${upToSec}秒未満`;
  }
}

function runnerManagerTokenTag(manager: RunnerManagerEntry): string {
  if (manager.tokenGeneration === undefined || manager.activeTokenGeneration === undefined) {
    return '';
  }
  if (manager.tokenGeneration === manager.activeTokenGeneration) return '';
  return ` ⚠世代${manager.tokenGeneration}≠現役${manager.activeTokenGeneration}`;
}

// ここから runner_list の出力を部分ごとに作る関数。どれも文字列（または行の配列）を返すだけで、pool の呼び・控え（fold）への書き込み・時刻の読みは持たない（それは道具の式の側に残す）

type RunnerListShow = { fingerprints: boolean; resources: boolean };
type RunnerResources = NonNullable<RunnerOverview['resources']>;
type RunnerTasks = NonNullable<RunnerResources['tasks']>;
type RunnerReclaim = NonNullable<RunnerTasks['reclaim']>;
type RunnerNotFired = NonNullable<RunnerReclaim['notFired']>;

// 自動畳みが走っていればどの return 経路でも必ず言う: 早い return でだけ黙ると、畳んだ・見送ったことがクローンに一度も届かない窓ができるため
function describeRunnerAutoFoldedNote(autoFolded: RunnerFleetOverview['autoFolded']): string {
  return autoFolded === undefined
    ? ''
    : autoFolded.length === 0
      ? '\n（pids 逼迫を検出したが、この呼び出しでは畳む候補が無かった）'
      : `\n⚠ この呼び出しで自動畳みが働いた:\n${autoFolded
          .map((entry) => `  - [${entry.managerId}] ${entry.outcome}: ${entry.detail}`)
          .join('\n')}`;
}

type RunnerListPageCheck =
  | { kind: 'refused'; body: string }
  | { kind: 'listing'; view: RunnerOverview[]; restarted: boolean; daemonLine: string };

// 壊れた cursor・0台・最後の頁は、一覧を組まずにここで断りの本文を返す（どれも自動畳みの注記を末尾に付ける）
function checkRunnerListPage(
  overview: RunnerFleetOverview,
  cursor: string | undefined,
  autoFoldedNote: string,
): RunnerListPageCheck {
  const resolved = resolveRunnerCursor(overview.runners, cursor);
  if (resolved.kind === 'malformed') {
    // 黙って先頭からへ倒さない
    return {
      kind: 'refused',
      body:
        'この cursor は読めない（壊れているか、この道具のものではない）。' +
        'cursor は前回の応答の断り書きに出たものをそのまま渡すこと（自分で組み立てない）。' +
        '先頭から読み直すなら cursor を省いて呼ぶこと。' +
        autoFoldedNote,
    };
  }

  // デーモン自身の版は runner が0台でも出す: 0台のときに落とすと、配線がまだ無い状態（まさに版を確かめたい状態）でだけ答えが消えるため
  const daemonLine = `デーモン（あなた自身が居るプロセス）の版: ${describeRevisionStatus(
    overview.daemonRevision,
  )}`;

  if (overview.runners.length === 0) {
    return {
      kind: 'refused',
      body:
        '登録されている runner は0台である（設定に ALTEROID_RUNNER_URLS 等が無いか、' +
        `まだ配線されていない）。\n${daemonLine}${autoFoldedNote}`,
    };
  }

  // cursor を渡されたときだけ「最後の頁」と言う: 名簿が0台のときの言い方を奪わないため
  if (cursor !== undefined && resolved.view.length === 0) {
    return {
      kind: 'refused',
      body: `（cursor より後ろの器は無い。これが最後の頁）\n${daemonLine}${autoFoldedNote}`,
    };
  }

  return { kind: 'listing', view: resolved.view, restarted: resolved.restarted, daemonLine };
}

function describeRunnerListHead(
  runnerCount: number,
  daemonLine: string,
  restarted: boolean,
): string[] {
  const head: string[] = [
    // 1台のときにそう言う: 言わないと「分散していない」ことが読み取れず、複数台に散っていると誤読されうるため
    runnerCount === 1
      ? 'runner は1台のみ登録されている（分散していない）。'
      : `runner は${runnerCount}台登録されている。`,
    // デーモンと runner の版を同じ出力に並べる: 別々の口に出すと突き合わせ忘れがそのまま見逃しになり、2つの Service は別々にデプロイされてずれる窓が在るため
    daemonLine,
  ];
  // 先頭から出し直したことを黙って重複させない: 言わないと「進んでいない」のか「出し直した」のかが区別できないため
  if (restarted) {
    head.push(
      '⚠ 渡された cursor が指していた器は、いま名簿に居ない（登録から外れた）。' +
        'この並びは登録順で、そこから位置を割り出す手が無いので、**先頭から出し直した**' +
        '——既に見た器がもう一度出る。**1台も落としていない**（欠落より重複の側へ倒してある）。',
    );
  }
  return head;
}

// 器の行とどの器か分からない行で共有する: 字面は `describeManagerState` から取る（`m.status` をそのまま書くと「走行中」と「走行中だがセッション切断」がここでだけ潰れるため）
function describeRunnerManagerEntries(managers: RunnerManagerEntry[]): string {
  const shown = managers.slice(0, RUNNER_MANAGER_LIST_LIMIT);
  const rest = managers.length - shown.length;
  return (
    shown
      .map(
        (m) =>
          `${m.managerId}[${describeManagerState(m.status, m.live, m.awaitingBackground)}]` +
          runnerManagerTokenTag(m),
      )
      .join(', ') + (rest === 0 ? '' : `, …ほか ${rest} 本は省略（manager_list で全部見える）`)
  );
}

// 器の見出し・版・peer・失敗・飽和
function runnerHeaderLines(runner: RunnerOverview): string[] {
  const lines: string[] = [];
  lines.push(
    `- ${runner.label} [${runner.state}]` +
      (runner.runnerId === undefined
        ? '（runnerId は未確定。まだ名乗っていない）'
        : ` runnerId=${runner.runnerId}`),
  );
  lines.push(`  この状態になった: ${runner.since}`);
  if (runner.workspacePath !== undefined) lines.push(`  workspace: ${runner.workspacePath}`);
  // 名乗らないことを黙らせない: 出さないと「入れ替わっていない」と「判定できない」が同じに見えるため
  lines.push(
    runner.instanceId === undefined
      ? '  応えているプロセス: 名乗っていない（この器では入れ替わりを判定できない）'
      : `  応えているプロセス: ${runner.instanceId}` +
          (runner.instanceSince === undefined ? '' : `（${runner.instanceSince} から）`),
  );
  // 版は「どのプロセスか」の隣に置く: 別の問いに答える2つを並べないと片方でもう片方を推測することになり、state から遠いと `lost` の器の古い値が現役の版として読まれるため
  lines.push(`  版: ${describeRevisionStatus(runner.revision)}`);
  const peersLine = describeManagerPeers(runner.managerPeers);
  if (peersLine !== undefined) {
    lines.push(`  peer: ${excerptLine(peersLine, RUNNER_MANAGER_PEERS_EXCERPT)}`);
  }
  if (runner.error !== undefined) lines.push(`  直近の失敗: ${runner.error}`);
  // 材料が無い器には行を出さない: 「飽和ではない」と言わないため
  if (runner.pidsSaturation !== undefined) {
    lines.push(
      `  pids 飽和: 新しい委譲を置けない（${describePidsSaturation(runner.pidsSaturation)}）`,
    );
  }
  return lines;
}

// 器のマネージャーの内訳
function runnerManagersLine(runner: RunnerOverview): string {
  if (runner.managers.length === 0) return '  マネージャー: 無し';
  return (
    `  マネージャー(${runner.managers.length}): ` + describeRunnerManagerEntries(runner.managers)
  );
}

// 鍵・プロファイル・MCP の登録の指紋（`fingerprints === true` のときだけ呼ぶ）。3状態（聞いていない／失敗／0件・無し）を同じ文言に潰さない
function runnerFingerprintLines(runner: RunnerOverview): string[] {
  const lines: string[] = [];
  if (runner.credentialsProbe?.status === 'unheard') {
    lines.push('  鍵: 確かめていない（繋がっていないので聞いていない）');
  } else if (runner.credentialsProbe?.status === 'failed') {
    lines.push(`  鍵を確かめられなかった: ${runner.credentialsProbe.error}`);
  } else if (runner.credentials !== undefined) {
    lines.push(
      runner.credentials.length === 0
        ? '  鍵: 無し'
        : `  鍵の指紋: ${excerptLine(
            runner.credentials.map((c) => `${c.name}=${c.sha256}`).join(', '),
            RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT,
          )}`,
    );
  }
  if (runner.profileProbe?.status === 'unheard') {
    lines.push('  プロファイル: 確かめていない（繋がっていないので聞いていない）');
  } else if (runner.profileProbe?.status === 'failed') {
    lines.push(`  プロファイルを確かめられなかった: ${runner.profileProbe.error}`);
  } else if (runner.profile !== undefined) {
    lines.push(`  プロファイルの指紋: ${runner.profile.sha256}`);
  }
  // `unsupported` は `failed` とは別の文言で言う: 鍵を配り直せば直る故障と、runner を上げないと直らない故障を混ぜないため
  if (runner.mcpServersProbe?.status === 'unheard') {
    lines.push('  MCP の登録: 確かめていない（繋がっていないので聞いていない）');
  } else if (runner.mcpServersProbe?.status === 'unsupported') {
    lines.push('  MCP の登録: 確かめられない（この runner は口を持たない。古い版）');
  } else if (runner.mcpServersProbe?.status === 'failed') {
    lines.push(`  MCP の登録を確かめられなかった: ${runner.mcpServersProbe.error}`);
  } else if (runner.mcpServers !== undefined) {
    lines.push(
      `  MCP の登録: ${excerptLine(runner.mcpServers.names.join(', '), RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT)}（指紋 ${runner.mcpServers.sha256}）`,
    );
  }
  return lines;
}

// 直近の押し込み。`undefined` を「成功した」の既定値として埋めない: 3種類とも「まだ一度も試みていない」ことがあり、その種類だけ行を出さない
function runnerPushHealthLines(runner: RunnerOverview): string[] {
  const lines: string[] = [];
  if (runner.pushHealth !== undefined) {
    const outcomeText = (label: string, outcome: RunnerPushOutcome | undefined) =>
      outcome === undefined
        ? undefined
        : outcome.status === 'ok'
          ? `${label} ok（${outcome.at}）`
          : `${label} 失敗（${outcome.at}）: ${outcome.error ?? '理由不明'}`;
    const pushLines = [
      outcomeText('プロファイル', runner.pushHealth.profile),
      outcomeText('環境変数', runner.pushHealth.credentials),
      outcomeText('認証トークン', runner.pushHealth.agentToken),
      outcomeText('MCP の登録', runner.pushHealth.mcpServers),
      outcomeText('plugin', runner.pushHealth.plugins),
    ].filter((line): line is string => line !== undefined);
    if (pushLines.length > 0) {
      lines.push(`  直近の押し込み: ${pushLines.join(' / ')}`);
    }
  }
  return lines;
}

// 孤児ルート外・hold・素性の分からない孤児
function runnerNotFiredLines(notFired: RunnerNotFired): string[] {
  const lines: string[] = [];
  const { outsideRoots, held, observeOnly } = notFired;
  const bySid =
    outsideRoots.bySid === undefined
      ? ''
      : `。仮に孤児ルートに入っていたら: 撃つ ${outsideRoots.bySid.wouldFire} / ` +
        `sid 不明 ${outsideRoots.bySid.sidUnknown} / ` +
        `sid が live ${outsideRoots.bySid.sidLive} / ` +
        `sid の長が残存 ${outsideRoots.bySid.sidLeaderPresent} / ` +
        describeUnrecognised(outsideRoots.bySid.sidUnrecognised, outsideRoots.bySid.unrecognisedBy);
  lines.push(
    `    孤児ルート外: ${outsideRoots.total}（うち親が生存 ` +
      `${outsideRoots.parentInScan}。孤児ルートの部分木に入らず、撃つ判定に掛からない）` +
      bySid,
  );
  if (held !== undefined) {
    lines.push(
      `    hold（候補のうち撃たなかった理由）: sid 不明 ${held.sidUnknown} / ` +
        `sid が live ${held.sidLive} / sid の長が残存 ${held.sidLeaderPresent} / ` +
        describeUnrecognised(held.sidUnrecognised, held.unrecognisedBy),
    );
  } else {
    lines.push(
      '    hold の内訳: この走査には判定材料（live / 終端済みの sid）が渡っていないので出せない',
    );
  }
  if (observeOnly !== undefined) {
    lines.push(
      `    素性の分からない孤児（委譲が0本のとき sid を問わず撃つ形）で、reclaim でないので撃たなかった: ${observeOnly}`,
    );
  }
  return lines;
}

// 孤児の回収（reclaim）の行
function runnerReclaimLines(reclaim: RunnerReclaim): string[] {
  const lines: string[] = [];
  const age =
    reclaim.oldestAgeSec === undefined
      ? ''
      : `（いちばん古い ${describeZombieAge(reclaim.oldestAgeSec)}）`;
  const atScan =
    reclaim.pidsAtScan === undefined
      ? ''
      : `、走査時 pids ${reclaim.pidsAtScan.current}/${reclaim.pidsAtScan.max}`;
  const mode =
    reclaim.mode === 'observe'
      ? 'observe: 終端した委譲の木だけ畳む'
      : '回収（既定）: 素性の分からない孤児も撃つ';
  lines.push(
    `    孤児（${mode}）: 候補 ${reclaim.candidates} 本 / ` +
      `${reclaim.candidateThreads} threads${age}${atScan}` +
      `、送出 ${reclaim.signalled} / 畳み ${reclaim.killed} / ` +
      `返却 ${reclaim.freedThreads} threads`,
  );
  // 欄が無い（古い runner）ときは行を出さない: 「引き取り手が無い」と読ませないため
  if (reclaim.subreaper !== undefined) {
    lines.push(
      reclaim.subreaper.command === null
        ? '    委譲の引き取り手: 無し（tini が PATH に無い。setsid で抜けて親が先に終わった子孫は、誰のものか分からず撃たれない）'
        : `    委譲の引き取り手: ${reclaim.subreaper.command} -s（setsid で抜けた子孫も委譲の木に留まる）`,
    );
  }
  if (
    reclaim.roots !== undefined &&
    reclaim.largestTreeCandidates !== undefined &&
    reclaim.singletonTrees !== undefined
  ) {
    lines.push(
      `    孤児の木: ルート ${reclaim.roots} 本 / ` +
        `いちばん大きい木 ${reclaim.largestTreeCandidates} 本 / ` +
        `単独 ${reclaim.singletonTrees} 本`,
    );
  }
  if (reclaim.medianAgeSec !== undefined && reclaim.ageBuckets !== undefined) {
    const buckets = reclaim.ageBuckets
      .map((bucket) => `${describeAgeBucketLabel(bucket.upToSec)} ${bucket.count}`)
      .join(' / ');
    lines.push(
      `    孤児の齢（⚠ 起動から。孤児になってからではない）: ` +
        `中央値 ${describeZombieAge(reclaim.medianAgeSec)} / ${buckets}`,
    );
  }
  // 欄ごと無い回は 0 に潰さず行を出さない: 在る欄の0は「数えて0本だった」で、取れなかったのとは別のため
  const { notFired } = reclaim;
  if (notFired !== undefined) {
    lines.push(...runnerNotFiredLines(notFired));
  }
  return lines;
}

// pids の内訳（ゾンビ・comm・孤児）。`tasks` が無い runner ではこの行そのものを省く: 「0」でも「unknown」でもなく、3状態を新しく混ぜないため
function runnerTaskLines(tasks: RunnerTasks): string[] {
  const lines: string[] = [];
  const aliveThreads = tasks.threads - tasks.zombies;
  const aliveProcesses = tasks.processes - tasks.zombies;
  lines.push(
    `    内訳: ゾンビ ${tasks.zombies} / 生存 ${aliveThreads}` + `（${aliveProcesses}プロセス）`,
  );
  if (tasks.zombieCommands !== undefined && tasks.zombieCommands.length > 0) {
    lines.push(
      `    ゾンビの comm: ${tasks.zombieCommands
        .map((entry) => `${entry.command} ${entry.count}`)
        .join(', ')}`,
    );
  }
  if (tasks.oldestZombieSeconds !== undefined) {
    lines.push(`    いちばん古いゾンビ: ${describeZombieAge(tasks.oldestZombieSeconds)}`);
  }
  // 欄が無い・走査が読めなかった回では行そのものを出さない: 「0本だった」と「数えられなかった」を混ぜないため。`pids` を同じ行に並べる: 返るはずの量と返る先の空きは組で読むため
  const { reclaim } = tasks;
  if (reclaim !== undefined) {
    lines.push(...runnerReclaimLines(reclaim));
  }
  return lines;
}

// pids の3つの状態（読めた／訊けなかった／訊けたが読めない）を混ぜない: 疑う先が違うので同じ文言に倒さない
function runnerPidsLines(runner: RunnerOverview): string[] {
  const lines: string[] = [];
  if (runner.resources === undefined) {
    const probe = runner.resourcesProbe;
    if (probe?.status === 'unheard') {
      lines.push('  pids: 確かめていない（繋がっていないので聞いていない）');
    } else if (probe?.status === 'failed') {
      lines.push(`  pids: 訊いたが失敗した: ${probe.error}`);
    } else if (probe?.status === 'unsupported') {
      lines.push('  pids: 確かめられない（この runner は口を持たない。古い版）');
    } else if (probe?.status === 'asked') {
      lines.push('  pids: 訊けたが、応答に資源が無かった');
    } else {
      lines.push('  pids: runner に訊けなかった（器が開いていない、または応答が無い）');
    }
  } else if (runner.resources.pids === undefined) {
    lines.push('  pids: 訊けたが読めない器だった（cgroup を持たない。ローカル開発など）');
  } else {
    const { current, max } = runner.resources.pids;
    lines.push(`  pids: ${current} / ${max}`);
    const { tasks } = runner.resources;
    if (tasks !== undefined) {
      lines.push(...runnerTaskLines(tasks));
    }
  }
  return lines;
}

// 資源（`resources === true` のときだけ呼ぶ）: pids・内訳・孤児・持ち主の記録。「言えないこと」は器ごとに繰り返さず一覧の末尾に1度だけ出す: 台数ぶん並べると断りが本体を上回って読み飛ばされるため
function runnerResourceLines(runner: RunnerOverview): string[] {
  const lines = runnerPidsLines(runner);
  // `pids` の読めた・読めないとは独立した材料: 欄が無い（古い runner）ときは行を出さない
  const ownerRecords = runner.resources?.pidOwnerRecords;
  if (ownerRecords !== undefined) {
    lines.push(
      `  持ち主の記録 ${ownerRecords.remembered.toLocaleString('en-US')}/` +
        `${ownerRecords.cap.toLocaleString('en-US')}・` +
        `上限で忘れた累計 ${ownerRecords.forgottenTotal.toLocaleString('en-US')}`,
    );
  }
  return lines;
}

// 器1台ぶんを1つのブロックにしてから予算で積む: 行ごとに積むと、予算に当たった器が途中の1行で切れて「版が無い器」に見えるため
function describeRunnerBlock(runner: RunnerOverview, show: RunnerListShow): string {
  const lines: string[] = [
    ...runnerHeaderLines(runner),
    runnerManagersLine(runner),
    // 表示そのものを引数で二重に締める: どちらか片方が緩んでも既定で漏れないよう `fingerprints === true` のときしか出さない
    ...(show.fingerprints ? runnerFingerprintLines(runner) : []),
    ...runnerPushHealthLines(runner),
    ...(show.resources ? runnerResourceLines(runner) : []),
  ];
  return lines.join('\n');
}

// 末尾の注記。固定の2文は、同じ会話の2回目から札にする（fold は道具の式が作って渡す。呼ぶ順は since-note → pids-note のまま）
function describeRunnerListTail(
  autoFoldedNote: string,
  fold: FixedFold,
  resources: boolean,
  unassigned: RunnerManagerEntry[],
): string[] {
  const tail: string[] = [];
  if (autoFoldedNote !== '') tail.push(autoFoldedNote.trimStart());
  // 「この状態になった」の注記は器ごとに繰り返さず末尾に1度だけ添える: 名簿はインメモリで再起動すると `since` が巻き戻り、「ずっと保持されている記録」と誤読されないため
  tail.push(
    fold(
      'runner-list:since-note',
      '「この状態になった」は名簿の値。名簿（Registry）はインメモリなので、' +
        'デーモンを再起動すると作り直される。',
      '「この状態になった」は名簿の値で、デーモンの再起動で作り直される。',
    ),
  );
  // pids を出したなら、その数字が言えないことを必ず添える: 言えないことを書いていない計器は、読む側が言えると思い込むため
  if (resources) {
    tail.push(
      fold(
        'runner-list:pids-note',
        'pids について: **pids の現在値/上限そのものは今も器の合計であって内訳ではない。** ' +
          'この2つの数字だけからは、何がその数を持っているかは分からない。' +
          '**対応している runner なら、その内訳（ゾンビ/生存・ゾンビの comm 別・' +
          'いちばん古いゾンビの年齢）が器ごとのブロックに出る**（' +
          '対応していない runner——古い版——では内訳の行自体が出ない）。' +
          '**空き（上限 − 現在値）は「次に何本置けるか」を意味しない**——実測では ' +
          'vitest が1本立ち上がるだけで pids が +131 跳ねている。',
        'pids について: **現在値/上限は器の合計であって内訳ではない。空きは「次に何本置けるか」を意味しない**（内訳は対応する runner のブロックに出る）。',
      ),
    );
  }
  if (unassigned.length > 0) {
    tail.push(
      `どの器か分からない: ${unassigned.length}件（` +
        describeRunnerManagerEntries(unassigned) +
        '）。runnerId が記録されていない古いマネージャーで、どの器の内訳にも混ぜていない。',
    );
  }
  return tail;
}

// 予算で切る頁。省略の断りと続きの案内（cursor）もここで作る
function renderRunnerListPage(
  blocks: string[],
  view: RunnerOverview[],
  registeredCount: number,
): string {
  return renderListing(blocks, {
    budget: RUNNER_LIST_BUDGET,
    omitted: ({ rest, shown }) => {
      // 母数は cursor を当てる前の全件: 頁が進んでも動かさないため
      const lastShown = view[shown - 1]!;
      return (
        `…ほか ${rest} 台は省略（登録は ${registeredCount} 台あり、${shown} 台だけ出した）。` +
        `続きは runner_list cursor=${encodeRunnerCursor({ label: lastShown.label })} で取れる。`
      );
    },
  });
}

type ArchiveRemoveManyStores = CloneToolsShared['stores'];

interface ArchiveRemoveManyInput {
  sessionIds: string[] | undefined;
  before: string | undefined;
  minStoredBytes: number | undefined;
  summary: string;
}

// 引数の検査。断る文を返す（通れば null）。順序は元のまま
function describeArchiveRemoveManyViolation(input: ArchiveRemoveManyInput): string | null {
  const { sessionIds, before, minStoredBytes, summary } = input;
  const sessionIdsLengthError = describeArrayLengthViolation('sessionIds', sessionIds, {
    min: 1,
  });
  if (sessionIdsLengthError !== null) return sessionIdsLengthError;
  const sessionIdsElementError = describeStringArrayElementLengthViolation(
    'sessionIds',
    sessionIds,
  );
  if (sessionIdsElementError !== null) return sessionIdsElementError;
  const beforeLengthError = describeStringLengthViolation('before', before, { min: 1 });
  if (beforeLengthError !== null) return beforeLengthError;
  const summaryError =
    describeStringLengthViolation('summary', summary, { min: 1 }) ??
    describeBlankViolation('summary', summary);
  if (summaryError !== null) return summaryError;
  if (sessionIds === undefined && before === undefined && minStoredBytes === undefined) {
    return (
      'sessionIds / before / minStoredBytes のどれも渡さない呼びは断る' +
      '——それは絞り込みが無いのと同じで、1回でアーカイブを空にできてしまう。' +
      '**1件も消していない。**'
    );
  }
  // 3段で検める: 存在しない日付や日付でない文字列を別の時刻として読んで消すため。元に戻せない一括削除なので時差も必須にする
  if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
    return (
      describeOffsetRequiredTimeBoundary('before', before, '2026-09-15T00:00:00.000Z') +
      '**1件も消していない。**'
    );
  }
  const minStoredBytesError = describeIntRangeViolation('minStoredBytes', minStoredBytes, {
    min: 0,
  });
  if (minStoredBytesError !== null) return minStoredBytesError;
  return null;
}

function describeArchiveRemoveManyFilterText(input: ArchiveRemoveManyInput): string {
  const { sessionIds, before, minStoredBytes } = input;
  return [
    ...(sessionIds === undefined ? [] : [`sessionIds=[${sessionIds.join(', ')}]`]),
    ...(before === undefined ? [] : [`before=${before}`]),
    ...(minStoredBytes === undefined ? [] : [`minStoredBytes=${minStoredBytes}`]),
  ].join(' / ');
}

// 墓標の一覧 → アーカイブの一覧 → 絞りと選定（読む順は元のまま。各1回）
async function selectArchiveRemoveManyTargets(
  stores: ArchiveRemoveManyStores,
  input: ArchiveRemoveManyInput,
): Promise<{ selection: ArchiveRemovalSelection; filterText: string }> {
  const { sessionIds, before, minStoredBytes } = input;
  // 墓標を守る
  // 順番待ちの墓標も守る（#4884）
  const protectedIds: string[] = (await stores.sessions.listTranscriptGraves()).map(
    (g) => g.archiveId,
  );

  const filter: ArchiveRemoveManyFilter = {
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(before === undefined ? {} : { before }),
    ...(minStoredBytes === undefined ? {} : { minStoredBytes }),
  };
  const filterText = describeArchiveRemoveManyFilterText(input);

  // 絞りと選定は `selectArchiveRemovalTargets` に閉じる: ロジックを書き写すと片方だけ変えたとき黙って食い違うため
  const allRows = await stores.archive.list();
  const selection = selectArchiveRemovalTargets(allRows, filter, { protectedIds });
  return { selection, filterText };
}

function renderArchiveRemoveManyFunnel(selection: ArchiveRemovalSelection): string {
  return `アーカイブ全 ${selection.totalRows} 行 → 絞り込みで ${selection.matched} 件`;
}

function describeArchiveRemoveManyZeroReason(totalRows: number): string {
  return totalRows === 0
    ? 'アーカイブそのものに行が無い。**絞り込みの問題ではない**（消すべきものがそもそも無い）。'
    : '絞り込みに当たる行が0件——**絞り込みが外れている。**';
}

function renderArchiveRemoveManyZeroResult(funnel: string, totalRows: number): string {
  const why = describeArchiveRemoveManyZeroReason(totalRows);
  return ['絞り込みに当たる行は0件だった。**1件も消していない。**', funnel, why].join('\n');
}

// 走行中のマネージャーが使っている行を外す。`context.managers` は対象1件ごとに読む（元のまま）
function partitionArchiveRemoveManyByGuard(
  context: ToolContext,
  targets: readonly ArchiveEntry[],
): { removableTargets: ArchiveEntry[]; skippedInUse: number } {
  const removableTargets: ArchiveEntry[] = [];
  let skippedInUse = 0;
  for (const target of targets) {
    const guard = guardArchiveRemoval(context.managers, target.id, undefined, true);
    if (guard.kind === 'denied' || guard.kind === 'unknown') {
      skippedInUse += 1;
      continue;
    }
    removableTargets.push(target);
  }
  return { removableTargets, skippedInUse };
}

function renderArchiveRemoveManySkippedLine(
  skipped: ArchiveRemovalSelection['skipped'],
  skippedInUse: number,
): string {
  return (
    `skipped: protected(墓標) ${skipped.protected} / ` +
    `alreadyRemoved ${skipped.alreadyRemoved} / newest ${skipped.newest} / ` +
    `notContained ${skipped.notContained} / inUse(走行中) ${skippedInUse}`
  );
}

function renderArchiveRemoveManyRemainingLine(remaining: number): string {
  return `remaining（limit に溢れて対象にすらならなかった件数）: ${remaining}`;
}

function renderArchiveRemoveManyInUseNote(skippedInUse: number): string[] {
  return skippedInUse === 0
    ? []
    : [
        '走行中のマネージャーが使っている行は一括では開けない（override は無い）。' +
          '開けるなら archive_remove（単発）に overrideReason を渡して1件ずつ名指しすること。',
      ];
}

function renderArchiveRemoveManyDryRunIds(removableTargets: readonly ArchiveEntry[]): string {
  const shown = removableTargets.slice(0, ARCHIVE_REMOVE_MANY_IDS_SHOWN).map((row) => row.id);
  const hidden = removableTargets.length - shown.length;
  return `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
    hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
  }`;
}

function renderArchiveRemoveManyDryRun(args: {
  funnel: string;
  filterText: string;
  targeted: number;
  matchedCount: number;
  skippedLine: string;
  remainingLine: string;
  removableTargets: readonly ArchiveEntry[];
  skippedInUse: number;
}): string {
  const { funnel, filterText, targeted, matchedCount, skippedLine, remainingLine } = args;
  return [
    '**試算（dryRun）。1件も消していない。** 実際に消すには dryRun: false を渡すこと。',
    funnel,
    `絞り込み: ${filterText}`,
    `この呼びで消すのは ${targeted} 件（当たったのは ${matchedCount} 件。` +
      `1回の上限 ${ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT} 件）。`,
    skippedLine,
    remainingLine,
    renderArchiveRemoveManyDryRunIds(args.removableTargets),
    ...renderArchiveRemoveManyInUseNote(args.skippedInUse),
  ].join('\n');
}

// 塊ごとの先の日誌の行
function buildArchiveRemoveManyJournalEntry(args: {
  index: number;
  chunkCount: number;
  chunkTargetIds: readonly string[];
  summary: string;
  filterText: string;
}): JournalEntryInput {
  const { index, chunkCount, chunkTargetIds, summary, filterText } = args;
  return {
    type: 'decision',
    decision:
      `退避済み生ログの本文を絞り込みで一括して tombstone する` +
      `（${index + 1}/${chunkCount} 塊目、この塊は ${chunkTargetIds.length} 件）: ${summary}\n` +
      `絞り込み: ${filterText}\n` +
      `消す id: ${chunkTargetIds.join(' ')}`,
    grounds: summary,
  };
}

function describeArchiveRemoveManyStopped(args: {
  index: number;
  chunkCount: number;
  chunkSize: number;
  error: unknown;
}): string {
  const { index, chunkCount, chunkSize, error } = args;
  return (
    `⚠⚠ ${index + 1}/${chunkCount} 塊目の先の日誌が書けなかったので、この塊（${chunkSize} 件）と` +
    `それ以降は消さずに止めた（${collapseErrorCause(error)}）。` +
    `止める前の ${index} 塊は消えていて日誌にも残っている。残りは同じ絞り込みでもう一度呼べば続きから消せる。`
  );
}

// 「日誌に N 件」は実際に書いた件数で数える: 塊の先の行が書けて止めた回に、書いていない行を名乗らないため
interface ArchiveRemoveManyRunState {
  removedIds: string[];
  removedBytes: number;
  raced: number;
  journaledChunks: number;
  stoppedNote: string | undefined;
}

// 塊ごとに「その塊の id を日誌へ書く → 消す」を交互に回す（`removeArchiveChunkJournalFirst`）: 本文は戻らないので、消してから書くと日誌が落ちた回に何を消したかが残らないため
async function removeArchiveTargetsJournaling(args: {
  stores: ArchiveRemoveManyStores;
  removableTargets: readonly ArchiveEntry[];
  summary: string;
  filterText: string;
}): Promise<ArchiveRemoveManyRunState> {
  const { stores, removableTargets, summary, filterText } = args;
  const chunks = chunkIdsByChars(
    removableTargets.map((row) => row.id),
    ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  );
  const state: ArchiveRemoveManyRunState = {
    removedIds: [],
    removedBytes: 0,
    raced: 0,
    journaledChunks: 0,
    stoppedNote: undefined,
  };
  for (const [index, chunk] of chunks.entries()) {
    const chunkIds = new Set(chunk);
    const chunkTargetIds = removableTargets
      .filter((row) => chunkIds.has(row.id))
      .map((row) => row.id);
    const outcome = await removeArchiveChunkJournalFirst(stores, chunkTargetIds, () =>
      buildArchiveRemoveManyJournalEntry({
        index,
        chunkCount: chunks.length,
        chunkTargetIds,
        summary,
        filterText,
      }),
    );
    if (outcome.kind === 'journal-failed') {
      // 先の行が書けなかった塊は消していない。1つも消していなければ行為は起きていない（`act-not-performed`）。
      noteDroppedRecord('日誌', journalEntryShape(outcome.entry), outcome.error);
      if (state.removedIds.length === 0 && state.raced === 0 && state.journaledChunks === 0) {
        throw new JournalNotRecordedError(
          'archive_remove_many',
          outcome.entry,
          'act-not-performed',
          outcome.error,
        );
      }
      // 前の塊は消えていて日誌にも在るので投げず、どこまで消したかを返す（投げると「やり直してよい」が前の塊について嘘になる）
      state.stoppedNote = describeArchiveRemoveManyStopped({
        index,
        chunkCount: chunks.length,
        chunkSize: chunkTargetIds.length,
        error: outcome.error,
      });
      break;
    }
    state.journaledChunks += 1;
    // 他経路が先に消していた回は `raced` へ数える（`already` も同じ競合）: この呼びが消したことにしない（打ち消しの行は helper が足してある）
    state.removedIds.push(...outcome.removedIds);
    state.removedBytes += outcome.removedBytes;
    state.raced += outcome.racedIds.length;
  }
  return state;
}

function renderArchiveRemoveManyRemovedIds(
  removedIds: readonly string[],
  journaledChunks: number,
): string {
  const shownRemoved = removedIds.slice(0, ARCHIVE_REMOVE_MANY_IDS_SHOWN);
  const hiddenRemoved = removedIds.length - shownRemoved.length;
  return `消した id（先頭 ${shownRemoved.length} 件）: ${shownRemoved.join(', ')}${
    hiddenRemoved > 0
      ? ` …ほか ${hiddenRemoved} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
      : ''
  }`;
}

function renderArchiveRemoveManyRacedNote(targeted: number, raced: number): string[] {
  return raced === 0
    ? []
    : [
        `⚠ 対象 ${targeted} 件のうち ${raced} 件は消せなかった` +
          '（この呼びの最中に他の経路が先に消した）。',
      ];
}

function renderArchiveRemoveManyDone(args: {
  summary: string;
  funnel: string;
  filterText: string;
  skippedLine: string;
  remainingLine: string;
  targeted: number;
  skippedInUse: number;
  state: ArchiveRemoveManyRunState;
}): string {
  const { summary, funnel, filterText, skippedLine, remainingLine, targeted, state } = args;
  return [
    ...(state.stoppedNote === undefined ? [] : [state.stoppedNote]),
    `**${state.removedIds.length} 件の本文を tombstone した**（理由: ${summary}）。` +
      '行そのものは残っている（list には引き続き出る）。',
    funnel,
    `絞り込み: ${filterText}`,
    skippedLine,
    remainingLine,
    `消した本文の合計: ${state.removedBytes.toLocaleString('ja-JP')} バイト` +
      describeArchiveRemovedBytesUnit(),
    renderArchiveRemoveManyRemovedIds(state.removedIds, state.journaledChunks),
    ...renderArchiveRemoveManyRacedNote(targeted, state.raced),
    ...renderArchiveRemoveManyInUseNote(args.skippedInUse),
  ].join('\n');
}

export function opsTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;

  // 道具の組み立て1回（＝セッション1本）の中だけで覚える: セッションをまたいで古い生ログを持ち越さないため（#4638）
  const transcriptPages = new TranscriptPageCache();

  return [
    // `manager_report` に `part: 'transcript'` を足さない: 「無い」の意味が違い、大きさの桁も違い、1つの説明文に2つの契約を載せると読む側がどちらの「無い」を見ているか分からなくなるため
    tool(
      'manager_transcript',
      [
        'マネージャーのセッションそのものの生ログを読む（JSONL、1行1イベント）。',
        'manager_report の報告は要約された最終報告でしかない——それでも足りないとき、',
        '実際に何が起きたか（どの道具をどう呼んだか等）を確かめるにはここまで降りる。',
        '走行中なら runner のディスクから、畳まれていれば退避済みアーカイブから、',
        'それも無ければ預かったセッションの生ログから返る（3段のどこかにあれば返る）。',
        '長ければ続きの取り方が末尾に出るので、最後まで読み切ること。',
        '大きな生ログを何百ページもめくらずに探せるよう、絞りを4つ渡せる',
        '（どれも省略できる。1つも渡さなければ出力は絞らないときと1文字も',
        '変わらない）——since/until（ISO 8601。各行の timestamp 欄がこの窓に',
        '入る行だけ残す。since は含む・until は含まない）、type（行の type 欄。',
        'カンマ区切りで複数指定できる）、contains（行の生の文字列の部分一致。',
        '例 contains=\'"stop_reason":"tool_use"\'。JSON として読めない行にも',
        '掛かる）。絞ったときは先頭に「全X行のうちY行が当たった」を出し、',
        '時刻の窓を渡したときは timestamp の無い行・JSON として読めない行を',
        '（窓の判定ができないので）除いた数も出す——黙って捨てない。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        offset: z
          .number()
          .optional()
          .describe(
            `何文字目から読むか（${formatIntRangeJa({ min: 0 })}）。前回の応答が示した続きの位置を渡す`,
          ),
        since: z
          .string()
          .optional()
          .describe(
            '絞り: ISO 8601。各行の timestamp 欄がこの時刻以降（含む）の行だけ残す' +
              '（例 2026-08-15T09:00:00Z）。until と組み合わせて窓を作る',
          ),
        until: z
          .string()
          .optional()
          .describe('絞り: ISO 8601。timestamp 欄がこの時刻より前（含まない）の行だけ残す'),
        type: z
          .string()
          .optional()
          .describe(
            '絞り: 行の type 欄で絞る。カンマ区切りで複数指定できる（例 assistant,result）',
          ),
        contains: z
          .string()
          .optional()
          .describe(
            '絞り: 行の生の文字列にこの部分文字列を含む行だけ残す' +
              '（例 "stop_reason":"tool_use"）。JSON として読めない行にも掛かる',
          ),
      },
      async ({ managerId, offset = 0, since, until, type, contains }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        // since/until が読めるかはここで見る: 読めない値は生ログを読みに行く前に断るため
        if (since !== undefined && !isReadableJournalTimeBoundary(since)) {
          return text(describeUnreadableJournalTimeBoundary('since', since) + '生ログは絞れない。');
        }
        if (until !== undefined && !isReadableJournalTimeBoundary(until)) {
          return text(describeUnreadableJournalTimeBoundary('until', until) + '生ログは絞れない。');
        }
        if (!context.managers) return NO_POOL;
        // 続きの頁は1枚目に取り寄せて絞った本文を使い回す: 頁ごとに全文（退避なら数十〜百 MB 級）を取り寄せて絞り直すと、そのたびにデーモンのループが止まるため（#4638）
        const cacheKey = transcriptPageCacheKey({ managerId, since, until, type, contains });
        const hasFilter =
          since !== undefined ||
          until !== undefined ||
          type !== undefined ||
          contains !== undefined;
        const reused = offset > 0 ? transcriptPages.get(cacheKey) : undefined;
        let snapshot: TranscriptPageSnapshot;
        if (reused !== undefined) {
          snapshot = reused;
        } else {
          const result = await context.managers.transcript(managerId);
          if (result.kind === 'unreadable') {
            // 読めない行を「生ログは無い」と言わない
            return text(`${result.detail}生ログには降りていない。`);
          }
          if (result.kind === 'missing') {
            // `missing` が2つの意味を畳んでいることを隠さずそう書く: `ManagerPool.transcript()` が区別する値を返さないため
            return text(
              `マネージャー ${managerId} の生ログは無い。走行中の runner のディスク・` +
                '退避済みアーカイブ・預かったセッションの生ログ、3段のどこにも見当たらなかった。' +
                `（${managerId} という id 自体が台帳に無い場合と、id はあるが生ログが` +
                '一度も残らなかった場合のどちらも、この応答だけでは区別できない。' +
                'manager_list に出ているかで id の実在は別途確かめられる。）\n\n' +
                (await describeTranscriptMissingLeg(context.managers, managerId)),
            );
          }
          if (result.kind === 'removed') {
            // `missing` と同じ文面へ畳まない: 退避そのものは在ったが本文が落とされており、「どこにも無かった」ではなく「消された」ため
            return text(
              `マネージャー ${managerId} の生ログは退避されていたが、本文は消されている` +
                `（${result.removedAt} に ${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
                `archive id: ${result.archiveId}）。` +
                '走行中の runner のディスク・預かったセッションの生ログにも見当たらなかった。',
            );
          }

          const { body: rawBody, archiveId } = result;

          let body = rawBody;
          let filterNote = '';
          if (hasFilter) {
            const types =
              type === undefined
                ? undefined
                : type
                    .split(',')
                    .map((t) => t.trim())
                    .filter((t) => t.length > 0);
            const filtered = await filterTranscriptLinesYielding(rawBody, {
              since,
              until,
              types,
              contains,
            });
            body = filtered.body;
            const { totalLines, matchedLines, noTimestampLines, unparsableLines } = filtered.counts;
            // 「全X行のうちY行が当たった」は0件でも出す: 黙って空の本文を返すと「絞りが効いていない」のか「本当に0件だった」のか区別できないため
            const noteLines = [
              `絞り込み: 全 ${totalLines} 行のうち ${matchedLines} 行が当たった。`,
            ];
            if (since !== undefined || until !== undefined) {
              // 窓を渡したときは除いた行数を0件でも出す: 黙って捨てると「窓の判定ができない行があった」という事実そのものが出力から消えるため
              noteLines.push(
                `（時刻の無い行 ${noTimestampLines} 行・読めない行 ${unparsableLines} 行は` +
                  '窓の判定ができないので除いた）',
              );
            } else if (unparsableLines > 0) {
              noteLines.push(
                `（JSON として読めない行 ${unparsableLines} 行は type の判定ができないので除いた）`,
              );
            }
            filterNote = noteLines.join('\n') + '\n\n';
          }
          snapshot = {
            body,
            filterNote,
            ...(archiveId === undefined ? {} : { archiveId }),
            fetchedAt: new Date().toISOString(),
          };
        }

        const part1 = page(snapshot.body, offset, TRANSCRIPT_PAGE);
        // 続きが残る間だけ覚え、最後の頁を出したら捨てる: 読み終えた本文をヒープに残さないため
        if (part1.more) transcriptPages.set(cacheKey, snapshot);
        else transcriptPages.clear();
        const archiveNote =
          snapshot.archiveId === undefined
            ? ''
            : `（archive id: ${snapshot.archiveId}。archive_remove archiveId=${snapshot.archiveId} で消せる）`;
        const head = `マネージャー ${managerId} の生ログ（${describePage(part1)}）${archiveNote}`;
        // 続きの取り方に今回渡した絞りの引数をそのまま付ける: 付けないと、続きを読んだ瞬間に絞りが外れて窓の外の行まで読めてしまうため
        const resumeFilterArgs = hasFilter
          ? [
              since !== undefined ? ` since=${since}` : '',
              until !== undefined ? ` until=${until}` : '',
              type !== undefined ? ` type=${type}` : '',
              contains !== undefined ? ` contains=${contains}` : '',
            ].join('')
          : '';
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_transcript managerId=${managerId} offset=${part1.to}${resumeFilterArgs}）`
          : '';
        // 使い回した頁にはいつの生ログかを添える: 1枚目より後に書かれた行は載らないため
        const reuseNote =
          reused === undefined
            ? ''
            : `\n（この頁は1枚目を読んだ時点（${snapshot.fetchedAt}）の生ログを使い回している。それより後の行は offset を付けずに読み直すと載る）`;
        return text(`${snapshot.filterNote}${head}${reuseNote}\n\n${part1.body}${tail}`);
      },
    ),

    // 存在しない id を黙って成功にしない・本文は日誌へ写さない
    // 判定は `guardArchiveRemoval()` 1箇所だけを通す: 2箇所に書くと片方だけ直る形になるため。override したときは理由と走行中だったマネージャーの id を日誌へ残す（黙って通さない）
    tool(
      'archive_remove',
      [
        'アーカイブ済みセッション生ログの本文を1件消す（tombstone。行そのものは残る——',
        'archive の一覧には引き続き出る。DELETE ではない）。',
        '無い id を渡しても成功にはならず、そう返る。',
        '走行中のマネージャーの退避は既定では消せない（拒む。どのマネージャーが走行中かを言う）。',
        'それでも消す必要があるなら overrideReason にその理由を書く——渡すと通り、',
        '「override で消した」事実と理由が日誌に残る（黙って通る経路は無い）。',
        '消した事実は日誌に残る（archive id と直前のバイト数のみ。本文は残らない）。',
        'id は manager_transcript の応答に載る（「この本文を読んだ archive id」）——',
        '読んだ直後にそこから渡せる。',
      ].join(' '),
      {
        archiveId: z.string().describe('manager_transcript が出す archive id'),
        summary: z.string().describe('なぜ消したかの一行要約（日誌に残る。本文は残らない）'),
        overrideReason: z
          .string()
          .optional()
          .describe(
            '走行中のマネージャーの退避を、それでも消す理由。渡さなければ拒否される' +
              '（省略時は既定の拒否のまま）。渡すと「override で消した」として理由ごと日誌に残る。',
          ),
      },
      async ({ archiveId, summary, overrideReason }) => {
        // 消す・日誌を書くより前に断る（`archive_remove_many` と同じ2検査）: 理由が空の「本文を消す」行が日誌に残るため
        const summaryError =
          describeStringLengthViolation('summary', summary, { min: 1 }) ??
          describeBlankViolation('summary', summary);
        if (summaryError !== null) return text(summaryError);
        const guard = guardArchiveRemoval(context.managers, archiveId, overrideReason);
        if (guard.kind === 'unknown') {
          return text(
            '消せない——いまは委譲の道具が配線されていない内部ターンで、走行中の' +
              'マネージャーがこの退避を使っているかどうかを確かめる材料が無い' +
              '（安全側に倒して拒む）。',
          );
        }
        if (guard.kind === 'denied') {
          return text(
            `消せない——マネージャー ${guard.managerId} がいま走行中で、この退避を使っている` +
              '（走行中の委譲を追う最後の手段が消えるため。それでも消すなら overrideReason に' +
              '理由を書くこと）。',
          );
        }
        // 本文は消すと戻らないので、日誌を先に書いてから消す（`removeArchiveJournalFirst`）。書けなければ消さない（`act-not-performed`）。
        // 消す対象・理由・override は消す前に決まるので先の行へ。バイト数と「前から消されていたか」は消した後でないと分からないので2行目に足す（落ちても握る）。
        const overrideNote =
          guard.kind === 'allowed-with-override'
            ? `（⚠️ override — 走行中のマネージャー ${guard.managerId} の退避だが、` +
              `理由「${guard.reason}」により消す）`
            : '';
        const grounds =
          guard.kind === 'allowed-with-override' ? `${summary}／${overrideNote}` : summary;
        const result = await removeArchiveJournalFirst(stores, archiveId, {
          buildEntry: () => ({
            type: 'decision',
            decision: `退避済み生ログの本文を消す: ${archiveId}: ${summary}${overrideNote}`,
            grounds,
          }),
          buildAfterEntry: (done) => ({
            type: 'decision',
            decision:
              `退避済み生ログの本文を消した結果: ${archiveId}（${done.bytes} バイト${describeArchiveRemovedBytesUnit()}。` +
              `${done.kind === 'already' ? '前から消されていたので今回は何も変わっていない' : 'いま消した'}）`,
            grounds,
          }),
        });
        if (result.kind === 'journal-failed') {
          // 消す前に落ちたので何も起きていない（`act-not-performed`）
          noteDroppedRecord('日誌', journalEntryShape(result.entry), result.error);
          throw new JournalNotRecordedError(
            'archive_remove',
            result.entry,
            'act-not-performed',
            result.error,
          );
        }
        if (result.kind === 'missing') {
          return text(`アーカイブ ${archiveId} は存在しない（消せない。何も変わっていない）。`);
        }
        if (result.kind === 'already') {
          return text(
            `アーカイブ ${archiveId} は前から消されている（${result.removedAt} に ` +
              `${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}）。何も変わっていない。`,
          );
        }
        return text(
          `アーカイブ ${archiveId} の本文を消した（${result.bytes.toLocaleString('ja-JP')} バイト${describeArchiveRemovedBytesUnit()}）。` +
            `行そのものは残っている（list には引き続き出る）。${overrideNote}`,
        );
      },
    ),

    // `overrideReason` を持たない: 一括で複数件を無条件に開ける形は事故の芽が大きく、開ける口は単発の `archive_remove` に既に在るため（走行中の委譲が使っている行は一括の対象から外す）
    // `limit` / `requireContainment` は引数に持たない: 既定の安全側のまま使い、溢れた分は `remaining` として名乗る
    // 実行は `stores.archive.remove(id)` を1件ずつ: 一括 UPDATE にしない
    tool(
      'archive_remove_many',
      [
        'アーカイブ済みセッション生ログの本文を、絞り込んでまとめて消す（tombstone。',
        '行そのものは残る——archive の一覧には引き続き出る。DELETE ではない）。',
        '**既定は試算（dryRun を省略すると true）で、1件も消さない。**',
        'sessionIds / before / minStoredBytes のどれも渡さない呼びは断る——',
        '絞り込みが無いのと同じで、1回でアーカイブを空にできてしまう。',
        '3つは AND で効く（全部渡せば全部に当たった行だけが対象になる）。',
        'セッションの最新行・含有が証明できない行・墓標（まだ記憶へ蒸留していない区間）は',
        '既定で守る。',
        '走行中のマネージャーが使っている退避は一括では消せない（拒む。skipped.inUse に数える）——',
        'ここに override は無い。それでも消す必要があるなら、その id を manager_transcript の',
        '応答か、この道具の下見（dryRun）が返す対象一覧から見つけて、',
        'archive_remove（単発）に overrideReason を渡し1件ずつ名指しで消すこと。',
        '消した id は全部日誌に残る（塊に分けて書く。応答には先頭だけを出す）。',
      ].join(' '),
      {
        sessionIds: z
          .array(z.string())
          .optional()
          .describe(
            `対象セッションの完全一致（配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。省略すると全セッションが対象になりうる`,
          ),
        before: z
          .string()
          .optional()
          .describe(
            `この時刻より前（ISO8601、排他。${formatStringLengthJa({ min: 1 })}）に積まれた行だけを対象にする` +
              '（例 2026-09-15T00:00:00.000Z）',
          ),
        minStoredBytes: z
          .number()
          .optional()
          .describe(
            `storedBytes がこれ以上の行だけを対象にする（${formatIntRangeJa({ min: 0 })}）`,
          ),
        summary: z
          .string()
          .describe(
            `なぜ消したかの一行要約（日誌に残る。本文は残らない。${formatStringLengthJa({ min: 1 })}）`,
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            '省略すると true（何件当たるかを数えるだけで1件も消さない）。実際に消すときだけ false を明示する',
          ),
      },
      async ({ sessionIds, before, minStoredBytes, summary, dryRun }) => {
        const input: ArchiveRemoveManyInput = { sessionIds, before, minStoredBytes, summary };
        const violation = describeArchiveRemoveManyViolation(input);
        if (violation !== null) return text(violation);

        const { selection, filterText } = await selectArchiveRemoveManyTargets(stores, input);
        const funnel = renderArchiveRemoveManyFunnel(selection);

        if (selection.matched === 0) {
          return text(renderArchiveRemoveManyZeroResult(funnel, selection.totalRows));
        }

        // `requireContainment` には常に `true` を渡す: 走行中の委譲の保護を `archiveIds` の末尾1本へ狭めないと、過去に積んだ写しが1本残らず保護され一括処理が1件も消せないため
        // この guard は `dryRun` の分岐より前で回す: 下見が返す `targeted` / `skipped.inUse` が実行時と食い違うため
        const { removableTargets, skippedInUse } = partitionArchiveRemoveManyByGuard(
          context,
          selection.targets,
        );
        // `targeted` は guard を通った後の件数にする: 飛ばした行を `skipped.inUse` と2回数えないため
        const targeted = removableTargets.length;

        const skippedLine = renderArchiveRemoveManySkippedLine(selection.skipped, skippedInUse);
        const remainingLine = renderArchiveRemoveManyRemainingLine(selection.remaining);

        if (dryRun !== false) {
          // 省略された `dryRun` は試算にする: 消した本文を戻す道具が無いため
          return text(
            renderArchiveRemoveManyDryRun({
              funnel,
              filterText,
              targeted,
              matchedCount: selection.matched,
              skippedLine,
              remainingLine,
              removableTargets,
              skippedInUse,
            }),
          );
        }

        const state = await removeArchiveTargetsJournaling({
          stores,
          removableTargets,
          summary,
          filterText,
        });

        return text(
          renderArchiveRemoveManyDone({
            summary,
            funnel,
            filterText,
            skippedLine,
            remainingLine,
            targeted,
            skippedInUse,
            state,
          }),
        );
      },
    ),

    tool(
      'runner_list',
      [
        '委譲先の器（runner のコンテナ）がいくつあり、それぞれで何本のマネージャーが' +
          '走っているかを見る。manager_start の runnerId に渡す名前もここで分かる。',
        'peer の行は、その器のマネージャーが Codex などのもう一方の provider に作業を頼めること' +
          '（と名指しできるモデル）を示す。開いている peer が無い器には行が出ない。' +
          '「不明」は名乗らない旧い runner で、頼めないとは限らない。',
        'ここで数えている本数はデーモンの台帳から見た数である。新しいマネージャーを' +
          'どこへ置くか（資源による自動配置）の判断が使う本数は runner 自身が /health で' +
          '名乗る別の値で、この一覧とはずれうる——混ぜて配置の判断を予測しないこと。',
        'state は6値（connecting/connected/unreachable/unusable/lost/vacating）のまま出る。' +
          'unreachable（まだ開けていない）と lost（開けていたのに黙った）は別物である。' +
          'vacating は「意図して空けている最中」（drain）で、黙ったのではなく空けると決めた側である——' +
          'lost と同じく新しい委譲の置き先からは外れるが、走っていた仕事ごと黙ったわけではない。',
        '各器の「この状態になった」（since）は、その器がいまの state に変わった時刻である' +
          '（作成時刻・更新時刻ではない）。名簿（Registry）はインメモリで永続化するストアを' +
          '持たないので、デーモンを再起動すると名簿ごと作り直され、全 runner の since が' +
          '現在時刻へ巻き戻る——ずっと保持されている記録ではない。',
        // マネージャーの状態の字面は manager_list と揃える: 片方だけが「セッション切断」を出すと、同じ相手を2つの道具で見たクローンがどちらが本当かを判定できないため
        '器ごとの内訳に出るマネージャーの状態は manager_list と同じ字面である' +
          '（running / running/セッション切断 / running/セッション不明 / done/背景処理待ち×N）。' +
          '「背景処理待ち」は、そのマネージャーが自分で起こした背景処理や作業者の完了を待って' +
          '畳んだだけで、手が空いたのではないという意味である（器が名乗った分だけ出る——' +
          'この欄を送らない古い器では、待っていても出ない）。' +
          '「セッション切断」は、このデーモンがその委譲の宛先をいま開けていないという観測であって、' +
          '送っても届かないことの証明ではない（manager_send は resume を試みる）。' +
          '仕事が終わったという意味でもない。',
        'マネージャーの字面の直後に ⚠世代N≠現役M が付くことがある——この委譲が抱えている' +
          '認証トークンの世代（N）と、いまの現役の世代（M）が食い違っている。' +
          '回した直後の短い遅れなら自然に消える。429 が続いたまま消えないなら起こし直すこと。' +
          `${STALE_TOKEN_RESTART_ADVICE}詳しい文面は manager_list に出る。` +
          '一致している・材料が無い（プールを使っていない構成）ときはこの印自体が出ない。',
        'デーモン自身の版と、各 runner が名乗った版（コミット sha）も出る。' +
          'デーモンと runner は別々にデプロイされるので、同じ main から起こしていても' +
          '別のコミットで走る窓がある——調べ物で「コードはこうなっている」と言う前に、' +
          'いま走っている版がその主張と同じかを見ること。',
        '版が「不明」（器が自分の版を知らない）と「未確認」（名乗りをまだ聞けていない）は' +
          '別物で、疑う先が違う（前者は器の設定、後者は登録とネットワーク）。' +
          'state が lost の器の版は黙る前に聞いた古い値である。' +
          '鍵・プロファイル・MCP の登録の指紋（fingerprints: true）も、聞いていない' +
          '（繋がっていないので聞いていない）／聞いたが失敗した／聞いて0件・無しだった、' +
          'を同じ文言に潰さない——「確かめていない」と出たときは鍵が配られていない証拠には' +
          'ならず、「確かめられなかった」と出たときは配り直しでは直らないことがある' +
          '（器そのものに訊けなかった）。MCP の登録だけは、もう1つ「この runner は口を' +
          '持たない（古い版）」という状態も持つ——こちらは runner を上げないと直らない。',
        '「直近の押し込み」は、その器へプロファイル・環境変数・認証トークンを配る' +
          '（`#connectTo`/繋ぎ直しのたびに必ず試みる）処理が、直近どうだったかである。' +
          'state が connected でもこれが1つでも「失敗」なら、その種類はまだ古い値の' +
          'ままで走っている——manager_start する前にここを見て気づける。' +
          '「失敗」は自分から諦めずに挑み直すので、次に見たときには直っていることがある' +
          '（人間が手で繋ぎ直す必要は無い）。まだ一度も試みていない種類は行ごと出ない。',
        'resources: true を渡すと器ごとの pids（プロセス数）の現在値/上限も出る' +
          '。**pids の現在値/上限そのものは今も器の合計である**——何が' +
          'その数を持っているかはこの2つの数字からは分からない。空き（上限 − ' +
          '現在値）も、次に何本置けるかを意味しない——実測では vitest が1本立ち' +
          '上がるだけで pids が +131 跳ねている。**対応している runner なら、' +
          'その合計の内訳（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古い' +
          'ゾンビの年齢）が別行で出る**——対応していない runner' +
          '（古い版）ではこの内訳の行自体が出ない。pids が出ない器は、理由ごとに別の' +
          '文言で出る——「確かめていない」（繋がっていないので聞いていない）・' +
          '「訊いたが失敗した: 理由」（resources() が落ちた）・「確かめられない」' +
          '（この runner は口を持たない古い版）・「訊けたが pids が読めない」' +
          '（cgroup を持たない器）。どれも数字が出ない点は同じだが、疑う先' +
          '（接続・器の RPC・runner の版・器の cgroup 構成）が違う。**そしてこの pids は、いまは配置の材料でもある**' +
          '（点数は「メモリの余り × プロセス数の余り × 新しい1本が受け取る CPU」で、' +
          '最後の項の分母には抱えている本数に加えて直近に起動が失敗した本数も足すので、' +
          '落ちた直後の器は空いて見えても選ばれにくい）——' +
          'pids が枯れた器は自動配置で選ばれにくくなる。**ただし断る材料ではない**——' +
          '枯れていても置き先としては返るので、「置けない」と読まないこと。' +
          '**加えて、新しいプロセスを起こせない器（pids 飽和）は、飽和していない器が1台でも' +
          '居れば自動配置の候補から外れる**（点数を見ずに後ろへ回る）。**全台が飽和なら断らず、' +
          'その中の最良を返す**（飽和は応答で分かる）。飽和の判定は構造化された値だけ——' +
          '現在値が上限に達している（resources: true のときだけ分かる・一瞬の値）、' +
          '直近5分に spawn が EAGAIN で失敗した、直近5分に fork が pids 上限で拒まれた委譲が' +
          '終わった。後ろ2つは resources を付けなくても、connected の器の行に' +
          '「pids 飽和: 新しい委譲を置けない（材料）」として出る。**この行が無いことは' +
          '「飽和ではない」を意味しない**（材料が無いだけ）。' +
          'manager_start で器を名指しした場合も断らず、飽和なら応答にこの行が付く。',
        'resources: true を渡した結果、いずれかの器の pids が逼迫していれば' +
          '（現在値が上限の80%以上）、その器に割り当てられた委譲のうち' +
          '「畳む候補」（manager_list の ⚠ と同じ5条件——done・背景処理待ちの印なし・' +
          '器がその印を送る版だと名乗っている・状態の判定が active・最後のターン終了から' +
          '一定時間経過）を、デーモンが自動で manager_stop 相当（非 force）で畳む' +
          '。**未 push の実装・未コミットの変更が1件でもある' +
          '（または確認できなかった）委譲は畳まない**——安全側に倒す。' +
          '何を畳んだ・見送ったかはこの応答の先頭に出て、日誌にも decision として残る' +
          '（journal_read）。**新しい周期処理ではない**——この道具をこの引数で呼んだ、' +
          'まさにこの1回の中だけで判定と実行が完結する。呼ばなければ何も起きない。',
      ].join(' '),
      {
        fingerprints: z
          .boolean()
          .optional()
          .describe(
            '鍵とプロファイルの指紋（sha256）まで出すか。既定は出さない——' +
              '要らないものを文脈へ載せない側に倒してある。人間は Web UI の設定画面で' +
              '常に見られるので、必要になったらここを true にして開くこと。',
          ),
        resources: z
          .boolean()
          .optional()
          .describe(
            '器ごとの pids（プロセス数）と、対応している runner ならその内訳' +
              '（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古いゾンビの年齢）を' +
              '出すか。既定は出さない——このためにネットワーク往復を足さない側に' +
              '倒してある。頼んだときだけ各 runner の /health を叩く。',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ fingerprints, resources, cursor }, extra: unknown) => {
        if (!context.managers) return NO_POOL;
        const overview = await context.managers.runners({
          ...(fingerprints === undefined ? {} : { fingerprints }),
          ...(resources === undefined ? {} : { resources }),
        });
        const autoFoldedNote = describeRunnerAutoFoldedNote(overview.autoFolded);

        const pageCheck = checkRunnerListPage(overview, cursor, autoFoldedNote);
        if (pageCheck.kind === 'refused') return text(pageCheck.body);

        const head = describeRunnerListHead(
          overview.runners.length,
          pageCheck.daemonLine,
          pageCheck.restarted,
        );
        const show = { fingerprints: fingerprints === true, resources: resources === true };
        const blocks = pageCheck.view.map((runner) => describeRunnerBlock(runner, show));

        // 末尾の固定の2文は、同じ会話の2回目から札にする（`manager_list` と同じ口。札にも結論を残す）。返す直前のここで1度だけ呼ぶ
        const foldRunnerTail = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
        const tail = describeRunnerListTail(
          autoFoldedNote,
          foldRunnerTail,
          resources === true,
          overview.unassigned,
        );

        return text(
          [
            ...head,
            renderRunnerListPage(blocks, pageCheck.view, overview.runners.length),
            ...tail,
          ].join('\n'),
        );
      },
    ),
  ];
}
