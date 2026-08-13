import { sql } from 'drizzle-orm';

import type { Db } from './db.js';

/**
 * スキーマの用意。デーモンの起動時に毎回通す（すべて `if not exists`）。
 *
 * drizzle-kit の生成ファイルを配らないのは、**起動が別手順に依存しないため**
 * である。コンテナは `docker compose up` だけで上がるのが受け入れ基準1であり、
 * 「先にマイグレーションを流す」という人間の手順を足した時点でそれが崩れる。
 * 定義の実体は schema.ts で、ここはその DDL 表現。ずれれば pg のテストが落ちる
 * （storage-pg のテストは実 PostgreSQL（PGlite）で全 IF を通す）。
 *
 * 列を足すときは `alter table ... add column if not exists` をこの配列の末尾へ
 * 加える（既存の DB にも順に当たる）。**既存行の意味を変える変更を黙って混ぜない**
 * — それは記憶の書き換えであり、人間の確認が要る。
 */
const STATEMENTS = [
  `create table if not exists memory (
     slug text primary key,
     content text not null,
     updated_at timestamptz not null default now()
   )`,

  `create table if not exists journal (
     seq bigserial primary key,
     id text not null unique,
     at timestamptz not null,
     type text not null,
     entry jsonb not null
   )`,
  `create index if not exists journal_at_idx on journal (at)`,
  `create index if not exists journal_type_at_idx on journal (type, at)`,

  `create table if not exists jobs (
     id text primary key,
     status text not null,
     created_at timestamptz not null,
     updated_at timestamptz not null,
     job jsonb not null
   )`,

  `create table if not exists approvals (
     id text primary key,
     created_at timestamptz not null,
     answered_at timestamptz,
     approval jsonb not null
   )`,

  `create table if not exists archive (
     id text primary key,
     session_id text not null,
     at timestamptz not null,
     body text not null
   )`,

  `create table if not exists daemon_state (
     key text primary key,
     value text
   )`,

  `create table if not exists session_entries (
     seq bigserial primary key,
     project_key text not null,
     session_id text not null,
     subpath text not null default '',
     uuid text,
     entry jsonb not null
   )`,
  `create index if not exists session_entries_key_idx
     on session_entries (project_key, session_id, subpath, seq)`,
  `create unique index if not exists session_entries_uuid_idx
     on session_entries (project_key, session_id, subpath, uuid)
     where uuid is not null`,

  `create table if not exists sessions (
     project_key text not null,
     session_id text not null,
     subpath text not null default '',
     updated_at timestamptz not null default now(),
     primary key (project_key, session_id, subpath)
   )`,
  `create index if not exists sessions_project_idx on sessions (project_key, updated_at)`,

  // --- ログインとアクセス許可 ---------------------------------------------
  // 「誰がこの API に触れるか」の層。PRD「権限境界」（クローンが記憶を根拠に
  // 何を人間へ確認するか）とは別物なので、行為ごとのスコープ列は置かない。
  `create table if not exists auth_accounts (
     id text primary key,
     display_name text,
     email text,
     created_at timestamptz not null,
     last_login_at timestamptz,
     granted_at timestamptz,
     granted_by text
   )`,
  // email は null を許す（未検証・衝突時は入れない）。PostgreSQL の unique は
  // null を重複と見なさないので、これで「検証済みメールは高々1アカウント」になる。
  `create unique index if not exists auth_accounts_email_idx on auth_accounts (email)`,

  `create table if not exists auth_identities (
     provider text not null,
     subject text not null,
     account_id text not null,
     email text,
     email_verified boolean not null default false,
     created_at timestamptz not null,
     last_login_at timestamptz not null,
     primary key (provider, subject)
   )`,
  `create index if not exists auth_identities_account_idx on auth_identities (account_id)`,

  `create table if not exists auth_access_tokens (
     id text primary key,
     account_id text not null,
     sha256 text not null,
     label text not null default '',
     created_at timestamptz not null,
     expires_at timestamptz,
     last_used_at timestamptz,
     revoked_at timestamptz
   )`,
  `create unique index if not exists auth_access_tokens_sha256_idx on auth_access_tokens (sha256)`,
  `create index if not exists auth_access_tokens_account_idx on auth_access_tokens (account_id)`,

  `create table if not exists auth_login_requests (
     id text primary key,
     request jsonb not null,
     expires_at timestamptz not null
   )`,
  `create index if not exists auth_login_requests_expires_idx on auth_login_requests (expires_at)`,
] as const;

export async function migrate(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}
