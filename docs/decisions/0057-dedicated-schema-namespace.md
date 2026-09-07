# ADR 0057: mnemora のオブジェクトを置くスキーマを、使う側が指定できるようにする

- **状態**: 採用 (2026-09)

- **文脈**:

  オーナーの問い（逐語）:

  > **PostgreSQLが一つしかない環境化でも動作する？** っていうのも**予約しているテーブル名が
  > すでにあって重複したらどうなるのか**気になりました。**スキーマを専用のものに分けていたり、
  > prefixで対応していたり、そういった対策がなされているんでしょうか？**

  答えは「なされていない」だった。`packages/postgres` が作るオブジェクトは、
  `observations` / `memories` / `memory_events` / `recalls` / `recall_usages` /
  `outbox` / `tenant_settings` / `_mnemora_migrations` / `memory_embeddings_<space>`
  という**裸の名前**で、接続の `search_path`（既定では `"$user", public`）が指すスキーマに
  作られる。`migrations/0001_init.sql` の `CREATE TABLE` には `IF NOT EXISTS` が付いていない
  （ADR 0017 の実測がその理由を記録している）ので、**同名のテーブルが既に在る DB では
  `runMigrations()` が落ちる。**共有 PostgreSQL に `memories` や `outbox` という名前の
  テーブルを持つ別のシステムが同居していれば、それだけで mnemora は導入できない。

  オーナーはさらに「**今対応が楽かとかではなく、ベストな形を教えてください**」と書いている。
  ⟹ prefix で名前を捻る案は採らない（名前空間の問題を名前の綴りで回避する形であり、
  PostgreSQL が既に持っている名前空間の機構を使わない理由が無い）。

- **測ったこと（本物の PostgreSQL 17.11 + pgvector、CI の service container）**:

  実装より前に、`search_path` を専用スキーマへ向ける形が本当に成立するかを探針で測った。
  `migrate-ledger-handover.test.ts` の doc は「共有 DB の中に専用スキーマを切って
  `search_path` を `<schema>,public` に向ける形では隔離できない」と書いていたが、
  **その文には条件節が付いていた**——「CI は本番の台帳を `public` に作った状態でテストへ
  入る」。これは*測定環境の事情*であって*製品の性質*ではない。実際に測った結果は次の通り。

  | 測ったこと | 実測 |
  |---|---|
  | `public` に本番一式が在る DB で、`search_path = <schema>, public` にして `0001_init.sql` を流す | **通った。**`<schema>` 側に同名のテーブル7本・索引4本・制約9本が作られ、`public` 側は無傷 |
  | 同名のオブジェクトが2つのスキーマに同居できるか | **できた**（`public.memories` と `<schema>.memories` が別 oid で並存） |
  | 台帳をスキーマ修飾して問えるか | **問えた**。`to_regclass('<schema>._mnemora_migrations')` は作る前 `NULL`、作った後は `public` 側と別 oid |
  | `search_path` から `public` を外して `0001_init.sql` を流す | **落ちなかった**（`APPLIED`）。gin の operator class は `public.text_ops` として解決されていた |
  | まっさらな DB で `search_path = s1, public` のとき `CREATE EXTENSION IF NOT EXISTS vector` はどこへ入るか | **`s1` に入った。**そのあと `s2` から `vector` 型を使うと `42704: type "vector" does not exist` |
  | 既に `ext` に `vector` が在る DB へ `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public` | **エラーにならず黙って skip**（拡張は `ext` のまま）。まっさらな側では `public` に入った |

  **⚠ 4行目は、実装より前の doc の主張を裏切っている。**doc は「`public` を外すと
  `idx_memories_tags` の gin operator class が解けずに落ちる」と書いていたが、
  実測では落ちなかった。**この ADR はその差を「doc が誤っていた」とは断定しない**——
  測ったのは PostgreSQL 17.11 の1バージョンの1構成だけであり、
  operator class の既定解決が `search_path` にどう依存するかまでは切り分けていない。
  **依存しないほうへ倒す**（後述の決定で `extensionSchema` を必ず `search_path` に含める）。

  **⚠ 5行目が、この設計で最も高くついた実測である。**「専用スキーマを切れば隔離できる」で
  終わりにすると、**まっさらな DB に2つ目の mnemora を置いた瞬間に壊れる。**
  拡張はスキーマではなくデータベースに属するのに、`CREATE EXTENSION` の既定の置き場所は
  `search_path` の先頭——つまり1つ目の mnemora の専用スキーマ——になるためである。

- **決定**:

  **「DML は `search_path` に任せ、DDL と存在検査は明示修飾する」。**

  1. `schema` オプションを新設し、指定されたスキーマに mnemora のオブジェクトを置く。
     受け口は3つ: `createPostgresClient` / `runMigrations` / `registerEmbeddingSpace`。
  2. **`schema` を指定しない既定の経路は、発行される SQL が今日と同一である。**
     新しい振る舞いはすべて `schema !== undefined` で分岐する。
     ⟹ 既に mnemora を使っている環境は、この変更で1ミリも動かない。
  3. **DML（`memory-store` / `vector-store` / `event-store` / `outbox-store` /
     `tenant-settings-store`）は1行も変えない。**接続の startup parameter
     `options=-c search_path=<schema>,<extensionSchema>` で先頭スキーマを差し替える。
  4. **DDL と存在検査は `search_path` に頼らず明示修飾する。**
     `to_regclass('_mnemora_migrations')` は `search_path` 全体を探すため、
     `public` に台帳が在ると `<schema>` 側の不在を「在る」と誤判定する
     （`migrate-ledger-handover.test.ts` の doc が記録している実害そのもの）。
     `CREATE TABLE IF NOT EXISTS` の可視性判定も同じ危険を持つ。
  5. **拡張は `extensionSchema`（既定 `public`）へ固定する。**
     `schema` が指定されたときだけ、マイグレーション適用の前に
     `CREATE EXTENSION IF NOT EXISTS <ext> WITH SCHEMA "<extensionSchema>"` を撃つ。
     測定より、既に別の場所に在る拡張は黙って skip されるので**既存環境を壊さない。**
  6. **advisory lock のキーをスキーマから導出する。**
     `pg_advisory_lock` のキー空間は**データベース全体で共有**される（`advisory-lock.ts` の
     doc が既に書いている）。⟹ スキーマを分けても、キーが同じままだと
     **2つの mnemora の `runMigrations` が互いを黙ってブロックする**——テーブル名の衝突は
     `CREATE TABLE` が落ちて気付けるが、**こちらは落ちないので気付けない。**
     ただし `schema` が未指定または `"public"` のときは**既存の定数をそのまま使う**。

- **採らなかった案**:

  - **テーブル名に prefix を付ける。**オーナーが「今対応が楽かとかではなく」と名指しで
    退けた方向。加えて、PostgreSQL の識別子は 63 バイトが上限で、
    `idx_memory_embeddings_hnsw_<space>` は既にその上限に対する切り詰め処理を持っている
    （`embedding-space-table.ts`）。prefix はその予算をさらに削る。
    **名前空間の機構が在るのに、名前の綴りで名前空間を模す理由が無い。**
  - **すべての SQL を明示修飾する（`search_path` を使わない）。**
    `packages/postgres` の生 SQL は数百の裸のテーブル名を含む。**1つ取りこぼすと、
    そのクエリだけが黙って別スキーマを読む**——最も気付きにくい壊れ方である。
    `search_path` なら差し替え点が接続の1箇所に集まる。
  - **drizzle の `pgSchema` を使う。**`schema.ts` の doc が逐語で
    「**これらの定義はスキーマの生成には使わない。**テーブル・索引の実体は
    `migrations/0001_init.sql` が作る」と書いている通り、drizzle の定義は型を与えるための
    ものであり、DDL も生 SQL も通らない。**`pgSchema` に変えても、実際に発行される
    SQL は1文字も変わらない。**
  - **既存環境を `ALTER TABLE ... SET SCHEMA` で自動的に移す。**探針では移せることを
    実測した（データ・索引・制約・外部キーがすべて追随した）が、**戻せない操作を
    ライブラリが既定で行うことはしない。**移行が要る運用者へは手順を示すに留める。
  - **`0001_init.sql` を編集して `CREATE EXTENSION ... WITH SCHEMA public` にする。**
    置き場所を運用者が選べなくなる（`public` に CREATE 権限が無いロールでは落ちる）。
    加えて、適用済みのマイグレーションの中身を後から書き換える形になる。

- **引き受ける負債**:

  - **`REQUIRED_EXTENSIONS` は `migrations/*.sql` の `CREATE EXTENSION` 行と二重管理である。**
    ⟹ 実ファイルを読んで集合として突き合わせる歯を置き、**ずれたら赤くなる**ようにした。
    二重管理を消したわけではなく、**ずれを検出できる形にした**だけである。
  - **`schema` を指定する経路と指定しない経路で、発行される SQL が違う。**
    既定を1ミリも動かさないという線を優先した結果であり、
    **分岐が消えることは当分無い。**
  - **`schema` 未指定と `schema: "public"` を、advisory lock については同じ対象として扱う。**
    未指定は実行時に `current_schema()` へ落ちるので静的には特定できない。
    **ロックを取りすぎる誤りは無害で、取らなすぎる誤りは壊す**——保守的な側へ倒した。
    ⟹ `search_path` が `public` を指していない環境で `schema` 未指定のまま
    2プロセスが migrate すると、**別スキーマなのに互いを待つ。**
  - **`schema` を指定した接続と指定しない接続を同じ DB に混ぜた場合の挙動を測っていない。**

- **これが覆るとしたら**:

  - **拡張を `public` 以外に置く運用が既定になったとき。**いま `extensionSchema` の既定を
    `public` にしているのは、今日の `CREATE EXTENSION IF NOT EXISTS`（`search_path` 既定
    `"$user", public`）が実際に `public` へ入れているからである。
  - **DML の側に「スキーマを知らなければ書けない SQL」が現れたとき。**
    現状の生 SQL はすべて裸の名前で済んでおり、`search_path` に任せられている。
    クロススキーマの参照や `pg_catalog` を跨ぐ問い合わせが入ったら、
    「DML は触らない」という前提のほうが先に壊れる。
  - **PostgreSQL が既定 operator class の解決規則を変えたとき**（上の測定4行目）。

- **実装の形**:

  | 何 | どこ |
  |---|---|
  | `SchemaNamespaceOptions`（`schema` / `extensionSchema`）・`qualify` / `qualifiedLiteral` / `assertSafeSchemaName` / `searchPathFor` | `packages/postgres/src/schema-namespace.ts`（新規） |
  | `deriveAdvisoryLockKey(seed)` | `packages/postgres/src/advisory-lock.ts` |
  | `REQUIRED_EXTENSIONS` / `migrationLockKeyFor` / `runMigrations` の `schema` 分岐 | `packages/postgres/src/migrate.ts` |
  | `registerEmbeddingSpaceLockKeyFor` / DDL の完全修飾 | `packages/postgres/src/vector-space.ts` |
  | `createPostgresClient(url, { schema })` → startup parameter `options=-c search_path=...` | `packages/postgres/src/client.ts` |

  **`search_path` を毎接続で `SET` するのではなく startup parameter `options` を使う。**
  `options` は接続確立時にサーバへ渡るので、**pool がコネクションを張り直しても自動的に
  適用される**——`connect` イベントで `SET` する形は張り直しの取りこぼしと余計な往復が要る。
  `pg@8.23.0` が `options` を startup parameter として送ることは
  `lib/connection-parameters.js` の `add(params, this, 'options')` と
  `lib/client.js` の `if (params.options) { data.options = params.options }` で確認した。

  **DML は1行も変えていない。**`memory-store.ts` / `vector-store.ts` / `event-store.ts` /
  `outbox-store.ts` / `tenant-settings-store.ts` の生 SQL は裸のテーブル名のままである。

- **確かめたこと / 確かめていないこと**:

  - **確かめた（本物の PostgreSQL 17.11 + pgvector、CI）**: 上の測定表の6行。これは
    *探針*（`schema-namespace-probe.postgres.test.ts`、実装が入った時点で削除）で測った。
  - **確かめた（DB 無しで走る歯22本）**: `qualify` / `assertSafeSchemaName` の 63/64 バイト境界 /
    `searchPathFor` の重複除去 / ロックキーの導出と既定の保存 /
    `REQUIRED_EXTENSIONS` と `migrations/*.sql` の突き合わせ / `createPostgresClient` の
    `options` 組み立て。**8種の変異それぞれで狙った歯だけがアサーションで落ちることを確認した。**
  - **確かめていない**: 探針の測定4行目（`search_path` から `public` を外しても
    `0001_init.sql` が通った）の理由。既定 operator class の解決規則が `search_path` に
    どう依存するかまでは切り分けていない。**この設計はその挙動に依存しない**
    （`extensionSchema` を必ず `search_path` に含める）。
  - **確かめていない**: `schema` を指定した接続と指定しない接続を同じ DB に混ぜた場合の挙動。
  - **確かめていない**: 拡張が `public` 以外（例: `ext`）に既に在る DB で、
    `extensionSchema` を指定し忘れた場合の壊れ方。**`extensionSchema` はそのための口である。**
