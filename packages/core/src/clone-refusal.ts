/**
 * 安全分類器（safeguards）にセッションごと弾かれ続けていることの検知の、
 * 判定の部品と文言。状態そのものは `Clone` が持つ（`#refusalStreak` ほか）。
 */

/** 別の入力で、この回数続けて弾かれたら「セッションごと弾かれている」と見る。 */
export const REFUSAL_STREAK_THRESHOLD = 2;

/** 自動の開き直しの actor（日誌とクローンへの断りに載る名乗り）。 */
export const REFUSAL_AUTO_REOPEN_ACTOR = 'クローンの自動判定（safeguards）';

/**
 * 自動の開き直しを外す環境変数（既定は有効）。
 *
 * **デーモン単位の設定の形は `ALTEROID_BASH_GUARD` / `ALTEROID_MEMORY_GUARD` に揃えた**: 器の `compose.yaml` へ足さず、
 * `alteroid credential set ALTEROID_REFUSAL_AUTO_REOPEN off`（scope は app か all）で置く。デーモンは起動時に
 * `applyAppScopedEnvVars` で `process.env` へ書き写し、`Clone` は判断の時点で `CloneOptions.env` を読む。
 * 置いた値は次の起動から効く（走行中の `process.env` は書き換えない）。
 */
export const REFUSAL_AUTO_REOPEN_ENV = 'ALTEROID_REFUSAL_AUTO_REOPEN';

export interface RefusalAutoReopenSetting {
  readonly enabled: boolean;
  /** 読めなかった綴り（既定の有効へ倒した）。判断の行に残して、置いたのに効かないを黙らせない。 */
  readonly unrecognized?: string;
}

/**
 * 綴りの扱い: 空・空白は未設定（有効）。`off` / `false` / `0` / `no` / `disabled` で外す。`on` / `true` / `1` / `yes` / `enabled` は有効。
 * それ以外は有効のまま `unrecognized` に載せる。**投げない**（失敗の報告の途中で呼ばれるため。`bash-guard-mode.ts` は起動時に落とすが、ここでは落とせない）。
 */
export function resolveRefusalAutoReopen(env: NodeJS.ProcessEnv): RefusalAutoReopenSetting {
  const given = env[REFUSAL_AUTO_REOPEN_ENV]?.trim().toLowerCase();
  if (given === undefined || given === '') return { enabled: true };
  if (['off', 'false', '0', 'no', 'disabled'].includes(given)) return { enabled: false };
  if (['on', 'true', '1', 'yes', 'enabled'].includes(given)) return { enabled: true };
  return { enabled: true, unrecognized: given };
}

const SAFEGUARDS_FLAGGED_MARKER = 'safeguards flagged';

/**
 * **弱い判定である。** 失敗文に `safeguards flagged` が含まれるか（大小無視）。
 * 構造の合図（`refusal` イベント）を出さない CLI と、本番で観測した文言の形
 * （`… safeguards flagged this session … Details: [cyber]`）を拾う補助で、文言は provider が変えうる。
 * **失敗で終わったターンの失敗文にだけ使う。答えが返ったターンの本文には使わない**（クローンが
 * 「弾かれた」と書いただけで数えないため）。
 */
export function looksLikeSafeguardsRefusal(failureText: string): boolean {
  return failureText.toLowerCase().includes(SAFEGUARDS_FLAGGED_MARKER);
}

/**
 * 失敗文の `Details: [cyber]` から category を拾う（弱い補助。構造の合図が無い回の category の穴埋めだけに使う）。
 * 読めなければ `null`。
 */
export function categoryFromRefusalText(failureText: string): string | null {
  const matched = /Details:\s*\[([A-Za-z0-9_-]{1,40})\]/.exec(failureText);
  return matched?.[1] ?? null;
}

/** `[障害]` 行の末尾へ足す印。先頭の文言は変えない。 */
export function describeRefusalFailureMark(category: string | null): string {
  return `（safeguards: ${category ?? '不明'}）`;
}

export type RefusalAutoReopenState = 'enabled' | 'disabled' | 'halted';

/** 人間へ出す、開き直す口の案内。 */
export const REFUSAL_REOPEN_DOORS =
  '開き直す口: `alteroid reopen` / 設定画面の「クローンのセッションを開き直す」 / `POST /clone/session/reopen`';

export function describeRefusalReopened(streak: number, category: string | null): string {
  return (
    `安全分類器（safeguards: ${category ?? '不明'}）に ${String(streak)} 回続けて弾かれたので、` +
    'クローンのセッションを新しく開き直した。それまでのやりとりの記録は消えていない。' +
    '古いセッションの生ログは退避した。新しいセッションのクローンは、それまでの続きを覚えていない状態で始まる。'
  );
}

export function describeRefusalNotReopened(streak: number, category: string | null): string {
  return (
    `クローンのセッションが安全分類器（safeguards: ${category ?? '不明'}）に ${String(streak)} 回続けて弾かれている。` +
    `自動の開き直しは外してあるので、開き直していない。${REFUSAL_REOPEN_DOORS}`
  );
}

export function describeRefusalHalted(category: string | null): string {
  return (
    '自動で開き直したセッションが、1度も答えを返さないうちにまた安全分類器' +
    `（safeguards: ${category ?? '不明'}）に弾かれた。` +
    '記憶の焼き込みや届き続ける合図そのものが弾かれている可能性がある。' +
    '自動の開き直しは止めた（人間が開き直すか、このセッションが1度答えを返すまで再開しない）。' +
    REFUSAL_REOPEN_DOORS
  );
}
