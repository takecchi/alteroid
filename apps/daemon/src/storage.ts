import { access, mkdir } from 'node:fs/promises';

import { sql } from 'drizzle-orm';

import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import {
  ATTACHMENT_S3_ACCESS_KEY_ID_ENV,
  ATTACHMENT_S3_BUCKET_ENV,
  ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryCreatedAtFromJournal,
  readAttachmentBlobConfig,
  readAttachmentLimits,
  reasonOf,
  type AttachmentLimits,
  type Stores,
} from '@alteroid/core';
import { AUTH_WITHHELD_ENV_KEYS } from './auth.js';
import { reportBootFootprint } from './boot-footprint.js';
import {
  createFsStores,
  initWorkspace,
  resolvePaths,
  type AlteroidPaths,
} from '@alteroid/storage-fs';

export const DATABASE_URL_ENV = 'ALTEROID_DATABASE_URL';

export interface Storage {
  stores: Stores;
  paths: AlteroidPaths;
  /**
   * 添付の上限（置き場の実際の構成から決めた値。#4128 段2）。外部ストレージが実際に使われないとき
   * （未設定・不正・fs の構成）は `maxLargeFileBytes` が 0。置き場も `createApp`・クローンの道具・担い手のプールも、
   * 環境変数を読み直さずこの値を使う（env だけで大きいファイルの枠が開く不整合を作らない）。
   */
  attachmentLimits: AttachmentLimits;
  sessionStore?: SessionStore;
  // 記憶ストアへ到達するのに自分が使った鍵を子へ配らない: 渡さなければ到達経路が存在しない、という構造的な強制のため。
  withheldEnvKeys: string[];
  // `paths.root` の意味が変わる: fs 構成ではそこに記憶があるが、pg 構成でローカルに残るのは state だけで、取り違えると矛盾する2つの事実を信じることになる。
  kind: 'fs' | 'pg';
  // 接続情報そのものは出さない: 認証情報の配布経路にしないため。
  description: string;
  close(): Promise<void>;
  // `resetWorkspaceState` の `clear()` 一式には含めない: `sessionStore` は `Storage` 側にしか無いフィールドのため。
  clearSessionLog?: () => Promise<number>;
  probe: () => Promise<void>;
}

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

// 接続と分ける: どの鍵を子プロセスから伏せるかが接続の成否と無関係に決まることを、DB 無しで確かめられるようにするため。
export function planStorage(env: NodeJS.ProcessEnv = process.env): StoragePlan {
  const root = envValue(env, 'ALTEROID_HOME');
  const databaseUrl = envValue(env, DATABASE_URL_ENV);
  // 外部ストレージの資格も担い手の子プロセスへ配らない（設定されているときだけ。使わない構成でも秘密は伏せる）
  const blobSecrets =
    envValue(env, ATTACHMENT_S3_BUCKET_ENV) === undefined
      ? []
      : [ATTACHMENT_S3_ACCESS_KEY_ID_ENV, ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV];

  if (databaseUrl === undefined) {
    return {
      kind: 'fs',
      root,
      databaseUrl: undefined,
      withheldEnvKeys: [...blobSecrets, ...AUTH_WITHHELD_ENV_KEYS],
      description: '',
    };
  }

  return {
    kind: 'pg',
    root,
    databaseUrl,
    withheldEnvKeys: [DATABASE_URL_ENV, ...blobSecrets, ...AUTH_WITHHELD_ENV_KEYS],
    description: `PostgreSQL（${safeTarget(databaseUrl)}）`,
  };
}

// 判定基準の実装を持たず `deriveHumanTouchedAtFromJournal` を呼ぶだけにする: 基準が散ると、片方だけ直して残りが古い基準のままになるため。
async function backfillMemoryHumanTouch(stores: Stores): Promise<void> {
  try {
    const humanTouchedAt = await deriveHumanTouchedAtFromJournal(stores.journal);
    for (const [slug, at] of humanTouchedAt) {
      await stores.persona.markHumanTouched(slug, at);
    }
  } catch (error) {
    process.stderr.write(
      `alteroidd: 記憶の保護状態の backfill に失敗した（unknown のまま起動を続ける）: ${reasonOf(error)}\n`,
    );
  }
}

// `created_at` を埋める以外のことをしない・削除しない: 記憶の絶対条件のため。
// 根拠が無い文書には `markCreatedAt` を呼ばず `unknown` のままにする: `mtime` にも `birthtime` にも触れない。
async function backfillMemoryCreatedAt(stores: Stores): Promise<void> {
  try {
    const createdAt = await deriveMemoryCreatedAtFromJournal(stores.journal);
    let filled = 0;
    for (const [slug, at] of createdAt) {
      if (await stores.persona.markCreatedAt(slug, at)) filled += 1;
    }
    const metas = await stores.persona.list();
    const unknown = metas.filter((meta) => meta.createdAt.kind === 'unknown').length;
    process.stdout.write(
      `alteroidd: 記憶の created_at backfill: ${filled} 件を新たに埋めた` +
        `（記憶は全 ${metas.length} 件、うち unknown ${unknown} 件）。\n`,
    );
  } catch (error) {
    process.stderr.write(
      `alteroidd: 記憶の created_at backfill に失敗した（unknown のまま起動を続ける）: ${reasonOf(error)}\n`,
    );
  }
}

// 起動時に決める: 読み出しでも決まるが、起動時に決めないと基準時刻が「最初に読まれた時刻」へ遅れるため。
async function ensureConversationReadBaseline(stores: Stores): Promise<void> {
  try {
    const result = await stores.conversationReads.ensureBaseline(new Date().toISOString());
    if (result.state === 'unreadable') {
      process.stderr.write(
        `alteroidd: 会話の既読の記録が読めない（基準時刻は決めていない）: ${result.reason}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `alteroidd: 会話の既読の基準時刻を決められなかった（起動は続ける）: ${reasonOf(error)}\n`,
    );
  }
}

/**
 * 添付の中身の置き場（外部ストレージ）の設定を、置き場の構成に照らして決める（#4128 段2）。
 * 使うのは「pg の構成で、設定が読めた」ときだけ。使わないなら理由を1行 stderr へ出し（値は載せない）、
 * 上限は `maxLargeFileBytes: 0`（枠なし）に揃える。
 */
export function planAttachmentBlobs(
  env: NodeJS.ProcessEnv,
  kind: 'fs' | 'pg',
  write: (line: string) => void = (line) => void process.stderr.write(line),
): {
  config:
    Extract<ReturnType<typeof readAttachmentBlobConfig>, { kind: 'on' }>['config'] | undefined;
  limits: AttachmentLimits;
} {
  const blob = readAttachmentBlobConfig(env);
  const limits = readAttachmentLimits(env).limits;
  if (blob.kind === 'invalid') {
    write(`alteroidd: 添付の外部ストレージは使わない（設定が不正）: ${blob.reason}\n`);
  }
  if (blob.kind === 'on' && kind === 'fs') {
    write('alteroidd: 添付の外部ストレージの設定は、fs の置き場では使わない（無視する）\n');
  }
  if (blob.kind === 'on' && kind === 'pg') return { config: blob.config, limits };
  return { config: undefined, limits: { ...limits, maxLargeFileBytes: 0 } };
}

export async function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const plan = planStorage(env);

  if (plan.kind === 'fs' || plan.databaseUrl === undefined) {
    const { paths } = await initWorkspace(plan.root);
    const { limits: attachmentLimits } = planAttachmentBlobs(env, 'fs');
    const stores = createFsStores(plan.root, { limits: attachmentLimits });
    // 重い読み（backfill の journal 走査）より前に置く。fs 構成では表の実寸を測れないので `null` を渡す。
    await reportBootFootprint(stores, null);
    await backfillMemoryHumanTouch(stores);
    await backfillMemoryCreatedAt(stores);
    await ensureConversationReadBaseline(stores);
    return {
      stores,
      paths,
      attachmentLimits,
      withheldEnvKeys: plan.withheldEnvKeys,
      kind: 'fs',
      description: paths.root,
      close: async () => undefined,
      probe: () => access(paths.root),
    };
  }

  const paths = resolvePaths(plan.root);
  await mkdir(paths.state, { recursive: true });

  // 動的 import にする: fs 構成のときに pg ドライバを読み込まないため。
  const { createPgStores, seedPgWorkspace, measureStorageFootprint, S3AttachmentBlobStore } =
    await import('@alteroid/storage-pg');
  const blobPlan = planAttachmentBlobs(env, 'pg');
  const pg = await createPgStores({
    url: plan.databaseUrl,
    attachments: {
      limits: blobPlan.limits,
      ...(blobPlan.config === undefined
        ? {}
        : {
            blobs: new S3AttachmentBlobStore(blobPlan.config),
            blobKeyPrefix: blobPlan.config.prefix,
          }),
    },
  });
  await seedPgWorkspace(pg);
  // backfill（journal を走査する）より前に置く: 重い読みの全部より前が要件のため。
  const footprint = await measureStorageFootprint(pg.db);
  await reportBootFootprint(pg, footprint);
  await backfillMemoryHumanTouch(pg);
  await backfillMemoryCreatedAt(pg);
  await ensureConversationReadBaseline(pg);

  return {
    stores: pg,
    paths,
    attachmentLimits: blobPlan.limits,
    sessionStore: pg.sessionStore,
    withheldEnvKeys: plan.withheldEnvKeys,
    kind: 'pg',
    description: plan.description,
    close: () => pg.close(),
    clearSessionLog: () => pg.sessionStore.clearAll(),
    probe: async () => {
      await pg.db.execute(sql`select 1`);
    },
  };
}

// パスワードは出さない: 起動ログを認証情報の配布経路にしないため。
function safeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(接続先の形式が読めない)';
  }
}
