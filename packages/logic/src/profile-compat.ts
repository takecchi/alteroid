import type { ProfileState } from './types.js';

export type NormalizedProfile = ProfileState;

// 型は新しい形しか約束しないが、実行時に `entries` の無い応答（旧い形）は読み替えずに倒す: 読み替えると、行ごとの操作が効かない画面・CLI を黙って見せてしまうため。
export function normalizeProfile(raw: ProfileState): NormalizedProfile {
  if (!Array.isArray((raw as { entries?: unknown }).entries)) {
    throw new Error('プロファイルの応答が読めない形で届いた（entries が無い）');
  }
  return {
    ...raw,
    clone: raw.clone ?? {},
    runner: raw.runner ?? {},
  };
}
