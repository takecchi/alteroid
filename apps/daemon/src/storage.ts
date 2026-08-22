import { mkdir } from 'node:fs/promises';

import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { deriveHumanTouchedAtFromJournal, type Stores } from '@alteroid/core';
import { AUTH_WITHHELD_ENV_KEYS } from './auth.js';
import {
  createFsStores,
  initWorkspace,
  resolvePaths,
  type AlteroidPaths,
} from '@alteroid/storage-fs';

/**
 * 記憶の置き場を決める（roadmap M4）。
 *
 * ローカル（fs）とクラウド（PostgreSQL）は**同じものの器違い**である。切り替えで
 * 能力が変わってはいけない — 受け入れ基準は「M1〜M3 の受け入れ基準が同じように
 * 通る」であって、クラウドだから何かができない、は認められない。
 */
export const DATABASE_URL_ENV = 'ALTEROID_DATABASE_URL';

export interface Storage {
  stores: Stores;
  /** state（daemon.json / ログ）の置き場。pg 構成でもここはローカルに要る。 */
  paths: AlteroidPaths;
  /** SDK のセッション永続化先。pg 構成でだけ付く。 */
  sessionStore?: SessionStore;
  /**
   * マネージャー子プロセスの環境変数から伏せる鍵。
   *
   * **記憶ストアへ到達するのに自分が使った鍵を、そのまま子へ配らない。**
   * これが非対称な可視性の本命であり、pg 構成では「渡さなければ到達経路が
   * 存在しない」という構造的な強制になる（architecture.md「非対称な可視性」）。
   */
  withheldEnvKeys: string[];
  /**
   * 記憶の器。**`paths.root` の意味がこれで変わる** — fs 構成ではそこに記憶が
   * あるが、pg 構成ではローカルに残るのは state だけで記憶ではない。取り違えた
   * まま表示すると、読んだ側が矛盾する2つの事実を同時に信じることになる。
   */
  kind: 'fs' | 'pg';
  /**
   * 記憶がどこにあるかの1行（起動ログと `/health`）。**接続情報そのものは出さない。**
   * 人間が「いまどっちの器で動いているか」を取り違えないための表示であり、
   * 認証情報の配布経路にはしない。
   */
  description: string;
  close(): Promise<void>;
}

/** 空文字の環境変数は「未指定」として扱う。 */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export interface StoragePlan {
  kind: 'fs' | 'pg';
  root: string | undefined;
  databaseUrl: string | undefined;
  withheldEnvKeys: string[];
  description: string;
}

/**
 * 環境変数から構成を決める（接続はしない）。
 *
 * 接続と分けてあるのは、**どの鍵を子プロセスから伏せるかが接続の成否と無関係に
 * 決まっている**ことを、DB 無しで確かめられるようにするためである。
 */
export function planStorage(env: NodeJS.ProcessEnv = process.env): StoragePlan {
  const root = envValue(env, 'ALTEROID_HOME');
  const databaseUrl = envValue(env, DATABASE_URL_ENV);

  if (databaseUrl === undefined) {
    return {
      kind: 'fs',
      root,
      databaseUrl: undefined,
      withheldEnvKeys: [...AUTH_WITHHELD_ENV_KEYS],
      description: '',
    };
  }

  return {
    kind: 'pg',
    root,
    databaseUrl,
    // 記憶へ到達するのに自分が使った鍵。これを配れば境界が消える。
    withheldEnvKeys: [DATABASE_URL_ENV, ...AUTH_WITHHELD_ENV_KEYS],
    description: `PostgreSQL（${safeTarget(databaseUrl)}）`,
  };
}

/**
 * 記憶の保護状態（human guard）の backfill。
 *
 * デーモン起動時に、日誌の全 `memory_update` を舐めて各 slug の
 * `human_touched_at` を確定させる（`PersonaStore.markHumanTouched` の doc）。
 * **`clone.ts` は触らない・呼ばない** — ここは記憶ストアを開いた直後、
 * クローンのセッションが立ち上がる前の起動処理である。
 *
 * 判定基準（`cause:'human'` かつ `action !== 'remove'`）は `deriveHumanTouchedAtFromJournal`
 * （`@alteroid/core`）に1本化してある。**各 `PersonaStore`（fs / pg）が保護状態の
 * 索引を読み出し時に失っていたと分かったとき、同じ関数でその場でも組み直す**
 * （`storage-fs` の `FsPersonaStore#rebuildIndex` / `storage-pg` の
 * `PgPersonaStore#healRow`）。**ここ（起動時 backfill）はその「その場の組み直し」
 * だけに頼らないための保険である** — 走行中に索引を失った場合、次にその slug が
 * 読まれるまでは `unknown`（守る側）のまま動く。基準がここ以外にも散ると、
 * 片方だけ直して残りが古い基準のまま、という穴ができるので、実装は持たず呼ぶだけ。
 *
 * **既に立っている `human_touched_at` を降ろすことはない** —
 * `markHumanTouched` 自体が単調非減少なので、ここは呼ぶだけでよい。
 *
 * **失敗しても起動は続ける。** 失敗した slug は `unknown` のまま
 * （守る側へ自然に倒れる）。
 */
async function backfillMemoryHumanTouch(stores: Stores): Promise<void> {
  try {
    const humanTouchedAt = await deriveHumanTouchedAtFromJournal(stores.journal);
    for (const [slug, at] of humanTouchedAt) {
      await stores.persona.markHumanTouched(slug, at);
    }
  } catch (error) {
    process.stderr.write(
      `alteroidd: 記憶の保護状態の backfill に失敗した（unknown のまま起動を続ける）: ${String(error)}\n`,
    );
  }
}

export async function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const plan = planStorage(env);

  if (plan.kind === 'fs' || plan.databaseUrl === undefined) {
    const { paths } = await initWorkspace(plan.root);
    const stores = createFsStores(plan.root);
    await backfillMemoryHumanTouch(stores);
    return {
      stores,
      paths,
      withheldEnvKeys: plan.withheldEnvKeys,
      kind: 'fs',
      description: paths.root,
      close: async () => undefined,
    };
  }

  // pg 構成でも state（接続先とプロセス id）はローカルに要る。CLI がデーモンを
  // 見つける手段であり、記憶ではない。
  const paths = resolvePaths(plan.root);
  await mkdir(paths.state, { recursive: true });

  // fs 構成のときに pg ドライバを読み込まない（ローカルは pg 無しで完結する）
  const { createPgStores, seedPgWorkspace } = await import('@alteroid/storage-pg');
  const pg = await createPgStores(plan.databaseUrl);
  await seedPgWorkspace(pg);
  await backfillMemoryHumanTouch(pg);

  return {
    stores: pg,
    paths,
    sessionStore: pg.sessionStore,
    withheldEnvKeys: plan.withheldEnvKeys,
    kind: 'pg',
    description: plan.description,
    close: () => pg.close(),
  };
}

/**
 * 接続先をログに出せる形にする。**パスワードは出さない。**
 * 起動ログは人間が読むもので、認証情報の配布経路にしない。
 */
function safeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(接続先の形式が読めない)';
  }
}
