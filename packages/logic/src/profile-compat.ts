import type { ProfileEntryView, ProfileState } from './types.js';

export type NormalizedProfile = ProfileState & { legacy: boolean };

// 型は新しい形しか約束しないが実行時に旧形式を倒す: デーモンは画面・CLI より最大1日遅れて入るため、古いデーモンの応答が必ず来る窓がある。
export function normalizeProfile(raw: ProfileState): NormalizedProfile {
  if (Array.isArray((raw as { entries?: unknown }).entries)) {
    return {
      ...raw,
      clone: raw.clone ?? {},
      runner: raw.runner ?? {},
      legacy: false,
    };
  }
  const old = raw as unknown as {
    script?: string;
    updatedAt?: string;
    sha256?: string;
    bytes?: number;
  };
  const script = typeof old.script === 'string' ? old.script : '';
  const entries: ProfileEntryView[] =
    script.length === 0
      ? []
      : [
          {
            name: 'default',
            script,
            scope: 'all',
            updatedAt: old.updatedAt ?? '',
            sha256: old.sha256 ?? '',
            bytes: old.bytes ?? new TextEncoder().encode(script).length,
          },
        ];
  return {
    entries,
    clone: {},
    runner: {},
    script,
    ...(old.updatedAt === undefined ? {} : { updatedAt: old.updatedAt }),
    ...(old.sha256 === undefined ? {} : { sha256: old.sha256 }),
    ...(old.bytes === undefined ? {} : { bytes: old.bytes }),
    legacy: true,
  };
}

export const LEGACY_PROFILE_NOTICE =
  '接続先のサーバが古いので、行ごとの操作（追加・削除・渡す先の変更）はできない。サーバが新しくなってから使える（置かれている本文は「default」という名前の1行として見えている）。';
