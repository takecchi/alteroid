---
name: postgres-in-container
description: 器の中で PostgreSQL 17 と pgvector を立てて挙動を確かめるときに読む。apt が作る postgres システムユーザーを使わず uid 1001（worker）のまま initdb / pg_ctl を直に叩く手順（PATH・-k /tmp・ポート）、CI の image ジョブで実際に通った生ログ、pg_createcluster / pg_ctlcluster が使えない理由（Dockerfile が既定クラスタと /etc/postgresql を消している）、既定のクラスタが無いこと。
---

# 器の中で postgres 17 / pgvector を立てる

<!-- AGENTS.md から移設（2026-09-17）。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **器に postgres 17 と pgvector が在る**（2026-09-15 から。`Dockerfile` の runtime ステージ、#965）。**apt が作る `postgres` システムユーザーは使わない** — 自分（uid 1001／`worker`）のまま、`su` も root も要らずに直に立てられる。実測は CI の `image` ジョブを `-u 1001`（root でも `postgres` でもない、マネージャー・作業者が実際に走る uid）で走らせて確認したもので、`initdb` の出力が `The files belonging to this database system will be owned by user "worker".` になることまで見ている。
  - **使い方は `initdb` → `pg_ctl` を直に叩く。** バイナリは標準の `PATH` に無いので `PATH=/usr/lib/postgresql/17/bin:$PATH` を通す。自分が書ける場所（`/tmp` 配下など）へ都度データディレクトリを掘る。**実際に通った手順**（2026-09-15、CI `image` ジョブ、uid 1001、`alteroid:ci` の中。生ログは #965 の PR #1024 参照）:
    ```
    $ export PATH=/usr/lib/postgresql/17/bin:$PATH
    $ mkdir -p /tmp/pgdata-ci
    $ initdb -D /tmp/pgdata-ci --auth=trust
    ...
    Success. You can now start the database server using:
        pg_ctl -D /tmp/pgdata-ci -l logfile start
    $ pg_ctl -D /tmp/pgdata-ci -l /tmp/pg.log -o "-k /tmp -h 127.0.0.1 -p 5433" start
    waiting for server to start.... done
    server started
    $ psql -h 127.0.0.1 -p 5433 -d postgres -c "CREATE EXTENSION vector;"
    CREATE EXTENSION
    $ psql -h 127.0.0.1 -p 5433 -d postgres -c "SELECT extname, extversion FROM pg_extension;"
     extname | extversion
    ---------+------------
     plpgsql | 1.0
     vector  | 0.8.0
    $ pg_ctl -D /tmp/pgdata-ci stop
    ```
    `-k /tmp` で unix ソケットの置き場所を指定し、`-p 5433` のように既存と衝突しないポートを選ぶ（`-h 127.0.0.1` は tcp も併用する場合）。
  - ⛔ **`pg_createcluster` / `pg_ctlcluster`（Debian の作法）は使えない。** `Dockerfile` が既定クラスタと一緒に `/etc/postgresql` を消している（空のクラスタをイメージへ焼かないための設計）ので、これらのラッパーが読む設定が無い。
  - ⚠ **既定のクラスタは無い。** 自分の作業ディレクトリへ都度 `initdb` して立て、使い終わったら `pg_ctl stop`（必要ならディレクトリごと削除）する — 使い捨てる前提で、居座らせない。

## storage-pg のテストを本物の PostgreSQL で走らせる（#2918）

storage-pg のテストは既定で PGlite（プロセス内の PostgreSQL）で走る。**本物の PostgreSQL へ向けるには `ALTEROID_TEST_PG_URL` を渡す**（口は `packages/storage-pg/src/test-db.test-support.ts` の `createMigratedTestDb`。無ければ従来どおり PGlite）。CI では `.github/workflows/storage-pg-real-postgres.yml` が同じことを service コンテナ（`postgres:17`）で、照合順 `en_US.UTF-8` と `C` の2通り走らせる（必須チェックではない）。

- **向けられるのは `test-db.test-support.ts` の `createMigratedTestDb`（migrate 済み）/ `createEmptyTestDb`（migrate していない空の DB）を使うテストだけ**（#2937 で storage-pg のほぼ全部が移った。CI は `test-db.test-support` を import するテストを grep で拾う）。残る `migrate.test.ts` と `pglite-template.test.ts` は PGlite 直結で、環境変数を渡しても PGlite で走る。
- **テストごとに別の DATABASE を切る。** 接続先の DB の照合順・文字コードを引き継いだ雛形 DB（`alteroid_tpl_<照合順>_<migrate/schema のハッシュ>`）を1つ作り、各テストは `CREATE DATABASE ... TEMPLATE` で起こして、閉じるときに `DROP DATABASE ... WITH (FORCE)` する。接続のユーザーは `CREATEDB` が要る。**雛形 DB は消さない**ので、自分で立てたクラスタは使い終わったら `pg_ctl stop` してディレクトリごと消す。
- **照合順を指定した接続先は自分で作る**（`template0` から）。手順（上の「実際に通った手順」の続き。ポートは自分専用の値にする）:
  ```
  $ psql -h 127.0.0.1 -p 55968 -U postgres -c "create database alteroid_c template template0 lc_collate 'C' lc_ctype 'C' encoding 'UTF8'"
  $ cd packages/storage-pg
  $ ALTEROID_TEST_PG_URL=postgres://postgres@127.0.0.1:55968/alteroid_c \
    ALTEROID_TEST_PG_EXPECT_COLLATE=C \
    pnpm test --maxWorkers=2 $(grep -l "test-db\.test-support" src/*.test.ts)
  ```
  `ALTEROID_TEST_PG_EXPECT_COLLATE` は任意で、渡すと `test-db.test.ts` が「その照合順で本当に繋がっているか」を確かめる。**この器の `locale -a` は `C` / `C.utf8` / `POSIX` だけ**（2026-10-05 観測）で、`en_US.UTF-8` は既定では作れない。**ただし root 無しで作れた**（#2937、2026-10-06）: `localedef -i en_US -f UTF-8 /tmp/loc/en_US.UTF-8` で自分の場所へロケールを焼き、`LOCPATH=/tmp/loc` を付けて `initdb --locale=en_US.UTF-8` と `pg_ctl start` をすれば en_US の本物が立つ（`select 'a' < 'B'` が真）。使い終わったら `/tmp/loc` も消す。
- **本物でだけ落ちる歯は、その場で直さずテストの側で `it.skipIf(realPostgresUrl() !== undefined)` にして、Issue 番号をコメントに残す**（例: #2922 の同じ id の並行 open。PGlite は単一接続なので並行は再現できない）。直したら skipIf を外す。
- 実行はふつうの `pnpm test` と同じく少しずつ（`--maxWorkers=2` 程度）。テストが DB を作る先は自分のクラスタだけなので、他と衝突するのは**ポート**だけである。
