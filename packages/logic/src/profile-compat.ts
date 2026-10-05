import type { ProfileEntryView, ProfileState } from './types.js';

/**
 * `GET /profile` の応答を、**古いデーモンの形も含めて**画面・CLI が読める1つの形に直す。
 *
 * ## なぜ要るか
 *
 * Web（Vercel）はマージ直後に入るが、デーモンは `release/prod` 経由で1日1回、夜に入る。
 * したがって**「新しい画面・CLI × 古いデーモン」の窓が最大で約1日、必ず生じる**。古い
 * デーモンの応答は `{ script, updatedAt?, sha256?, bytes? }` だけで、`entries` も
 * `clone` も `runner` も無い。型（\`ProfileState\`）は新しい形を約束しているので、
 * **型では塞がらない**（型が守るのはビルド時だけ）。実行時の倒れ先をここに1つ置く。
 *
 * ## 旧形式の扱い
 *
 * `entries` が配列でない応答は旧形式（`legacy: true`）。従来の `script` が空でなければ、
 * `default` 行（撒く先 `all`）1つとして**そのまま見せる**（データは1文字も消さない・隠さない。
 * 古いデーモンの本文は、新しいデーモンへ移ったとき実際に `default` 行になる）。
 * 行ごとの書き込み（名前・撒く先・削除）は古いデーモンでは通らないので、呼び出し側は
 * `legacy` を見て出さない／無効にし、本文の編集だけを従来の `PUT /profile` へ倒す。
 * 合成後の指紋（`clone` / `runner`）は旧形式では分からないので空にする。
 */
export type NormalizedProfile = ProfileState & { legacy: boolean };

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

/** 古いデーモンに繋がっているときの案内（画面・CLI で同じ文言）。 */
export const LEGACY_PROFILE_NOTICE =
  '接続先のサーバが古いので、行ごとの操作（追加・削除・渡す先の変更）はできない。サーバが新しくなってから使える（置かれている本文は「default」という名前の1行として見えている）。';
