// 実行時の依存を持たない: ブラウザ（apps/web）が `@alteroid/core/revision` として読む。
// 焼き込みと zod を読む `revision.ts` から言い方を配ると、初期チャンクへ全部入る。
export type RevisionSource = 'build' | 'workspace' | 'env' | 'platform';

/**
 * `source` は `commit`/`short` と独立に `null` になりうる（`baked.revision` が非空で `baked.source` が
 * 未知のとき）。「commit が在れば source も在る」と読んで doc を強めると、実装のほうを直しに行く人が出る。
 */
export interface BuildRevision {
  /** コミット sha は公開リポジトリを指すので伏せない。非公開になったらこの判断は成り立たない。 */
  commit: string | null;
  short: string | null;
  source: RevisionSource | null;
}

export type RunnerRevisionReport =
  | { status: 'known'; commit: string; short: string; source: RevisionSource }
  | { status: 'unknown' };

const SOURCE_LABEL: Record<RevisionSource, string> = {
  build: 'イメージに焼き込み済み',
  workspace: 'ビルド時の作業ツリーから取得',
  env: '実行時に ALTEROID_BUILD_REV で指定',
  platform: 'Railway が実行時に注入',
};

export function revisionSourceLabel(source: RevisionSource): string {
  return SOURCE_LABEL[source];
}

// 短縮とフル sha を両方出す: 短縮だけだと `gh api .../compare` へ貼れず、フルだけだと目で突き合わせられない。
function describeKnownRevision(commit: string, short: string, source: RevisionSource): string {
  return `${short}（${SOURCE_LABEL[source]}、フル ${commit}）`;
}

export function describeBuildRevision(rev: BuildRevision): string {
  if (rev.commit === null || rev.short === null || rev.source === null) {
    return 'リビジョン: 不明（焼き込み・実行時の環境変数のどちらからも取れなかった）';
  }
  return `リビジョン: ${describeKnownRevision(rev.commit, rev.short, rev.source)}`;
}

/**
 * 版を出す口はすべてこれを通す: 口ごとに文言を作ると「不明」と「未確認」の区別が片方でだけ消える。
 * 引数を `RunnerRevisionStatus` で受けない: `runner-protocol.ts` がこのファイルを import しており循環になる。
 */
export function describeRevisionStatus(
  status: RunnerRevisionReport | { status: 'unheard' },
): string {
  switch (status.status) {
    case 'known':
      return describeKnownRevision(status.commit, status.short, status.source);
    // `unknown` と `unheard` を同じ言葉にしない: 疑う先（器の設定／登録とネットワーク）が違う。
    case 'unknown':
      return '不明（応答は返ったが、その器が自分の版を知らない）';
    case 'unheard':
      return '未確認（名乗りをまだ一度も聞けていない）';
  }
}

export interface BuildTime {
  builtAt: string | null;
}

function describeElapsed(diffMs: number): string {
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `約${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `約${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `約${days}日前`;
}

/**
 * 壊れた値をここでも自前で検査する: `resolveBuildTime` を経由しない呼び出しがありうる。
 * 「これより前のものは全部入っている」とは言わない: 反映から焼くまでの隙間があり逆方向の保証はできない。
 */
export function describeBuildAge(builtAt: string | null, now: Date = new Date()): string {
  if (builtAt === null) {
    return '不明（焼き込みが無い——古い焼き込みには存在しない定数か、値が空）';
  }
  const parsed = Date.parse(builtAt);
  if (Number.isNaN(parsed)) {
    return `不明（焼き込みの値が壊れている: ${builtAt}）`;
  }
  const diffMs = now.getTime() - parsed;
  if (diffMs < 0) {
    // 「0分前」等へ丸めず、そのまま申告する。
    return `${builtAt}（いまより未来——時計のずれの可能性がある）`;
  }
  return `${builtAt}（${describeElapsed(diffMs)}）`;
}
