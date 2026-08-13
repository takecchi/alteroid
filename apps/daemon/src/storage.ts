import { mkdir } from 'node:fs/promises';

import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { Stores } from '@alteroid/core';
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

export async function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const plan = planStorage(env);

  if (plan.kind === 'fs' || plan.databaseUrl === undefined) {
    const { paths } = await initWorkspace(plan.root);
    return {
      stores: createFsStores(plan.root),
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
