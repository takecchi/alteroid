/**
 * 器が入れ替わった後の再開の案内（`manager.ts` の `restartNudge` / `runnerSwapNudge` /
 * `#notifyRestored`）が、作業ツリーごとに何を言うかの持ち主（Issue #2751）。
 *
 * ## なぜ分けたか
 *
 * 以前は観測の各作業ツリーを `{ 枝名, host, path }` だけに畳み、全部同じ
 * 「clone し直せ」で描いていた。観測は `unpushedCommitCount` /
 * `uncommittedChangeCount` を持っていたのに捨てており、一度も push していない枝にも
 * 「clone し直せ」と言った（origin に無い枝なので clone は失敗する）。
 * 退避 ref（`Job.lastRescue`。Issue #1266）が入ってからは、「取り戻す手順」も
 * 言えるし、言わなければならない。
 *
 * ## 約束
 *
 * - 未 push のコミットがある（または確かめられなかった）のに退避 ref が無いとき、
 *   **「clone し直せ」と言わない。** `git ls-remote origin <枝>` で在るかを確かめさせ、
 *   無ければ「失われた（origin に無い）」と言う。
 * - 件数 0 で退避も要らない（観測が件数を言わない旧い行も含む）ときだけ、
 *   従来の文言と1バイトも違わない。
 * - 退避 commit は「最後の退避の時点の HEAD + 追跡済みの未コミットの変更」であり、
 *   それより後の変更と未追跡のファイルは含まない。
 * - 一覧が溢れないよう、文字数の予算を持つ（`.claude/skills/listing-and-detail/`）。
 *   危ない作業ツリーを先に出し、溢れたぶんは件数と続きの取り方を言う。
 *
 * 表現は `tools.ts` の `describeRescue` と揃える（理由の言い方は
 * {@link RESCUE_NOT_PUSHED_TEXT} を共有する）。
 */
import { excerptLine } from './excerpt.js';
import type {
  LastRescue,
  LastUnpushedWorkObservation,
  RescueNotPushedReason,
  RescueWorktree,
} from './schema.js';
import { describeUnpushedWorkObservationIncompleteness } from './unpushed-work-observation-format.js';

/** 退避されなかった理由の言い方（`rescueNotPushedReasonSchema`）。`describeRescue` と共有。 */
export const RESCUE_NOT_PUSHED_TEXT: Record<RescueNotPushedReason, string> = {
  'nothing-tracked': '追跡済みの変更・未 push のコミットが無く送るものが無かった',
  'secret-like': '鍵らしい文字列のため送らなかった',
  'too-large': '差分が判定の上限を超えたため送らなかった',
  'no-credential': '資格が無いので退避できなかった',
  'no-remote': 'origin が無いので退避できなかった',
  'push-failed': 'push に失敗した',
  error: '退避 commit を作れなかった',
  timeout: '期限で打ち切られた（次の周期でまた試す）',
};

/** 件数。`undefined`（観測がその欄を言わない旧い行）は新しい主張の材料にしない。 */
export type HintCount =
  | { readonly kind: 'known'; readonly n: number }
  | { readonly kind: 'unknown'; readonly reason: string }
  | undefined;

export interface WorkspaceCloneHint {
  /** `rescue-only` — 観測に無く、退避の台帳（`lastRescue`）にだけ在る作業ツリー。 */
  readonly kind: 'clone' | 'unresolved' | 'rescue-only';
  readonly relativePath: string;
  readonly host?: string;
  readonly path?: string;
  readonly branch?: string;
  /** `kind: 'unresolved'` の理由。 */
  readonly reason?: string;
  readonly unpushed: HintCount;
  readonly uncommitted: HintCount;
  /** 同じ作業ツリー（`relativePath` が同じ）の退避の台帳。 */
  readonly rescue?: RescueWorktree;
}

function countOf(value: number | undefined, unknown: string | undefined): HintCount {
  if (unknown !== undefined) return { kind: 'unknown', reason: unknown };
  return value === undefined ? undefined : { kind: 'known', n: value };
}

/**
 * `job.lastUnpushedWorkObservation`（と `job.lastRescue`）から作業ツリーごとの
 * 一覧を作る。観測が無い・`unavailable`・作業ツリー0本なら `undefined`
 * ——観測が無いことを新しい主張の材料にしない。
 */
export function workspaceCloneHintsFrom(
  observation: LastUnpushedWorkObservation | undefined,
  rescue?: LastRescue,
):
  | {
      /** 観測した時刻。観測が使えない（無い・unavailable・空）ときは載らない。 */
      readonly at?: string;
      readonly hints: readonly WorkspaceCloneHint[];
      readonly incompleteNote?: string;
    }
  | undefined {
  const observedTrees =
    observation !== undefined && observation.kind === 'observed' ? observation.worktrees : [];
  // **「退避 ref が在ること」を材料にする**（Issue #2751）。観測が無くても、観測に無い
  // 作業ツリーでも、`pushed` があれば取り戻す手順は言える（件数・失われたものは言わない）。
  const rescueOnly: WorkspaceCloneHint[] = (rescue?.worktrees ?? [])
    .filter(
      (tree) =>
        liveRescueRef(tree) !== undefined &&
        !observedTrees.some((worktree) => worktree.relativePath === tree.relativePath),
    )
    .map((tree) => ({
      kind: 'rescue-only',
      relativePath: tree.relativePath,
      unpushed: undefined,
      uncommitted: undefined,
      rescue: tree,
    }));
  if (observation === undefined || observation.kind !== 'observed' || observedTrees.length === 0) {
    return rescueOnly.length === 0
      ? undefined
      : {
          // 観測が `observed`（作業ツリー0本）なら、その時刻は言える。
          ...(observation?.kind === 'observed' ? { at: observation.at } : {}),
          hints: rescueOnly,
        };
  }
  const hints: WorkspaceCloneHint[] = observation.worktrees.map((worktree) => {
    const rescued = rescue?.worktrees.find((tree) => tree.relativePath === worktree.relativePath);
    const common = {
      relativePath: worktree.relativePath,
      unpushed: countOf(worktree.unpushedCommitCount, worktree.unpushedCommitCountUnknown),
      uncommitted: countOf(worktree.uncommittedChangeCount, worktree.uncommittedChangeCountUnknown),
      ...(rescued === undefined ? {} : { rescue: rescued }),
    };
    if (worktree.branch !== null && worktree.remoteOrigin !== undefined) {
      return {
        kind: 'clone',
        ...common,
        host: worktree.remoteOrigin.host,
        path: worktree.remoteOrigin.path,
        branch: worktree.branch,
      };
    }
    const reason =
      worktree.branch === null
        ? '枝名を確かめられなかった（detached HEAD、または取得時に失敗した）'
        : 'origin remote の URL を確認できなかった（未設定、または解釈できない形式）';
    return { kind: 'unresolved', ...common, reason };
  });
  const incompleteNote = describeUnpushedWorkObservationIncompleteness(observation);
  return {
    at: observation.at,
    hints: [...hints, ...rescueOnly],
    ...(incompleteNote === null ? {} : { incompleteNote }),
  };
}

/** 未 push のコミットが在る・確かめられなかった（＝コミット済みのものを失った可能性）。 */
function hasLossRisk(hint: WorkspaceCloneHint): boolean {
  // 観測が無いので件数は分からない（コミット済みで未 push のものも確かめられない）。
  if (hint.kind === 'rescue-only') return true;
  return (
    hint.unpushed?.kind === 'unknown' || (hint.unpushed?.kind === 'known' && hint.unpushed.n > 0)
  );
}

/** 一覧のどれかが {@link hasLossRisk}。見出しに「コミット済みでも失われうる」を足すかの判定。 */
export function anyHintHasLossRisk(hints: readonly WorkspaceCloneHint[]): boolean {
  return hints.some(hasLossRisk);
}

function countText(hint: WorkspaceCloneHint): string {
  const parts: string[] = [];
  const { unpushed, uncommitted } = hint;
  if (unpushed?.kind === 'known' && unpushed.n > 0) {
    parts.push(`未 push のコミットが ${unpushed.n} 件あった`);
  } else if (unpushed?.kind === 'unknown') {
    parts.push(`未 push のコミット数は確かめられなかった（${unpushed.reason}）`);
  }
  if (uncommitted?.kind === 'known' && uncommitted.n > 0) {
    parts.push(`未コミットの変更が ${uncommitted.n} 件あった`);
  } else if (uncommitted?.kind === 'unknown') {
    parts.push(`未コミットの変更の有無は確かめられなかった（${uncommitted.reason}）`);
  }
  return parts.join('・');
}

/**
 * 「在る退避 ref」を返す**唯一の述語**。`tree.pushed` を直接読まず、ここを通すこと。
 * 後で `pushed.removal`（削除済みの印。#2841）が入ったら、ここだけを直せばよい。
 *
 * ref と commit は**コマンドとして案内に埋め込む**ので、形を確かめる。外れたら
 * `invalid`（手順は出さない）。値そのものは案内へ出さない（台帳の中身を信用しない）。
 */
type LiveRescue =
  | { readonly kind: 'ok'; readonly ref: string; readonly commit: string; readonly at: string }
  | { readonly kind: 'invalid'; readonly at: string };

const RESCUE_REF_PATTERN = /^refs\/alteroid-rescue\/[A-Za-z0-9_./-]+$/;
const RESCUE_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

function liveRescueRef(tree: RescueWorktree | undefined): LiveRescue | undefined {
  const pushed = tree?.pushed;
  if (pushed === undefined) return undefined;
  return RESCUE_REF_PATTERN.test(pushed.ref) && RESCUE_COMMIT_PATTERN.test(pushed.commit)
    ? { kind: 'ok', ref: pushed.ref, commit: pushed.commit, at: pushed.at }
    : { kind: 'invalid', at: pushed.at };
}

/** シェルの単一引用符でクオートする（`'` は `'\''`）。案内に埋め込む値は必ずこれを通す。 */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 取り戻すコマンド。`short` は1行だけ。 */
function recoveryCommand(live: LiveRescue & { kind: 'ok' }): string {
  return `git fetch origin ${shq(live.ref)} && git switch -c <新しい枝名> FETCH_HEAD`;
}

function rescueHeadline(live: LiveRescue): string {
  return live.kind === 'ok'
    ? `退避 ref ${live.ref}（${live.commit.slice(0, 8)}, ${live.at}）が最後の退避。`
    : `退避 ref の記録の形が不正（${live.at} に退避したことになっている）なので、手順は出さない。台帳（クローンの manager_list の「退避 ref」）を確かめよ。`;
}

function recoverySteps(live: LiveRescue): string {
  if (live.kind !== 'ok') return '';
  return (
    `取り戻す手順: ${recoveryCommand(live)}（または git checkout ${live.commit}）。` +
    'その ref が無ければ、退避は失われている。' +
    '退避 commit は最後の退避の時点の HEAD + 追跡済みの未コミットの変更で、' +
    'それより後の変更と未追跡のファイルは含まない。'
  );
}

/**
 * 退避が観測より古く、かつ「その間の変更」が在りうるとき。退避は周期（既定5分）なので
 * 古いこと自体はほぼ常に起きる——観測の未コミットも未 push も 0 と確かめられているなら言わない。
 */
function mayHaveChangedSinceRescue(
  hint: WorkspaceCloneHint,
  observedAt: string | undefined,
): boolean {
  const live = liveRescueRef(hint.rescue);
  if (live === undefined || observedAt === undefined) return false;
  const pushedAt = Date.parse(live.at);
  const seenAt = Date.parse(observedAt);
  if (!(Number.isFinite(pushedAt) && Number.isFinite(seenAt) && pushedAt < seenAt)) return false;
  const nothing = (count: HintCount) => count?.kind === 'known' && count.n === 0;
  return !(nothing(hint.uncommitted) && nothing(hint.unpushed));
}

/** 退避されなかったもの。`describeRescue` と同じ見せ方（名前は5件まで、溢れは件数）。 */
function unsavedText(tree: RescueWorktree): string | null {
  const unsaved: string[] = [];
  if (tree.untracked !== undefined) {
    const shownPaths = tree.untracked.paths.slice(0, 5);
    const rest = tree.untracked.count - shownPaths.length;
    const shown = shownPaths.map((p) => excerptLine(p, 80)).join(', ');
    unsaved.push(
      `未追跡 ${tree.untracked.count} 件（${shown}${rest > 0 ? ` ほか ${rest} 件` : ''}）`,
    );
  }
  if (tree.submoduleCount !== undefined) {
    unsaved.push(`submodule ${tree.submoduleCount} 本（中の変更は退避されない）`);
  }
  return unsaved.length === 0
    ? null
    : `退避されなかったもの（失われた可能性がある）: ${unsaved.join('、')}。`;
}

function notPushedText(tree: RescueWorktree): string | null {
  const notPushed = tree.notPushed;
  if (notPushed === undefined || notPushed.reason === 'nothing-tracked') return null;
  const extra =
    notPushed.reason === 'push-failed' && notPushed.failureKind !== undefined
      ? `（${notPushed.failureKind}）`
      : notPushed.reason === 'secret-like' && (notPushed.files?.length ?? 0) > 0
        ? `（${(notPushed.files ?? []).join(', ')}）`
        : '';
  return `直近の退避: ${RESCUE_NOT_PUSHED_TEXT[notPushed.reason]}${extra}。`;
}

const FULL_LINE_BUDGET = 4000;
const SHORT_LINE_BUDGET = 1500;

/** 観測に無い作業ツリー。退避 ref の手順と、退避されなかったものだけ。件数は断定しない。 */
function rescueOnlyText(hint: WorkspaceCloneHint, short = false): string {
  const tree = hint.rescue;
  const live = liveRescueRef(tree);
  if (tree === undefined || live === undefined) return '';
  const parts: string[] = [];
  if (short) {
    parts.push(
      live.kind === 'ok'
        ? `退避 ref あり（${live.at}, ${live.commit.slice(0, 8)}）。取り戻す: ${recoveryCommand(live)}。`
        : '退避 ref の記録の形が不正なので手順は出さない。',
    );
  } else {
    parts.push(rescueHeadline(live) + recoverySteps(live));
  }
  parts.push('退避の時刻より後の変更は確かめられない（この作業ツリーの未 push の観測が無い）。');
  const unsaved = unsavedText(tree);
  if (unsaved !== null) parts.push(unsaved);
  if (!short) {
    const notPushed = notPushedText(tree);
    if (notPushed !== null) parts.push(notPushed);
  }
  return parts.join('');
}

/** マネージャー向け。取り戻す手順まで書く。 */
function fullLine(hint: WorkspaceCloneHint, observedAt: string | undefined): string {
  const head = `- ${hint.relativePath}: `;
  if (hint.kind === 'rescue-only') return head + rescueOnlyText(hint);
  const counts = countText(hint);
  const risk = hasLossRisk(hint);
  const live = liveRescueRef(hint.rescue);
  const clone = hint.kind === 'clone' ? `${hint.host}/${hint.path} の ${hint.branch}` : undefined;
  const sentences: string[] = [];
  if (counts !== '') sentences.push(`${counts}。`);
  if (live !== undefined) {
    sentences.push(rescueHeadline(live) + recoverySteps(live));
    if (mayHaveChangedSinceRescue(hint, observedAt)) {
      sentences.push(
        `この退避（${live.at}）は観測（${observedAt}）より古い——その間の変更は失われた可能性がある。`,
      );
    }
    if (clone !== undefined) {
      sentences.push(`origin に枝が在れば、そこまでのコミットは ${clone} を clone し直せる。`);
    }
  } else if (risk) {
    const lost =
      hint.unpushed?.kind === 'known'
        ? `未 push だった ${hint.unpushed.n} コミットは失われた（origin に無い）`
        : '未 push だったコミットは失われた（origin に無い。件数は不明）';
    if (clone !== undefined) {
      sentences.push(
        '退避 ref は無い。clone し直す前に ' +
          `git ls-remote origin -- ${shq(`refs/heads/${hint.branch}`)} で枝が origin に在るか確かめよ` +
          '（何も出なければ無い）。' +
          `在れば ${clone} を clone し直せるが、origin の枝に入っていないコミットは戻らない。` +
          `無ければ${lost}。`,
      );
    } else {
      sentences.push(
        `退避 ref は無い。確かめよ（${hint.reason}）。origin に在るか確かめて、無ければ${lost}。`,
      );
    }
  } else if (clone !== undefined) {
    sentences.push(`${clone} を clone し直せ。`);
    if (hint.uncommitted?.kind === 'known' && hint.uncommitted.n > 0) {
      sentences.push('未コミットの変更は失われている。');
    }
  } else {
    sentences.push(`確かめよ（${hint.reason}）。`);
  }
  const unsaved = hint.rescue === undefined ? null : unsavedText(hint.rescue);
  if (unsaved !== null) sentences.push(unsaved);
  const notPushed = hint.rescue === undefined ? null : notPushedText(hint.rescue);
  if (notPushed !== null) sentences.push(notPushed);
  return head + sentences.join('');
}

/** クローン向け。件数と、取り戻す手順の1行まで。 */
function shortLine(hint: WorkspaceCloneHint, observedAt: string | undefined): string {
  if (hint.kind === 'rescue-only') return `- ${hint.relativePath}: ${rescueOnlyText(hint, true)}`;
  const risk = hasLossRisk(hint);
  const live = liveRescueRef(hint.rescue);
  const unsaved = hint.rescue === undefined ? null : unsavedText(hint.rescue);
  const uncommittedKnown = hint.uncommitted?.kind === 'known' && hint.uncommitted.n > 0;
  if (!risk && live === undefined && unsaved === null && !uncommittedKnown) {
    return hint.kind === 'clone'
      ? `- ${hint.relativePath}: ${hint.host}/${hint.path} の ${hint.branch} を clone し直せ。`
      : `- ${hint.relativePath}: 確かめよ（${hint.reason}）。`;
  }
  const sentences: string[] = [];
  const counts = countText(hint);
  if (counts !== '') sentences.push(`${counts}。`);
  if (live !== undefined) {
    sentences.push(
      live.kind === 'ok'
        ? `退避 ref あり（${live.at}, ${live.commit.slice(0, 8)}）。取り戻す: ${recoveryCommand(live)}。`
        : '退避 ref の記録の形が不正なので手順は出さない。',
    );
    if (mayHaveChangedSinceRescue(hint, observedAt)) {
      sentences.push('ただし観測より古く、その間の変更は失われた可能性がある。');
    }
  } else if (risk) {
    sentences.push('退避 ref は無い（origin に無ければ失われた）。');
  } else if (hint.kind === 'clone') {
    sentences.push(`${hint.host}/${hint.path} の ${hint.branch} を clone し直せ。`);
  }
  if (unsaved !== null) sentences.push(unsaved);
  return `- ${hint.relativePath}: ${sentences.join('')}`;
}

/**
 * 予算で切るときの優先度（小さいほど先）。0 未 push の可能性（Unknown・>0・rescue-only）、
 * 1 退避されなかったもの（未追跡・submodule・送らなかった理由）、2 未コミット、3 その他。
 */
function priorityOf(hint: WorkspaceCloneHint): number {
  if (hasLossRisk(hint)) return 0;
  if (
    hint.rescue !== undefined &&
    (unsavedText(hint.rescue) !== null || notPushedText(hint.rescue) !== null)
  ) {
    return 1;
  }
  if (hint.uncommitted?.kind === 'unknown') return 2;
  if (hint.uncommitted?.kind === 'known' && hint.uncommitted.n > 0) return 2;
  return 3;
}

/**
 * 作業ツリーごとに1行へ描く。{@link priorityOf} の順に出し、予算を超えたぶんは
 * 件数と続きの取り方を言う。**省略した作業ツリーの全部は、クローンの `manager_list`
 * （未push観測・退避 ref）に在る**——マネージャーは `manager_list` を持たないので、
 * クローンへ聞く形で書く。
 */
export function formatWorkspaceCloneHintLines(
  hints: readonly WorkspaceCloneHint[],
  observedAt: string | undefined,
  mode: 'full' | 'short' = 'full',
): string {
  const budget = mode === 'full' ? FULL_LINE_BUDGET : SHORT_LINE_BUDGET;
  const ordered = hints
    .map((hint, index) => ({ hint, index, priority: priorityOf(hint) }))
    .sort((x, y) => x.priority - y.priority || x.index - y.index)
    .map((entry) => entry.hint);
  const lines: string[] = [];
  let used = 0;
  for (const hint of ordered) {
    const line = mode === 'full' ? fullLine(hint, observedAt) : shortLine(hint, observedAt);
    if (lines.length > 0 && used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const rest = ordered.length - lines.length;
  if (rest > 0) {
    lines.push(
      `…ほか ${rest} 本は省略（全 ${ordered.length} 本。全部はクローンの manager_list の「未push観測」「退避 ref」にある）。`,
    );
  }
  return lines.join('\n');
}
