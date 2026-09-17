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
