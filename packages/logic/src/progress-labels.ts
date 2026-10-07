export type GithubCiCountKey = 'success' | 'failure' | 'pending';

export const GITHUB_CI_COUNT_LABEL = {
  success: '成功',
  failure: '失敗',
  pending: '実行中・待ち',
} as const satisfies Record<GithubCiCountKey, string>;

export const GITHUB_CI_COUNT_ORDER: readonly GithubCiCountKey[] = ['success', 'failure', 'pending'];

export const GITHUB_OBSERVED_BY_LABEL: Readonly<Record<string, string>> = {
  clone: 'クローン',
};

// 知らない値は識別子を出さない: `observedBy` は申告された自由文のため。
export const GITHUB_OBSERVED_BY_UNKNOWN = 'クローン以外からの申告';

// `Object.hasOwn` で引く: `constructor` などの名乗りを拾わないため。
export function githubObservedByLabel(observedBy: string): string {
  return Object.hasOwn(GITHUB_OBSERVED_BY_LABEL, observedBy)
    ? (GITHUB_OBSERVED_BY_LABEL[observedBy] as string)
    : GITHUB_OBSERVED_BY_UNKNOWN;
}

export const GITHUB_OPEN_LABEL = {
  issue: { raw: 'open Issue', localized: '開いている Issue' },
  pull: { raw: 'open PR', localized: '開いている PR' },
} as const;
export const GITHUB_TRUNCATED_NOTE = {
  raw: '（limit に達した。下限）',
  localized: '（上限に達した。下限）',
} as const;
