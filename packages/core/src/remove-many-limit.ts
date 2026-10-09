// `tools.ts` へ統合しない: CLI が定数2つのために SDK・zod を評価してしまう。
export const REMOVE_MANY_LIMIT_DEFAULT = 500;
export const REMOVE_MANY_LIMIT_MAX = 2_000;
