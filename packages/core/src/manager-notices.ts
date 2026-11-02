import { redactSecretsInText } from './denial-input-head.js';
import { reasonOf } from './dropped-record.js';
import { NOTIFY_REPORT_EXCERPT, excerptLine } from './excerpt.js';
import { formatDurationMinutes } from './format-elapsed.js';
import type { ManagerRecord, LeaseRefusalKind, ResumeOutcome } from './manager.js';
import type { ManagerReportFiles } from './manager-outbox-fetch.js';
import type {
  HeldMessage,
  Job,
  JobStatus,
  LastRescue,
  LastUnpushedWorkObservation,
  RescueStashEntry,
  WorkspaceLocator,
} from './schema.js';
import {
  anyHintHasLossRisk,
  formatWorkspaceCloneHintLines,
  workspaceCloneHintsFrom,
  type WorkspaceCloneHint,
} from './workspace-swap-hints.js';

/** 畳んだ背景処理のコマンドを一言に載せる最大本数と、1本あたりの字数（#4850）。 */
export const FOLD_NOTICE_COMMANDS_MAX = 5;

const FOLD_NOTICE_COMMAND_CHARS = 160;

/** 鍵の値などの秘密を載せない: 既存の伏せ字（`redactSecretsInText`）を通してから切る。 */
export function redactedBackgroundCommands(commands: readonly string[] | undefined): string[] {
  return (commands ?? [])
    .map((command) =>
      excerptLine(redactSecretsInText(command, undefined), FOLD_NOTICE_COMMAND_CHARS),
    )
    .filter((command) => command.length > 0)
    .slice(0, FOLD_NOTICE_COMMANDS_MAX);
}

/** 鍵の回転の畳みの断り書き。本当に畳んだ背景処理と、畳まずに預けた peer を書き分ける（#4881）。 */
export function composeFoldNotice(notice: {
  backgroundTasks: number;
  peers?: number | undefined;
  commands?: readonly string[] | undefined;
}): string {
  const peers = notice.peers ?? 0;
  const peerClause =
    peers === 0
      ? ''
      : `背景で走っていた peer ${String(peers)} 本は畳まずに預けてあり、まだ続いている。` +
        '止まりどころは起こし直した後に届くので、peer_run でやり直さないこと';
  if (notice.backgroundTasks === 0) {
    return `（alteroid より: 鍵の入れ替えのため、セッションを畳んで新しい鍵で起こし直した。${peerClause}）`;
  }
  return (
    `（alteroid より: 鍵の入れ替えのため、起こしっぱなしだった背景処理 ${String(notice.backgroundTasks)} 本を` +
    // 待たせず続きを進めさせる（#4902）: 畳んだ背景処理の完了の知らせは新しいセッションに二度と届かず、任意の言い方だと「報告済みで待つだけ」と読まれるため
    'セッションごと畳んで、新しい鍵で起こし直した。この背景処理の結果は二度と届かない（古いセッションと一緒に畳んだ）。' +
    // 止めたことと途中の出力の在りかを言う（#5044）: 言わないと、まだ走っている古い処理と同じ場所を取り合うやり直しを始めるため
    '古い背景処理のプロセスは runner が止める（止まるまで1分ほどかかることがある）。' +
    '途中までの出力は、起こしたときの Bash の結果にある出力ファイルに残っていれば読める。' +
    // ps・/proc・env を勧めない（#5196）: 同じ器の他のプロセスの引数・環境に資格が載っていて、確かめた出力にそのまま出るため
    // 作業ツリーで見る手を3つ挙げる（#5196）: 古い処理の多くは作業ツリーへ書く。git の操作の途中なら index.lock が残る
    '同じ処理をやり直す前に、古い処理がまだ動いていないかを、作業ツリーの未コミットの変更が増えていないか（git status）・' +
    '.git/index.lock が残っていないか・作業ツリーのファイルの最後の更新時刻と出力ファイルの末尾が動いていないかで確かめること' +
    '（ps・/proc・env は使わない。他のプロセスの資格が出力に載る）。' +
    '待たずに、いま自分で状態を確かめて（CI・作業者の結果・dev サーバ）、続きを進めよ。もう終わっていたなら、そう報告して終えること' +
    foldNoticeCommandsClause(notice.commands) +
    (peerClause === '' ? '' : `。${peerClause}`) +
    '）'
  );
}

const PEER_CLOSE_REASON_LABELS = {
  expired: '鍵の付け替えで畳んだ担当が戻らないまま、預かりの期限が来た',
  replaced: '同じ担当の peer を預かり直した',
  shutdown: '器を畳んだ',
  stopped: 'ユーザーが止めた',
  failed: '担当のセッションが終わった（落ちた・失効した）',
} as const;

export type PeerCloseReason = keyof typeof PEER_CLOSE_REASON_LABELS;

export interface PeerCloseNotice {
  reason: PeerCloseReason;
  peers: readonly {
    id: string;
    provider: string;
    interrupted?: string | undefined;
    reason?: PeerCloseReason | undefined;
  }[];
}

/**
 * 台帳の peer の閉じの知らせを、理由ごとに分けて書く（#4899）。理由の違う peer を1つの文面に混ぜると、理由と peer の対応がずれる。
 * `peer.reason` が無い（古い台帳）peer は、知らせの `reason` で読む。
 */
export function composePeerCloseNotices(notice: PeerCloseNotice): string {
  const groups = new Map<PeerCloseReason, PeerCloseNotice['peers'][number][]>();
  for (const peer of notice.peers) {
    const reason = peer.reason ?? notice.reason;
    const group = groups.get(reason);
    if (group === undefined) groups.set(reason, [peer]);
    else group.push(peer);
  }
  return [...groups]
    .map(([reason, peers]) => composePeerCloseNotice({ reason, peers }))
    .join('\n\n');
}

/**
 * 配達に畳み込んだ畳みの断り書き（`folded`）を、いまの断り書き（`current`）から引く（#4899）。
 * 積み増しは件数の加算とコマンドの末尾への追加だけなので、畳み込んだ分を引いた残りが「送信の途中で後から積まれた分」になる。残りが無ければ `undefined`。
 */
export function remainingFoldNotice<
  T extends {
    backgroundTasks: number;
    peers?: number | undefined;
    commands?: string[] | undefined;
  },
>(current: T | undefined, folded: T | undefined): T | undefined {
  if (current === undefined || folded === undefined)
    return folded === undefined ? current : undefined;
  const backgroundTasks = Math.max(0, current.backgroundTasks - folded.backgroundTasks);
  const peers = Math.max(0, (current.peers ?? 0) - (folded.peers ?? 0));
  const commands = (current.commands ?? []).slice((folded.commands ?? []).length);
  if (backgroundTasks === 0 && peers === 0) return undefined;
  const next: T = { ...current, backgroundTasks };
  if (peers === 0) delete next.peers;
  else next.peers = peers;
  if (commands.length === 0) delete next.commands;
  else next.commands = commands;
  return next;
}

/** 配達に畳み込んだ peer の閉じの知らせを引く。peer は末尾への追加だけなので、畳み込んだ本数を先頭から落とす。 */
export function remainingPeerCloseNotice<
  T extends { reason: PeerCloseReason; peers: { reason?: PeerCloseReason | undefined }[] },
>(current: T | undefined, folded: T | undefined): T | undefined {
  if (current === undefined || folded === undefined)
    return folded === undefined ? current : undefined;
  const peers = current.peers.slice(folded.peers.length);
  if (peers.length === 0) return undefined;
  return { ...current, reason: peers[peers.length - 1]?.reason ?? current.reason, peers };
}

/** 預けた peer を閉じたことの断り書き（#4885）。担当の次の起こし直しの先頭へ添える。 */
export function composePeerCloseNotice(notice: PeerCloseNotice): string {
  const interrupted = notice.peers.filter((peer) => peer.interrupted !== undefined);
  const interruptedClause =
    interrupted.length === 0
      ? ''
      : `。走っていた背景ターンは途中で終わった: ${interrupted
          .map((peer) => `${peer.provider}[${peer.id}] ${peer.interrupted ?? ''}`)
          .join(' / ')}`;
  return (
    `（alteroid より: peer ${String(notice.peers.length)} 本を閉じた` +
    `（${PEER_CLOSE_REASON_LABELS[notice.reason]}）。閉じた peer: ${notice.peers
      .map((peer) => `${peer.provider}[${peer.id}]`)
      .join(', ')}${interruptedClause}。` +
    '続きが要るなら peer_run で新しく頼むこと。peer_reply は効かない）'
  );
}

function foldNoticeCommandsClause(commands: readonly string[] | undefined): string {
  if (commands === undefined || commands.length === 0) return '';
  return '。畳んだ背景処理のコマンド（分かった分）: ' + commands.map((c) => `\`${c}\``).join(' / ');
}

/** 届け直す本文。遅れて届いたことと、いつ送られたかを頭に付ける: マネージャーが、その間に変わった状況と突き合わせて読めるように。 */
export function composeHeldDelivery(batch: readonly HeldMessage[]): string {
  if (batch.length === 1) {
    const only = batch[0]!;
    return (
      `（alteroid が預かっていた伝言。${only.heldAt} に送られたが、そのときは届けられなかったので、いま届ける）\n\n` +
      only.text
    );
  }
  return [
    `（alteroid が預かっていた伝言 ${String(batch.length)} 通。そのときは届けられなかったので、送られた順にまとめていま届ける）`,
    ...batch.map(
      (item, index) => `--- ${String(index + 1)}通目（${item.heldAt} に送られた）---\n${item.text}`,
    ),
  ].join('\n\n');
}

// `claimableAt` の有無では言い方を変えない: 台帳の書き込み失敗（`persist-failed`）まで「人間が `ALTEROID_RUNNER_ID` を直すまで解けない」側に倒れる。
function describeRefusalResolution(kind: LeaseRefusalKind): string {
  switch (kind) {
    case 'held':
      return '期限が切れたら自動で挑み直す';
    case 'ambiguous':
      return '時間では解けない（人間が ALTEROID_RUNNER_ID 等を直すまで解けない）。挑み直しは続ける';
    case 'persist-failed':
      return (
        '台帳の書き込みが一時的に失敗しただけで、ALTEROID_RUNNER_ID の問題ではない。' +
        '挑み直しは続ける'
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`未知の leaseRefusal.kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// `#restoreJobs` と `#reattach` で共有する: 別々に書くと片方だけ直る形になる。
export function leaseRefusalDecision(
  jobId: string,
  leaseRefusal: { kind: LeaseRefusalKind } | undefined,
): string {
  const resolution =
    leaseRefusal === undefined
      ? '根拠を取れなかった。挑み直しは続ける'
      : describeRefusalResolution(leaseRefusal.kind);
  return `[${jobId}] 引き取りを見送った（貸し出しの関門。${resolution}）`;
}

// 恒久（`no-session`）と一時（`unreadable` / `busy`）を混ぜない: 全部を「起こし直すこと」と言うと、待てば直る失敗でも続きが失われる行動を指示してしまう。
// 言い方の持ち主を1つにする。`send()` は `#resuming` を事前にも見るので、同じ「取り直している最中」を2箇所で書くと、片方だけが直る形になる。
export function resumeFailureDetail(
  managerId: string,
  outcome: Exclude<ResumeOutcome, 'resumed'>,
  // `leaseRefusal.kind` で言い方を変える: 読んだクローンはこの1行のとおりに行動するので、`ambiguous` に「待てば解ける」と言うと待ち続ける。
  // 「新しく起こし直さないこと」はどの `kind` でも必ず言う: 消すと二重実行の入口になる。
  leaseRefusal?: { detail: string; kind: LeaseRefusalKind },
): string {
  switch (outcome) {
    case 'held-by-lease': {
      const detail = leaseRefusal?.detail ?? '（根拠を取れなかった）';
      const resolution =
        leaseRefusal === undefined
          ? '根拠を取れなかった'
          : describeRefusalResolution(leaseRefusal.kind);
      return (
        `${managerId} はまだ前の器が握っている（貸し出しの関門）。**新しく起こし直さないこと** — ` +
        `起こし直すと同じ仕事が2本になる。${resolution}: ${detail}`
      );
    }
    case 'no-session':
      return `${managerId} は session_id を持っておらず、続きへ戻れない。新しく起こし直すこと。`;
    case 'unreadable':
      return (
        `${managerId} の続きに要る生ログを、いま読み出せなかった。` +
        '預かっていないのではなく、引きに行って失敗した（跡はデーモンの stderr にある）。' +
        '待てば直る種類の失敗なので、少し置いてから送り直すこと。' +
        '起こし直すと続きは失われるので、ここで起こし直さないこと。'
      );
    case 'busy':
      return `${managerId} は器の入れ替えから取り直している最中である。少し置いてから送り直すこと。`;
    case 'workspace-path-unknown':
      return (
        `${managerId} は cwd を記録しておらず、runner からも workspacePath を一度も聞けていない` +
        '（cwd の形が不正なのではない）。manager_send に cwd を渡す口は無いので、送り直しでは直らない。' +
        '新しく起こし直すと続きは失われる——起こし直す前に、この runner が workspacePath を' +
        '名乗れているか（別の runner への切り替えも含め）を確かめること。'
      );
    case 'stopped-meanwhile':
      // 「新しく起こし直すこと」を言わない: 戻れなかったのではなく戻る必要が無くなったので、起こし直すと止めた意思をこの応答が覆す。
      return (
        `${managerId} は resume している最中に止められた（止めた意思を優先し、` +
        '起こしかけた・起こしてしまったセッションは畳んだ）。台帳の status は ' +
        '`stopped` のまま——新しく起こし直さないこと。再開してよいかは、止めた側' +
        '（人間・クローン）の判断に従うこと。'
      );
    default: {
      const exhaustive: never = outcome;
      throw new Error(`未知の resume の結果: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// `resumeFailureDetail` を置き換えず、確かめた別の観測を前に付ける: resume の失敗理由とセッションが無いことは独立で、片方だけ読むと打つ手を間違える。
// `missing` が偽なら1文字も足さない: 確かめていないことを言わない。
// 「失われた」と読ませない: セッションが無い由来は「途中で失われた」と「完遂後に畳まれ終端イベントだけ届かなかった」の2つで、デーモンは台帳から区別できない。
// 言い切ると読んだクローンが完遂済みの仕事を委譲し直し、`gh pr create` のような取り返しのつかない操作が二度走りうる。
export function sendFailureDetail(
  managerId: string,
  resumeDetail: string,
  missing: boolean,
): string {
  if (!missing) return resumeDetail;
  return (
    `宛先の runner は ${managerId} のセッションを持っていない（そう答えた）。${resumeDetail} ` +
    '**この委譲が失われたという意味ではない** — 仕事が完遂した後にセッションが畳まれ、' +
    'その終端イベントだけが届かなかった回も、台帳からはこれと同じ形に見える' +
    '（デーモンにこの2つを区別する材料は無い）。**委譲し直す前に manager_report を見ること** — ' +
    '報告が空でも、生ログまで降りて「生成されたが配られていない」報告を拾う経路がある。'
  );
}

export type RestartCause = 'daemon' | 'runner' | 'relocated';

// 判定の持ち主を1つにする: `restartNudge` と `#notifyRestored` が同じ `job.workspace` から引くので、2箇所に書くと片方だけ直る。
export type WorkspaceAfterSwap =
  | { kind: 'kept'; path: string }
  | { kind: 'rebuild'; repository: string; ref: string }
  | {
      kind: 'unverified';
      path: string;
      /** 観測した作業ツリーがあるときだけ載る: 情報が無いなら新しい主張をしない。 */
      cloneHints?: readonly WorkspaceCloneHint[];
      observedAt?: string;
      incompleteNote?: string;
    }
  | { kind: 'unrecorded' };

// `runner-volume` を `kept` にしない: 以前に書かれた行が名乗っている値で確かめた結果ではなく、区別する手が無いので、「volume に在るので残っている」と読むと存在しない永続性の主張を復活させる。
// `observation` は `locator.kind === 'unknown'` のときだけ読む: clone の指示を出すのは `unknown` に限る。
export function workspaceAfterSwap(
  locator: WorkspaceLocator | undefined,
  observation?: LastUnpushedWorkObservation,
  rescue?: LastRescue,
): WorkspaceAfterSwap {
  if (locator === undefined) return { kind: 'unrecorded' };
  switch (locator.kind) {
    case 'shared-volume':
      return { kind: 'kept', path: locator.path };
    case 'git':
      return { kind: 'rebuild', repository: locator.repository, ref: locator.ref };
    case 'unknown': {
      const found = workspaceCloneHintsFrom(observation, rescue);
      return found === undefined
        ? { kind: 'unverified', path: locator.path }
        : {
            kind: 'unverified',
            path: locator.path,
            cloneHints: found.hints,
            ...(found.at === undefined ? {} : { observedAt: found.at }),
            ...(found.incompleteNote === undefined ? {} : { incompleteNote: found.incompleteNote }),
          };
    }
    case 'runner-volume':
      return { kind: 'unverified', path: locator.path };
    default: {
      const exhaustive: never = locator;
      throw new Error(`未知の workspace locator: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function observationBasisNote(observedAt: string | undefined): string {
  return observedAt === undefined
    ? '未 push の観測が無い（取れなかった）ので、件数や失われたものは分からない。'
    : `${observedAt} 時点の観測に基づく——これより後に作った枝は含まれない。`;
}

function workspaceAfterSwapClause(after: WorkspaceAfterSwap): string {
  switch (after.kind) {
    case 'unrecorded':
      return '作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。';
    case 'unverified':
      if (after.cloneHints === undefined) {
        return (
          `作業ディレクトリ（${after.path}）が残っているとは限らないので、` +
          '続きに入る前に手元の状態を確かめよ。'
        );
      }
      return (
        `作業ディレクトリ（${after.path}）が残っているとは限らない。` +
        observationBasisNote(after.observedAt) +
        (after.incompleteNote === undefined ? '' : `${after.incompleteNote} `) +
        (anyHintHasLossRisk(after.cloneHints)
          ? 'コミット済みで未 push のものも失われている可能性がある。'
          : '') +
        '見つかった作業ツリーごとに次のとおり進めよ:\n' +
        formatWorkspaceCloneHintLines(after.cloneHints, after.observedAt)
      );
    case 'kept':
      return (
        `作業ディレクトリ（${after.path}）は器を跨いで共有されているので、中身は残っている。` +
        'ただし書きかけで落ちた可能性はあるので、続きに入る前に手元の状態を確かめよ。'
      );
    case 'rebuild':
      return (
        `作業ディレクトリは器と一緒に失われている。${after.repository} の ${after.ref} を` +
        'clone し直してから、続きに入れ。コミットしていなかった変更は残っていないので、' +
        '必要なら書き直すこと。'
      );
  }
}

// `restartNudge` とは読み手が違う（クローン向け）ので文言は別に持ち、判定は同じ `workspaceAfterSwap` を通す。
// path は出さない: 呼び出し元が既に作業ディレクトリを出している。
export function cloneWorkspaceAfterSwapLine(after: WorkspaceAfterSwap): string {
  switch (after.kind) {
    case 'unrecorded':
      return (
        '器に永続化が無ければ、外へ保存していない作業は失われている。' +
        '同じ結果を期待せず、手元の状態から組み立て直させること。'
      );
    case 'unverified':
      if (after.cloneHints === undefined) {
        return (
          '器に永続化が無ければ、外へ保存していない作業は失われている。' +
          '同じ結果を期待せず、手元の状態から組み立て直させること。'
        );
      }
      return (
        observationBasisNote(after.observedAt) +
        (after.incompleteNote === undefined ? '' : `${after.incompleteNote} `) +
        (anyHintHasLossRisk(after.cloneHints)
          ? 'コミット済みで未 push のものも失われている可能性がある。'
          : '') +
        '外へ保存していない作業は失われている前提で、見つかった作業ツリーごとに' +
        '次のとおり組み立て直させること:\n' +
        formatWorkspaceCloneHintLines(after.cloneHints, after.observedAt, 'short')
      );
    case 'kept':
      return (
        '作業ディレクトリは器を跨いで共有されているので、外へ保存していない作業も残っている。' +
        'ただし書きかけで落ちた可能性はあるので、手元を確かめさせること。'
      );
    case 'rebuild':
      return (
        `作業ディレクトリは器と一緒に失われている。${after.repository} の ${after.ref} から` +
        '作り直させること。コミットしていなかった変更は残っていない。'
      );
  }
}

const RESCUE_STASH_NUDGE_PATHS = 10;

/** 預かりの元の場所（担当の作業場からの `<worktree>/<path>`。作業場の直下の作業ツリーは `path` だけ）。 */
export function rescueStashLocation(entry: Pick<RescueStashEntry, 'worktree' | 'path'>): string {
  return entry.worktree === '.' || entry.worktree === ''
    ? entry.path
    : `${entry.worktree}/${entry.path}`;
}

/**
 * 器が入れ替わった後の再開の文・後継の最初の依頼文へ足す段落（#4863 案A その2）。預かりが空なら `undefined`（1文字も足さない）。
 * `restorable` は、この担当が走る器が `rescue_restore` を名乗っているか: 名乗らない器へ呼べない道具を指さない。
 */
export function rescueStashClause(
  stash: readonly RescueStashEntry[] | undefined,
  options: { restorable: boolean; from?: string },
): string | undefined {
  if (stash === undefined || stash.length === 0) return undefined;
  const shown = stash.slice(0, RESCUE_STASH_NUDGE_PATHS).map(rescueStashLocation);
  const rest = stash.length - shown.length;
  const list = `先頭 ${String(shown.length)} 件: ${shown.join(', ')}${rest > 0 ? ` ほか ${String(rest)} 件` : ''}`;
  const subject =
    options.from === undefined
      ? '器が入れ替わる前に預かった未追跡のファイルが'
      : `前任（${options.from}）の器から、デーモンが預かった未追跡のファイルが`;
  const call =
    options.from === undefined
      ? '`rescue_restore` を呼べば取り戻せる'
      : `\`rescue_restore({ from: '${options.from}' })\` で取り戻せる`;
  return options.restorable
    ? `${subject} ${String(stash.length)} 件ある（${list}）。作業場に無ければ、${call}` +
        '（預かりが添付として次の入力で届く。元の場所に別の中身のファイルが在るなら、上書きする前に確かめること）。'
    : `${subject} ${String(stash.length)} 件ある（${list}）。この器には \`rescue_restore\` の道具が無いので、` +
        'ユーザーに取り戻しを頼むこと（manager_report で預かりの件数が分かる）。';
}

// `restartNudge` をそのまま呼ばない: 末尾の「続きを進めよ」が、直後に続く人間・クローンの指示と二重の指図になる。
// `status` を見ない（resume 経路すべてに同じものを当て、`done` だけ特別扱いしない）ので、`waiting_human` の枝は持ち込まない。
// 判定は `workspaceAfterSwap` に委ねる: 別の判定を書くと片方だけ直る。
export function runnerSwapNudge(
  locator: WorkspaceLocator | undefined,
  observation?: LastUnpushedWorkObservation,
  rescue?: LastRescue,
  rescueStashNote?: string,
): string {
  return (
    '[system] この委譲を最後に走らせていた器は、もう居ない（別の器がこの宛先に応えている）。' +
    workspaceAfterSwapClause(workspaceAfterSwap(locator, observation, rescue)) +
    (rescueStashNote === undefined ? '' : `\n${rescueStashNote}`)
  );
}

// 作業者の落ちの印から起こす専用の文（#5030）。鍵の値は載せない（世代の数だけ）
export function workerLimitNudge(generation: number | undefined): string {
  return (
    '[system] 作業者が上限で落ちた鍵は回った' +
    (generation === undefined ? '' : `（いまの現役は世代 ${String(generation)}）`) +
    '。この会話はそのまま続いている（最初からやり直さないこと）。' +
    '作業者を立て直して、止まっていた続きを進めてよい。'
  );
}

// `restartNudge` をそのまま呼ばない: `waiting_human` の枝が「確認は器と一緒に失われている」と言うが、ここでは会話も待ちも失われていず嘘になる。
// 「最初からやり直すな」を明示する: 枠で死んだのはそのターンだけで、書かないと `lastFailure` が立っているぶんやり直しから入り、トークンを二重に使う。
// 作業者の一文を一般の文で足す（#4871）: 枠で落ちた作業者は鍵が戻っても自動では戻らず、デーモンは作業者の一覧を持たないので名指しできないため
export function usageRotationNudge(): string {
  return (
    '[system] 認証トークンが枠で止まっていたが、通る鍵に戻った。' +
    'この会話はそのまま続いている（最初からやり直さないこと）。' +
    '枠で落ちたターンだけをやり直し、中断していた作業の続きを進めよ。' +
    '作業者（サブエージェント）が枠で止まっていたなら、鍵が戻っても自動では戻らない。' +
    'SendMessage でその作業者に続きを頼み直すこと（新しく立て直さない）。' +
    'まず作業ツリーと枝の状態を測り、未 push のコミットがあれば先に push してから、止まった所から続けること。'
  );
}

export function restartNudge(
  status: JobStatus,
  cause: RestartCause,
  locator: WorkspaceLocator | undefined,
  observation?: LastUnpushedWorkObservation,
  rescue?: LastRescue,
  rescueStashNote?: string,
): string {
  // 預かりの段落は器が入れ替わった回だけ（デーモンの再起動では器の中は無事）
  const stashPart =
    cause === 'daemon' || rescueStashNote === undefined ? '' : `\n${rescueStashNote}\n`;
  // runner が入れ替わったことを「デーモンが再起動した」と伝えない: 手元が残っている前提で続きを書き始めると、消えた作業を書いたつもりで進む。
  const head =
    cause === 'runner'
      ? '[system] runner の器が作り直された。' +
        workspaceAfterSwapClause(workspaceAfterSwap(locator, observation, rescue)) +
        stashPart
      : cause === 'relocated'
        ? '[system] 走らせていた runner が黙ったので、別の器で続きを開いた。' +
          workspaceAfterSwapClause(workspaceAfterSwap(locator, observation, rescue)) +
          stashPart
        : '[system] デーモンが再起動した。';
  if (status === 'waiting_human') {
    return (
      `${head}あなたが待っていた確認は器と一緒に失われている。` +
      'まだ必要なら聞き直し、不要なら中断していた作業の続きを進めよ。'
    );
  }
  return `${head}中断していた作業の続きを進めよ。`;
}

// `restartNudge` に混ぜず別に持つ: あちらは resume の前に組み立てるが、runner が実際に使った cwd は resume が返るまで分からない。
// `undefined` は「今回は足さない」で「未確認」ではない: 倒れていない回と古い runner の回を区別しない。
export function cwdSwapNoticeClause(record: ManagerRecord): string | undefined {
  const notice = record.cwdSwapNotice;
  if (notice === undefined) return undefined;
  return (
    `[system] 元の cwd（${notice.requested}）はこの器に無かったので、` +
    `${notice.actual} で開いた。`
  );
}

// `[計器]`（`EXCHANGE_KIND_GAUGE_PREFIX`）を含めない: `exchange-kind-coverage.test.ts` の静的検査は呼び出し元の `text:` の式に接頭辞定数が直接在ることを見るので、関数の中に隠すと見えなくなる。
// 経過が読めない・負のときは経過を捏造せず省く（取れない軸に0の行を作らない）。
export function describeVanishedRunnerBacklogLine(
  runnerId: string,
  backlog: { count: number; oldestStartedAt: string },
  now: number,
): string {
  const parsed = Date.parse(backlog.oldestStartedAt);
  const elapsedMs = Number.isNaN(parsed) ? undefined : now - parsed;
  const elapsedText =
    elapsedMs === undefined || elapsedMs < 0
      ? ''
      : `（最古の委譲は${formatDurationMinutes(elapsedMs)}経過）`;
  return (
    `[${runnerId}] 名簿から entry ごと消えている器の上に、` +
    `running のまま残っている委譲が ${String(backlog.count)} 本ある${elapsedText}。`
  );
}

/** 断る文面に載せる「抱えている古い鍵がいまどうか」。`ready` は届ける側へ回るので、ここへ来るのはそれ以外だけである。 */
export function describeHeldTokenState(
  availability: 'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined,
): string {
  switch (availability) {
    case 'ready':
      return 'いま使える';
    case 'cooling':
      return 'いま冷却中（枠に当たって休ませている）な';
    case 'disabled':
      return '止めてある';
    case 'invalidated':
      return '無効になっている';
    case undefined:
      return 'いま使えるか読めなかった';
  }
}

export function describeStoppedReportFiles(files: ManagerReportFiles | undefined): string {
  if (files === undefined) return '';
  const lines: string[] = [];
  if (files.attachments.length > 0) {
    lines.push(
      `（添えられていた成果物 ${String(files.attachments.length)} 件を置き場へ入れた: ` +
        `${files.attachments.map((ref) => `${ref.name}（${ref.id}）`).join('、')}。attachment_fetch で読める）`,
    );
  }
  if (files.rejected.length > 0) {
    lines.push(
      `（受け取れなかった成果物: ${files.rejected.map((item) => `${item.name}（${item.reason}）`).join('、')}）`,
    );
  }
  return lines.length === 0 ? '' : `\n\n${lines.join('\n')}`;
}

export function normalizeRescuePath(value: string): string {
  return value.trim().replace(/^(\.\/)+/, '');
}

/** `rescue_restore` の `paths` に合う書き方: `<worktree>/<path>` か `path` だけ。 */
export function rescueStashKeys(entry: Pick<RescueStashEntry, 'worktree' | 'path'>): string[] {
  return [rescueStashLocation(entry), entry.path];
}

/** 報告の全文（途中の発言を含む）。旧 runner は `fullText` を送らず、`text` が全文。 */
export function reportFullTextOf(event: { text: string; fullText?: string }): string {
  return event.fullText ?? event.text;
}

/**
 * クローンの受信箱へ配る報告の本文。途中の発言があった回は、最後の発言（結論と質問）に全文の在りかを1行添える。
 * 添える行を省かない: 「途中があった」こと自体が見えないと、クローンは結論だけで足りない回に全文を引く契機を持てないため。
 */
export function reportDeliveryTextOf(event: {
  managerId: string;
  text: string;
  fullText?: string;
}): string {
  if (event.fullText === undefined) return event.text;
  return (
    `${event.text}\n\n` +
    `（途中の発言を含む全文 ${String(event.fullText.length)} 字は manager_report managerId=${event.managerId} で読める。` +
    'これはターンの最後の発言だけである）'
  );
}

// 停止済みの担当の報告に添えられた成果物を、日誌の行の末尾で名乗る（#4675）。中身は行の `attachments` に結び付いている
export interface DroppedReportFiles {
  readonly text: string;
  readonly attachments: { attachments?: ManagerReportFiles['attachments'] };
}

export const NO_DROPPED_FILES: DroppedReportFiles = { text: '', attachments: {} };

/** `依頼:` を載せず、直近の報告も全文ではなく `excerptLine` の短い抜粋だけにする: 依頼文はクローン自身が書いたもので、中身は `manager_report` でいつでも読める。 */
export function notifyExcerptLines(job: Pick<Job, 'id' | 'lastReport'>): string[] {
  return [
    job.lastReport === undefined
      ? ''
      : `直近の報告（抜粋）: ${excerptLine(job.lastReport, NOTIFY_REPORT_EXCERPT)}`,
    `続きを読むなら manager_report managerId=${job.id}（直近の報告の全文） / ` +
      `manager_report managerId=${job.id} part=request（依頼文）。`,
  ];
}

/**
 * 戻せなかった委譲の知らせ。`journal` は日誌の行（種別の接頭辞と `[id]` は呼ぶ側が前に付ける）、`notice` は合流窓へ積む本文。
 * 黙って `running` のまま置かない: 再試行しても同じ答えが返る失敗なので、人間とクローンに見えるようにするのが唯一の出口。
 */
export function unresumableNotice(
  job: Pick<Job, 'id' | 'cwd' | 'lastReport'>,
  error: unknown,
  cause: 'runner' | 'session',
): { journal: string; notice: string } {
  const journal =
    '（戻せなかった）' +
    (cause === 'session'
      ? '前のセッションから戻せなかった（SDK に会話が残っていない）。'
      : 'runner の器が作り直されたが、前のセッションから戻せなかった。') +
    ` 理由: ${reasonOf(error)}`;
  const notice = [
    cause === 'session'
      ? 'この委譲を前のセッションから戻せなかった（SDK に会話が残っていない）。' +
        '生ログも預かっていないので、続きの材料が無い。'
      : 'runner の器が作り直されたが、この委譲を前のセッションから戻せなかった。',
    `理由: ${reasonOf(error)}`,
    `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
    ...notifyExcerptLines(job),
    '',
    // 「成果が無い」と言わない: 観測したのは戻れなかったことだけで、PR もブランチも見に行かない（落ちる直前にマージまで済ませていた、が実際に起きている）。
    '同じ命令を投げ直しても同じ答えが返る種類の失敗なので、自動では再試行しない。' +
      'ただし**この失敗は「仕事が終わっていない」ことの証拠ではない** — ' +
      '落ちる前に成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
      '`manager_start` で起こし直す前に、そこを確かめること。',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { journal, notice };
}

/** 生ログから作り直して続けた回の知らせの本文。日誌と合流窓へ同じ文字列を渡すため、組み立てはここ1箇所に置く。 */
export function resumeFallbackBody(
  job: Pick<Job, 'id' | 'lastReport'>,
  sessionId: string,
  reason: string,
): string {
  return [
    `前のセッション（${sessionId}）へは戻れなかったので、預かってあった生ログから` +
      '新しいセッションを起こして続けさせた。',
    `理由: ${reason}`,
    ...notifyExcerptLines(job),
    '',
    'マネージャーが持っているのは記録から読み取れる範囲だけである。' +
      '前のセッションで口頭で足した細かい指示は効いていないと考えて、' +
      '必要なら `manager_send` で言い直すこと。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
