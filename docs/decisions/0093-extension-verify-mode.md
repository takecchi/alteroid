# ADR 0093: `CREATE EXTENSION` を発行できないロールのための口 — 「作らない」ではなく「検査する」

- **状態**: 採用 (2026-09)

- **文脈**:

  mnemora は既存の DB へ入れようとする導入者に対して、`CREATE EXTENSION` を勝手に発行し、
  それを飛ばす口を持たない。既存の DB に mnemora を入れる人は、たいてい
  `CREATE EXTENSION` 権限を持たないロールで繋ぐ——**いまの mnemora はそういう導入者を
  構造的に締め出している。**

  ⭐ これは実際に起きている。`virchamate/virchamate-backend` への導入で、DB オーナーが
  承認したのは `btree_gin` と `pgcrypto` の2文だけだった。mnemora は `vector` も要求するので、
  承認された範囲の外に3文目が出る。

  ## 現物を読んで確認した、2つの独立した発行経路

  `CREATE EXTENSION` は1箇所からではなく、独立した2つの経路から発行される。

  - **経路1**（`packages/postgres/src/migrate.ts` の `runMigrations`）: `schema` オプションを
    指定したとき**だけ**、`REQUIRED_EXTENSIONS`（`["vector", "btree_gin", "pgcrypto"]`）を
    `CREATE EXTENSION IF NOT EXISTS <ext> WITH SCHEMA "<extensionSchema>"` として撃つ
    （ADR 0057「専用スキーマ」の一部）。
  - **経路2**（`packages/postgres/migrations/0001_init.sql` 本文）: 冒頭3行
    （`CREATE EXTENSION IF NOT EXISTS vector;` / `btree_gin;` / `pgcrypto;`）が、
    `runMigrations` の `readFileSync` → `client.query(sql)` でファイル全体を逐語実行する
    経路に載っており、**`schema` の有無に関わらず必ず走る。**

  🔴 **経路1だけ塞いでも `vector` は出る。**`migrate.ts` 自身のコメントが、この二重管理を
  「意図的」だと明記している（逐語）:

  > この二重管理は意図的に許してある。`0001_init.sql` は「まっさらな DB へ素の
  > `search_path`（`public` 任せ）で流す」経路の一部としてすでに拡張を要求しており、
  > ここでの `REQUIRED_EXTENSIONS` は「専用スキーマを指定したときだけ、拡張を
  > `extensionSchema` へ事前に用意する」という別の経路のために存在する——どちらか
  > 一方だけに統合すると、統合しなかった側の経路が壊れる。

  この二重管理は `schema-namespace.test.ts`「`REQUIRED_EXTENSIONS` と `migrations/*.sql` の
  突き合わせ」の歯で固定されている（`migrations/*.sql` の `CREATE EXTENSION` 行の集合と
  `REQUIRED_EXTENSIONS` の集合が一致することを検査する）。**この ADR は経路2にも手を
  入れるため、この歯を壊さない設計にする必要がある。**

  ## `0001_init.sql` を編集しない理由（ADR 0057 が既に同じ判断を1度下している）

  マネージャーが提示した案の1つ（3行を `0001_init.sql` から `migrate.ts` 側へ寄せる）は
  検討したが、採らない。理由は2つある。

  1. **出荷済みマイグレーションの編集は、この repo で既に1度却下されている。**
     ADR 0057「採らなかった案」が逐語でこう書いている:
     > `0001_init.sql` を編集して `CREATE EXTENSION ... WITH SCHEMA public` にする。
     > 置き場所を運用者が選べなくなる（`public` に CREATE 権限が無いロールでは落ちる）。
     > 加えて、**適用済みのマイグレーションの中身を後から書き換える形になる。**
     今回の変更は「行を削除して `migrate.ts` へ移す」であり ADR 0057 が却下したのと文字通り
     同じ操作ではないが、**「出荷済み `.sql` ファイルの内容を後から書き換える」という
     性質は同じ**であり、`docs/memory-model.md` §10「規約」が要求する「ベクトル索引の DDL は
     手書きのマイグレーションで管理し、`drizzle-kit push` に任せない」という
     **手書き SQL を正本にする**前提とも相性が悪い——正本を書き換えると、
     過去に何が実行されたかを `migrations/*.sql` から読み取れなくなる。
  2. 🔴 **マネージャーの「既存利用者には無影響のはず」という推測は、この ADR では検証していない
     （採らなかった案なので検証する必要が無かった、というのが正確な言い方である）。**
     `_mnemora_migrations` 台帳はファイル名だけで適用済みを判定する
     （`ensureMigrationsTable` / `handOverLegacyMigrationsTable` を読んで確認した）ので、
     「機構として無影響」という推測自体はおそらく正しい。だが検証していない主張を
     根拠に設計を選ぶな、という指示を受けているので、**この ADR は単純に別の道を選び、
     この推測の当否には立ち入らない。**

- **決定**:

  ## 決定1: ブール値のフラグにしない。「作る」か「検査する」かを選ぶ

  🔴 オーナー（マネージャー経由）が形を決めている: `skipExtensions: true` のような
  素のブール値は **fail-open** である——飛ばした結果、拡張が無いまま先へ進み、
  後段が意味の分からないエラーで落ちる。

  ⟹ `RunMigrationsOptions.extensionMode?: "create" | "verify"`（既定 `"create"`）を足す。

  - `"create"`（既定）: **今日どおり。** `extensionMode` を一切指定しない呼び出しと
    発行される SQL が1バイトも変わらない。
  - `"verify"`: `CREATE EXTENSION` を一切発行しない。代わりに `pg_extension` を読み、
    `REQUIRED_EXTENSIONS` が全て存在することを確認する。1つでも無ければ、
    足りない拡張を名指しし、実行すべき SQL を含めたメッセージで
    {@link MissingExtensionsError} を投げる。

  ## 決定2: 経路1・経路2の両方を、1回の `pg_extension` 確認で塞ぐ

  拡張は**スキーマではなくデータベースに属する**（ADR 0057 の測定表: `CREATE EXTENSION`
  を経路1で `<schema>` の `search_path` の下で撃っても、実際に作られる拡張はデータベース
  全体で1つだけ）。⟹ `schema` の有無に関わらず、DB 全体を対象に1回 `pg_extension` を
  読めば経路1・経路2の両方の必要性を判定できる。

  `runMigrations` の実装（`extensionMode === "verify"` のとき）:

  1. ロック取得より前に `SELECT extname FROM pg_extension WHERE extname = ANY(ARRAY[...])`
     を1回発行する（`assertSafeSchemaName` と同じ理由——不正／不足のためにロックを取って
     他プロセスを待たせる意味が無い）。1つでも足りなければ、ここで
     `MissingExtensionsError` を投げて終わる。**ロック取得もマイグレーション本文の
     送信も一切行わない**（変異なしの実測は下記「確かめたこと」参照）。
  2. 経路1（`schema` を指定したときの `CREATE EXTENSION ... WITH SCHEMA` ループ）は
     丸ごとスキップする（1. で存在を確認済み）。
  3. 経路2（`migrations/*.sql` 本文）は、各ファイルを `client.query()` へ渡す**直前**に、
     `CREATE EXTENSION IF NOT EXISTS <name>;` 単体行だけを取り除いた文字列を渡す
     （`stripCreateExtensionStatements`、下記）。**`migrations/*.sql` のファイル自体は
     1バイトも書き換えない。** 実行時に流す文字列だけが変わる。

  ## 決定3: 経路2の除去は、既存の突き合わせと同じ抽出規則を共有する

  `stripCreateExtensionStatements` は独自の正規表現を新しく書かない。
  `matchCreateExtensionLines`（新規 export、`migrate.ts`）という1つの抽出関数を、
  「除去する」（`stripCreateExtensionStatements`）と「集合を突き合わせる」
  （`schema-namespace.test.ts` の既存の歯、この PR で `matchCreateExtensionLines` を
  呼ぶよう書き換えた）の両方から呼ぶ。正規表現を書き写すと片方だけ直して他方を
  直し忘れるということが起き得るため（`assertSafeSchemaName` の doc と同じ理由、
  `AGENTS.md` の「正典と実装が食い違ったら」と同じ判断）。

  一致条件は「行頭（前後の空白は許す）から `CREATE EXTENSION IF NOT EXISTS <name>;` で
  終わる行そのもの」——現状の `migrations/*.sql`（`0001_init.sql` の3行のみ）の書き方に
  厳密に合わせてある。コメント中の見た目だけ似た文字列や `WITH SCHEMA` 付きの行は
  対象外（そのような行は現状存在しない）。歯（`extension-mode.test.ts`）でこの境界を
  直接固定した。

  ## 決定4: 「無い」の3状態を、例外の型 + 戻り値の両方で表現する

  🔴 「検査していない」「検査したが無かった」「在った」を同じ顔にしない、という要求に対し、
  2つの独立した手がかりを用意した。

  | 状態 | 表現 |
  |---|---|
  | 検査していない | `extensionMode` を指定しない（既定 `"create"`）→ `result.extensionCheck` が `undefined` |
  | 検査したが無かった | `MissingExtensionsError`（`instanceof` で判別できる専用の例外クラス）を投げる |
  | 在った | 例外を投げずに完了し、`result.extensionCheck.verified` に確認できた拡張名の配列が載る |

  `MissingExtensionsError` のメッセージには、足りない拡張の名前と、呼び出し側の DBA が
  そのまま実行できる `CREATE EXTENSION IF NOT EXISTS <ext>[ WITH SCHEMA "<extensionSchema>"];`
  を1行ずつ書く（`extensionSchema` は `schema` を指定していれば付き、していなければ付かない）。

  ## 決定5: CLI にも同じ口を通す（`--extension-mode` / `MNEMORA_EXTENSION_MODE`）

  `packages/postgres/src/bin/cli-options.ts` の既存パターン（`--schema` /
  `--extension-schema` の優先順位: 引数 > 環境変数 > 未指定）に揃え、
  `--extension-mode <create|verify>` / `MNEMORA_EXTENSION_MODE` を足した。
  `--extension-schema` と違い、`--extension-mode` は `--schema` の有無を要求しない
  （`extensionMode: "verify"` は経路2にも効くため、`schema` 未指定でも意味を持つ）。
  `create` / `verify` 以外の値は弾く。

- **検討して採らなかった案**:

  1. **`skipExtensions: true` のような素のブール値。** 却下（決定1、オーナーの線）。
     fail-open——拡張が無いまま先へ進み、後段で意味の分からないエラーになる。
  2. **`0001_init.sql` から3行を削除し、`migrate.ts` 側（`REQUIRED_EXTENSIONS` ループ）へ
     寄せ、`schema` の有無に関わらず常に実行する。** 却下。上の「文脈」節に書いた通り、
     出荷済みマイグレーションの内容を書き換える形になり、ADR 0057 が既に一度
     同種の理由で却下している。マネージャーが提示した「既存利用者には無影響のはず」
     という前提は**検証していない**（採らなかったので検証する必要が無かった）。
  3. **`migrations/*.sql` 全体を読み込み時に「拡張の行を含むかどうか」で分岐する
     複雑な SQL パーサを書く。** 却下。現状の `migrations/*.sql` に必要なのは
     「行頭一致の単純な正規表現」だけであり（決定3の一致条件）、汎用パーサは
     いま存在しない問題（複数行にまたがる `CREATE EXTENSION`、コメントとの同居等）を
     先回りして解く過剰設計になる。境界は歯で固定し、増えたら拡張する。
  4. **経路1だけを塞ぎ、経路2は「`schema` を指定しなければ実害が無い」として放置する。**
     却下。virchamate の実例そのものが `schema` を指定しない既定経路の利用者であり、
     経路2を塞がなければ ADR の動機を1つも解決しない。
  5. **`extensionCheck` を戻り値に持たせず、`instanceof MissingExtensionsError` の
     有無だけで3状態を表現する。** 却下（決定4）。「検査していない」と「検査したが
     在った」はどちらも「例外を投げずに終わる」という同じ観測になり、
     `extensionMode` を渡した記憶が呼び出し側に残っていないと区別できない
     ——戻り値に載せることで、その場で読める形にした。

- **この PR で書いた歯（DB を要するものは CI の `postgres` ジョブが測る）**:

  ⚠ **この節は「歯が何を主張するか」であって、「既に測り終えた」という意味ではない。**
  DB を要する歯は、この器（PostgreSQL・docker・`DATABASE_URL` が無い）では1件も走らせられない
  ——`pgvector/pgvector:pg17` に対して走る CI の `postgres` ジョブが唯一の実測場所である。
  **手元で実際に走らせて緑を確認したのは、下の「手元で実測したこと」に挙げたものだけ。**


  `packages/postgres/src/__tests__/extension-mode.postgres.test.ts`（5本）:

  - **測定1**: 拡張が全部揃っていれば、`extensionMode: "verify"` は `CREATE EXTENSION` を
    一切発行せずに一式（`observations` / `memories` 等）が出来る。
  - **測定1b**: `schema` を指定した専用スキーマ経路（経路1）でも同様——`CREATE SCHEMA` は
    今日どおり発行しつつ `CREATE EXTENSION` は発行しない。
  - **測定2**: `btree_gin` / `pgcrypto` のみ在り `vector` が無い（virchamate の実例そのもの）
    状態で `extensionMode: "verify"` を呼ぶと `MissingExtensionsError`（`missing: ["vector"]`）
    で落ち、DB に何も作らない（`observations` テーブルが存在しない）。
  - **測定3（対照）**: 同じ状況で `extensionMode` 省略（既定）なら、superuser では
    今日どおり成功する——**既定の挙動を変えていないことの直接確認。**
  - **測定4**: `CREATE EXTENSION` 権限を持たない実ロール（`CREATE ROLE ... LOGIN`、
    `public` への `CREATE` を一度 `PUBLIC` から `REVOKE` した上で、このロール自身にだけ
    `GRANT CREATE ON SCHEMA public` を戻したもの——理由は次段落）で、`vector` が
    未設置の状態を再現し:
    - 既定（`"create"`）モードは、`0001_init.sql` 本文の `CREATE EXTENSION vector` が
      生の PostgreSQL の権限エラーで落ちる（**制御されていない失敗**——これが今日の
      mnemora が導入者を締め出す実際の壊れ方）。
    - 同じロール・同じ状況で `extensionMode: "verify"` は制御された
      `MissingExtensionsError` になる。
    - その後 superuser が `vector` を設置すれば（DBA が承認した SQL を実行する運用そのもの）、
      権限を持たない同じロールで `extensionMode: "verify"` が成功し、一式ができる。

  🔴 **`public` への `CREATE` をこのロールへ戻している理由（CI で赤を実際に踏んで直した点）**:
  最初は「このロールは `public` への `CREATE` を一切持たない」で組んだが、CI で
  `permission denied for schema public`（`ensureMigrationsTable` の
  `CREATE TABLE IF NOT EXISTS _mnemora_migrations`）で落ちた——`runMigrations` は
  `extensionMode` に関わらず自分の台帳とアプリのテーブルを作る必要があり、これは
  「`CREATE EXTENSION` が使えない」という制約とは別の、ごく普通の要求だった。
  この戻し（`GRANT CREATE ON SCHEMA public`）が「trusted 拡張なら schema への `CREATE`
  だけで作れてしまう」抜け道を再び開かないかを、CI の実物
  （`pgvector/pgvector:pg17`、`pg_available_extension_versions`）で実測した:

  | name | version | superuser | trusted |
  |---|---|---|---|
  | vector | 0.8.6 | t | **f** |
  | btree_gin | 1.0〜1.3 | t | t |
  | pgcrypto | 1.3 | t | t |

  `vector` は `trusted = false`（superuser 必須、schema への `CREATE` だけでは作れない）
  ——これが測定4a・測定4bの成立条件そのもの。`btree_gin`・`pgcrypto` は `trusted = true`
  だが、測定4・測定5のどちらもこの2つを事前に superuser で用意済みなので、
  trusted であることが挙動に影響することはない。**この設計はもはや
  「trusted かどうかに関わらず失敗する」ではなく、「`vector` が trusted でないことに
  明示的に依存する」——下の「確かめていないこと」もこの変化に合わせて書き直した。**

  ⭐ **PostgreSQL 本体のソースコード（`src/backend/commands/extension.c` の `CreateExtension()`）
  を読んだ限りの主張**:
  `CREATE EXTENSION IF NOT EXISTS x` は、`x` が**既に存在する**場合、
  `get_extension_oid` で既存を検出した時点で NOTICE を出して早期リターンし、
  `CreateExtensionInternal` 内の権限チェック（superuser 判定・対象スキーマへの
  `CREATE` 権限）には**到達しない**。

  🔴 **これは、この ADR の動機の説明を1点だけ訂正する。**「拡張が既に全部揃っている」
  状況では、`extensionMode: "create"`（既定）も実は権限の無いロールで成功してしまう
  （Postgres 自身が早期リターンで権限チェックをスキップするため）。**verify モードが
  この状況で持つ意味は「CREATE EXTENSION 文を一切送らない」こと自体
  （DBA が承認した文以外を送らないという監査・ガバナンス上の要求）であって、
  「揃っている場合に create モードが落ちる」という主張ではない。** verify モードが
  明確に優位なのは、**virchamate の実例のように拡張がまだ設置されていない**状況——
  そこでは `create` モードは生の権限エラーで落ち、`verify` モードは
  足りない拡張名と実行すべき SQL を示す制御されたエラーで落ちる。測定4はこの区別を
  誤魔化さず、両方を対照で示している。

  - **測定5**: `vector` / `btree_gin` / `pgcrypto` が全部既に設置済みの DB に、
    `CREATE EXTENSION` 権限を持たない実ロール（測定4と同じ土台 `ensureRestrictedRole`
    を再利用。別建てのロールは作らない）で接続し、`extensionMode` を省略（既定 `"create"`）
    したまま `runMigrations` を呼ぶと成功する——PostgreSQL の `CreateExtension()` が
    既存の拡張を検出して早期リターンし、権限チェックに到達しないことの直接証拠。
    **CI（`packages/postgres` ジョブ、head `25e8db0`、
    [run 34436157469](https://github.com/takecchi/mnemora/actions/runs/34436157469)）で
    実際に緑になった。**上の「PostgreSQL 本体のソースコードを読んだ限りの主張」は
    ソース読解のままではなく、この歯によって実測に格上げされている。
    ⭐ **この歯は ADR の動機の説明を1点弱める**: 「拡張さえ揃っていれば、既定モードでも
    権限の無いロールで通ってしまう」。verify モードの価値はこの状況には無く、
    拡張が足りない場合（測定2・測定4a）と、承認された `CREATE EXTENSION` 文以外を
    一切送らないという監査・ガバナンス上の要求に在る——上の「決定4直後」の記述と一致する。
    **隠す意図はない**——verify モードの価値が「拡張が足りない場合」と「監査上の要求」に
    在ることは、この ADR がもともと書いていた主張であり、測定5はそれを崩さない。

  `packages/postgres/src/__tests__/extension-mode.test.ts`（DB 無し、13本）:
  `matchCreateExtensionLines` / `stripCreateExtensionStatements` を実ファイル
  （`0001_init.sql`）に対して検査（抽出される名前が `REQUIRED_EXTENSIONS` と同じ集合・
  順序であること、除去後の本文が「既知の3行を独立に filter した結果」と一致すること、
  コメント中の見た目だけ似た行や `WITH SCHEMA` 付きの行は対象外であること）、
  `MissingExtensionsError` のメッセージ内容、`runMigrations` を偽の `Pool`
  （発行 SQL を記録するだけ）に対して呼び、
  - 既定は `extensionCheck` が `undefined` で `CREATE EXTENSION` を今日どおり発行する
  - 全部揃っていれば `CREATE EXTENSION` を1つも発行せずマイグレーション本文
    （`CREATE TABLE observations` を含む）は届く
  - 足りなければ `pg_extension` への1回の問い合わせだけで決着し、
    `pool.connect()`（advisory lock 取得）が一度も呼ばれない

  ことを確認した。`packages/postgres/src/__tests__/cli-options.test.ts` に
  `--extension-mode` / `MNEMORA_EXTENSION_MODE` の解釈（優先順位・不正値の拒否・
  `--schema` との独立性）を9本追加した。

  `pnpm --filter @mnemora/postgres run typecheck` は緑（2回、DB 無しの歯は
  `vitest run` を2回実行しファイル数・件数の一致を確認）。

- **手元で実測したこと（この器には PostgreSQL・docker・`DATABASE_URL` が無いので、DB を要さないものだけ）**:

  - `pnpm --filter @mnemora/postgres run typecheck` → `exit=0`
  - DB 無しの歯 3ファイル（`extension-mode.test.ts` / `cli-options.test.ts` /
    `schema-namespace.test.ts`）を **2回**走らせ、`Test Files 3 passed (3)` /
    `Tests 63 passed (63)` / `exit=0` が2回とも一致することを確認した。
  - **変異試験**（「歯を書く → ベースライン緑を確かめる → 撃つ」の順で実施）:

    | 変異 | 期待 | 実際 |
    |---|---|---|
    | `stripCreateExtensionStatements` を no-op（経路2を塞がない）にする | 赤 | **赤**（4件失敗） |
    | 足りない拡張が在っても `MissingExtensionsError` を投げない | 赤 | **赤**（1件失敗） |
    | （対照）`fetchInstalledExtensions` の内部変数名を変えるだけ | **緑のまま** | **緑**（63件） |

    対照を1本混ぜてあるのは、歯が0本のまま変異試験を回すと**全部「生存」と返り**、
    「まだ歯が足りない」と誤読して回し続けることになるため。

- **CI で実測したこと（PR #123、この器にも DB は無いため、DB を要する歯は CI が唯一の実測場所）**:

  - この PR の当初の push（head `39d1e78`、
    [run 34433449426](https://github.com/takecchi/mnemora/actions/runs/34433449426)）は
    測定4・測定5が「ちょうど 30000ms」で `Test timed out` / `Hook timed out` になり赤だった。
    原因は advisory lock の待ちではなく、node-postgres の接続プール枯渇だった:
    `runMigrations` は advisory lock 用のコネクションを1本 `pool.connect()` で
    処理の最後まで保持したまま、本体の DDL 用にもう1本を要求する
    （`packages/postgres/src/advisory-lock.ts` の `acquireAdvisoryLock`）。
    測定4・5の `restrictedPool` を `max: 1` にしていたため2本目の要求がプールの
    空きキューに積まれ、`connectionTimeoutMillis` 未設定のこのプールでは待ちに
    上限が無く、事実上永久に固まっていた（vitest の `testTimeout: 30_000` が
    それを外側から30秒で打ち切っていただけ）。`max: 2` に直して解消
    （`migrate-concurrency.test.ts` の同種のロールが `max: 1` のままで問題にならないのは、
    そちらは `pg_advisory_lock` の EXECUTE 権限自体を剥奪していて1本目の要求で
    即座に権限エラーになり、2本目を要求する手前で終わるため）。
  - この直後に別の実在するエラーが出た: `permission denied for schema public`
    （`ensureMigrationsTable` の `CREATE TABLE IF NOT EXISTS _mnemora_migrations`、
    `migrate.ts:366`）。上の「`public` への `CREATE` をこのロールへ戻している理由」節の
    経緯そのもの。
  - 両方を直した head `25e8db0`
    （[run 34436157469](https://github.com/takecchi/mnemora/actions/runs/34436157469)）で
    5ジョブ全部が緑になった。PR の `headRefOid` と run の `head_sha` を40桁で
    突き合わせ済み。
  - **CI での変異試験**（測定5専用の `GRANT CREATE ON SCHEMA public` を1行コメントアウトし
    push → 確認 → revert の順で実施、head `03b8aee` →
    [run 34435885674](https://github.com/takecchi/mnemora/actions/runs/34435885674)）:

    | 変異 | 期待 | 実際 |
    |---|---|---|
    | 測定5の `GRANT CREATE ON SCHEMA public` を外す | 測定5だけ赤 | **測定5だけ赤**（`permission denied for schema public`、92ms・ハングではない） |
    | （対照）測定1/1b/2/3/4 は無関係のまま | **緑のまま** | **緑**（5本とも、ハング無し） |

    revert 後（head `25e8db0`）に全ジョブ緑を再確認し、`git status` で変異が
    ツリーに残っていないことも確認した。

- **確かめていないこと**:

  - **案2（`0001_init.sql` の編集）の「既存利用者には無影響のはず」という推測の当否。**
    採らなかった案なので検証していない。
  - **`extensionMode: "verify"` を、DB オーナーが実際に btree_gin/pgcrypto だけを承認した
    本物の virchamate の DB に対して走らせたか。** 走らせていない——測定2・4は
    「その状況を模した使い捨ての DB」であり、virchamate 自身の環境ではない。
  - **PostgreSQL のバージョンによる `CreateExtension()` の早期リターンの挙動差。**
    確認したのは PostgreSQL 17（CI の `pgvector/pgvector:pg17`）のソースコード1点のみ。
    より古い/新しいバージョンで同じ順序かは確認していない。
  - ~~`vector` 拡張が "trusted" フラグを持つかどうか~~ →
    **実測済み（CI の `pgvector/pgvector:pg17`、`pg_available_extension_versions`）**:
    `vector 0.8.6` は `superuser = t` / `trusted = f`、`btree_gin`・`pgcrypto` は
    `trusted = t`。この結果、測定4・測定5のロールには `public` への `CREATE` を
    戻してある（自分のテーブルを作るため）——設計はもはや「`public` への `CREATE` を
    丸ごと剥奪して trusted かどうかに関わらず失敗させる」ではなく、
    「`vector` が trusted でないことに明示的に依存する」に変わった。
    **確かめていない残り**: この trusted 値は pgvector 0.8.6・PostgreSQL 17 の組の
    ものであり、pgvector や PostgreSQL のバージョンが変わっても同じ値である保証はない
    （pgvector 側が将来 `trusted = true` に変えれば、測定4a・4bの前提——このロールが
    `vector` を自力で作れないこと——が崩れる。その変化を検出する歯は無い）。
  - **`migrations/*.sql` に将来 `WITH SCHEMA` 付きや複数行にまたがる `CREATE EXTENSION`
    が増えた場合の挙動。** 決定3の一致条件はそれらを対象外とする（除去されず、
    verify モードでも送信される）。負債として残す。

- **引き受ける負債**:

  1. `stripCreateExtensionStatements` の一致条件は現状の `migrations/*.sql` の書き方
     （単体行・`WITH SCHEMA` 無し）専用であり、汎用の SQL パーサではない。将来
     この形を外れる `CREATE EXTENSION` が増えたら、この関数と `matchCreateExtensionLines`
     の両方を拡張する必要がある（歯 `extension-mode.test.ts` の否定側テストが、
     拡張を怠ったことを検出する）。
  2. `extensionMode: "verify"` は `pg_extension` の存在確認のみを行い、
     バージョン（`extversion`）や設置先スキーマの一致までは検査しない——「存在するか」
     だけを見る。将来「特定バージョン以上が要る」という要求が生まれたら再設計が要る。
