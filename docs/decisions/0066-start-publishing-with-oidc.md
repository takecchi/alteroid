# ADR 0066: publish を始める。梱包は pnpm・アップロードは npm（Trusted Publishing / OIDC）

- **状態**: 採用 (2026-09)

- **⚠ この ADR が決めたこと・決めていないこと（先に書く）**:

  | | |
  |---|---|
  | **決めた** | publish を始める（対象4パッケージから `private: true` を外す）。梱包は pnpm・アップロードは npm に分ける。tag `v*` を引き金に GitHub Actions から Trusted Publishing (OIDC) で出す。初回 `0.1.0` は手元から出す |
  | **決めた（梱包の欠陥4件）** | `@types/pg` を `dependencies` へ / `workspace:*` → `workspace:^` / `exports` を4つに足す / `testkit` の `vitest` を `peerDependencies` へ |
  | **やった（この ADR の後）** | **`0.1.0` を4パッケージとも実際に publish した。**段0（手元から automation token で）を実行済み。⟹ registry に実体が在る。**取り消せない**（同じ版を上書きできない） |
  | **⚠ 引き受けてしまった** | **npm 上の `0.1.0` は、この ADR が入る commit の中身と一致しない。**未コミットの作業ツリーから梱包したうえ、その後 main が進んだためである（測ったこと10） |
  | **決めていない** | 個別に版を進める運用（ADR 0060 が残した負債のまま。4つ揃えて上げる） |

- **文脈**:

  ADR 0060（梱包を整える）と ADR 0061（ライセンスを MIT にする）は、いずれも
  **「`private: true` を外すこと（= publish を始めること）は別の判断である」**として
  意図的に手を付けずに終わっていた。ADR 0060 はさらに
  「その判断が下って `private` が外れたら、この歯は目的通りに壊れて直され直す」と
  **予告**していた（`scripts/__tests__/check-publish-pack.test.mjs` のラッチの歯）。

  オーナーへの逐語の問いと回答:

  > **問い**: publish はどの経路で打ちますか。(a) 手元から `pnpm publish -r` /
  > (b) GitHub Actions + Trusted Publishing / (c) 両方（初回は手元、以後は CI）。
  >
  > **オーナーの回答**: 「GitHub Actions + Trusted Publishing」

  > **問い**: 初回 0.1.0 を出す前に直すものはどれですか（複数選択）。
  >
  > **オーナーの回答**: 「`@types/pg` を dependencies へ / `workspace:*` → `workspace:^` /
  > `exports` フィールドを4つに足す / `testkit` の `vitest` を peerDependencies へ」（4つすべて）

  **これはオーナーの決定である。**

- **⭐ 測ったこと1 — pack → install → import の往復（ADR 0060 が「確かめていない」と書いた点）**

  ADR 0060 は「publish 後の tarball を素の consumer が install して `import` できること」を
  **確かめていない**と明記していた。この器で実測した:

  | 測ったこと | 結果 |
  |---|---|
  | 4つを `pnpm pack` → 素の `npm install <tarball>` ×4 | **成功**（58 packages、`EUNSUPPORTEDPROTOCOL` は出ない） |
  | 4つを `import` | **成功**（core 68 / testkit 20 / openai 3 / postgres 35 の export が読める） |
  | `moduleResolution: nodenext` での型解決 | **成功** |
  | `exports` を足した後に同じ往復をやり直し | **成功**。`DEFAULT_MIGRATIONS_DIR` が tarball 内の `package/migrations/` を指し、`0001_init.sql` 〜 `0003_*.sql` が実在する。`@mnemora/core/package.json` の subpath も通る |

  **⟹ ADR 0060 が「別の調査の報告であって再導出していない」としていた点は、これで実測に置き換わった。**

- **⭐ 測ったこと2 — `@types/pg` が devDependencies に在ることは、使う側の型を壊す**

  `@mnemora/postgres` の**公開 `.d.ts` が `pg` の型を露出している**:

  ```
  packages/postgres/dist/client.d.ts:1: import { Pool, type PoolConfig } from "pg";
  packages/postgres/dist/client.d.ts:7:     pool: Pool;
  ```

  にもかかわらず `@types/pg` は `devDependencies` にあった（= tarball の依存に載らない）。
  素の consumer で実測した:

  | consumer の設定 | 修正前 | 修正後（`@types/pg` を `dependencies` へ） |
  |---|---|---|
  | `skipLibCheck: false` | **`TS7016` が4件**（`@mnemora/postgres` 自身の `.d.ts` で「`pg` の宣言が見つからない」） | 出ない |
  | `skipLibCheck: true`（一般的な設定） | **エラー無し。ただし型は黙って `any` に落ちる** | 実型が付く |

  修正後、consumer が `@types/pg` を**一切書かずに**次が通ることを確認した——
  `@ts-expect-error` の行が実際に効く（= `any` に落ちていない）ことが証拠である:

  ```ts
  const client = createPostgresClient("postgres://x", { max: 5, idleTimeoutMillis: 1000 });
  const rowCount: number = client.pool.totalCount;
  // @ts-expect-error pg の PoolConfig に存在しないキーは弾かれる
  createPostgresClient("postgres://x", { thisKeyDoesNotExistInPoolConfig: 1 });
  ```

  **同じ種類の欠陥が他に無いことも機械的に洗った**——4パッケージの `dist/**` の
  `import ... from "<外部>"` を全部集め、`dependencies` / `peerDependencies` と突き合わせた。
  `pg` の1件以外はすべて宣言済みだった（`zod` / `drizzle-orm` / `openai` / `vitest` / `@mnemora/core`）。

- **⭐ 測ったこと3 — `pnpm` と Trusted Publishing は噛み合わない**

  | 測ったこと | 実測 |
  |---|---|
  | `pnpm publish --help` の `--provenance` | **無い**（`pnpm` 11.25.0） |
  | `npm publish --help` の `--provenance` | **在る**（`npm` 11.12.1） |
  | [pnpm/pnpm#9812](https://github.com/pnpm/pnpm/issues/9812)（OIDC 対応） | **CLOSED**（2025-07-30）。閉じた理由は「`pnpm publish` は内部で `npm publish` を呼ぶので、npm CLI を上げれば動く」 |
  | 同スレッドの報告 | **「GH runner・node 24・npm 11.6 で `pnpm publish` は通らず、素の `npm publish` に落としたら通った」**（他の利用者の報告） |
  | [npm/cli#8544](https://github.com/npm/cli/issues/8544)（初版を OIDC で出せるようにする） | **OPEN**（最終更新 2026-08-05） |
  | `npm view @mnemora/core version` | **E404**（= 初回 publish である） |

  **⟹ 2つの帰結がある。**

  1. **アップロードは npm CLI で打つ。**`pnpm publish` に賭けると、provenance は打てず、
     OIDC も他人の器では通らなかったという報告がある。
  2. **初回 `0.1.0` は Trusted Publishing では出せない。**信頼発行元の設定は
     npmjs.com のパッケージ設定画面で行うため、**パッケージが存在しないと設定できない。**

- **決定**:

  **1. 対象4パッケージから `private: true` を外す。**

  ルートの `mnemora` と `@mnemora/example-chat` には**残す**（publish 対象外。ADR 0060 決定1）。

  **2. 梱包は pnpm、アップロードは npm に分ける。**（ADR 0060 決定3 を狭める）

  | 仕事 | 道具 | なぜ |
  |---|---|---|
  | 梱包（`pack`） | **pnpm** | `workspace:` を実版へ置換できるのは pnpm だけ（ADR 0060 の実測。この根拠は今も有効） |
  | アップロード（`publish`） | **npm** | Trusted Publishing (OIDC) と provenance は npm CLI の側にしかない（測ったこと3） |

  `npm publish <tarball>` は**すでに解決済みの manifest を持つ tarball** を上げるだけなので、
  `workspace:` を見ることが無い——**ADR 0060 が塞いだ穴は、この分割では開かない。**
  これが「npm を使うと `workspace:` が漏れる」と「pnpm では OIDC が打てない」の両方を同時に満たす形である。

  **3. `.github/workflows/publish.yml` を足す。**引き金は **GitHub Release の `published`**
  （+ 予行用の `workflow_dispatch`）。

  **⚠ `push: tags` は使わない。**Releases の UI から Release を作ると tag も同時に作られるため、
  両方を引き金にすると**同じ版で2本走る**。後から走ったほうは「既に上がっている版を飛ばす」に
  落ちて緑になるので事故にはならないが、**どちらが本物の publish だったのか読めなくなる。**
  ⟹ 素の `git push origin v0.1.1` では publish されない。**Release を作ることが表明である**
  ——そしてその表明が、リリースノートと一緒に GitHub 上に残る。

  ADR 0060 は「publish を始める判断がまだ無い。**引き金だけ先に作らない**」として
  workflow を見送っていた。判断が下ったので、ここで足す。中でやること:

  | 段 | 何を押さえるか |
  |---|---|
  | `npm install -g npm@latest` | Trusted Publishing は **npm >= 11.5.1**。Node 22 同梱の npm 10.x では OIDC の交換を実装しておらず、**「トークンが無い」の顔をして 401 で落ちる** |
  | `id-token: write` | これが無いと OIDC の token を発行できない |
  | Release の tag が `origin/main` の履歴上に在ることの検査 | **`ci.yml` は `push: branches: [main]` と `pull_request` にしか反応しない**——main を通っていない commit から Release を作れば、検査を1つも通らずに publish へ到達できてしまう。ここで main を通った commit であることに依拠する |
  | 非 DB の門を全部通す（typecheck / lint / format / test / build / **pack:check**） | 同上。DB を要する検査は main の CI（本物の Postgres の3ジョブ）に依拠する |
  | `scripts/pack-publish-targets.mjs --expect-version <tag の版>` | tag `v0.1.1` と `package.json` の `0.1.0` のずれを掴む |
  | 依存の向きの順に `npm publish <tarball> --access public --provenance` | 順序を誤ると使う側が E404 を見る（ADR 0060 の負債） |
  | 既に上がっている版を飛ばす（E403 `cannot publish over` を「上がっていた」と受ける） | 4本の途中で1本落ちたとき、**そのまま再実行すると1本目の E403 で再開できない**。飛ばせば続きから再開できる。版の取り違えは `--expect-version` が別に見ている |
  | pre-release の Release は `--tag next` へ振る | **GitHub は pre-release でも `published` を発火させる。**振り分けないと beta が `latest` になり、`npm i @mnemora/core` が beta を掴む |
  | `concurrency` で同じ版の並走を止める（`cancel-in-progress: false`） | Release の編集で `published` が再発火する場合に備える。**途中で殺さない**——4本のうち2本だけ上がった状態を作りうる |

  **4. publish 順序を、書ける場所に1つだけ置く。**

  ADR 0060 は「publish の順序は依存の向きで決まる（`core` → `testkit` / `openai` → `postgres`）。
  **これを守らせる仕掛けはまだ無い**」を負債として残していた。`scripts/publish-targets.mjs` の
  **配列の順序**をその仕掛けにした。加えて `scripts/__tests__/publish-targets.test.mjs` が
  **「各パッケージの `@mnemora/*` 依存が、自分より前に並んでいること」を各 package.json の
  現物から検査する**——正解の並びを歯に書き写すのではなく、**依存の向きから順序の妥当性を導く**。
  パッケージが増えても歯を書き換える必要が無い。

  同時に、対象4つのリストを1箇所へ集めた。それまで門（`check-publish-pack.mjs`）と
  歯の2箇所に写しが在り、workflow を足すと**3箇所目**が生まれるところだった。
  **門と workflow が同じリストを見ていることが、「門を通ったものだけが publish される」の前提である。**
  歯の側の直書きの写しは**残した**（独立した突き合わせとして意味がある）が、
  中身がずれたまま気づかないのは意図ではないので、集合として一致することを歯で押さえた。

  **5. 梱包の欠陥4件を、初回 publish の前に直す。**

  | 直したもの | なぜ「後で」ではなく「初回の前」なのか |
  |---|---|
  | `@types/pg` を `dependencies` へ | 測ったこと2。後から直すと 0.1.1 が必要になり、0.1.0 を掴んだ人の型は壊れたまま |
  | `workspace:*` → `workspace:^` | `pnpm pack` は `workspace:*` を**厳密な `0.1.0`** に置換する（実測）。`workspace:^` なら `^0.1.0` になる。厳密な版のまま出すと、`core` の patch を出した日に consumer の `node_modules` へ `core` が二重に入る |
  | `exports` を4つに足す | **`exports` を後から足すと、それまで解決できていた deep import（`@mnemora/core/dist/...`）が塞がる**——使う側から見れば破壊的変更である。まだ誰も掴んでいない今しか、無害には入れられない |
  | `testkit` の `vitest` を `peerDependencies` へ | 使う側の vitest と testkit が引き込む vitest が並ぶと、`describe` の実体が食い違って**「テストが1本も見つからない」形**で壊れうる。これも後から直せば破壊的変更になる |

  `main` / `types` は**消さずに残した**（`exports` を見ない古い道具向けの後退路）。

  **6. 門に検査項目を2つ足す（既存の門を拡張。新しい仕組みは作らない）。**

  | 足した検査 | なぜ必要か |
  |---|---|
  | `exports` の指す先が tarball 内に実在すること（`findMissingEntryPoints` を拡張） | **Node と TypeScript は `exports` が在れば `main` / `types` を見ない。**`exports` の先だけが欠けた tarball は、`main` が実在するかぎり**門の旧版を素通りしたうえで**使う側で `ERR_MODULE_NOT_FOUND` になる。**今の入口を測らずに、後退路だけを測っている**状態だった |
  | `private` が立っていないこと（`findPrivateViolations`） | これが守るのは publish の失敗ではない——`private: true` なら publish は**止まる**（事故にはならない）。守るのは **`private` の状態と「publish してよい」という明示的な決定が一致していること** |

- **⭐ 測ったこと4 — 手元の `pack:check` は、clean checkout では出ない形で赤くなる**

  この PR の作業を始めた時点で、**手元の `pnpm run pack:check` は赤かった**——
  `dist/` に ADR 0060 以前のビルドが残した `.map` が**30本**居残っており、
  `findOrphanedSourceMaps` がそれを全部検出した。

  原因は `tsc` が `outDir` を掃除しないことである。`tsconfig.build.json` で
  `declarationMap` / `sourceMap` を `false` にした（ADR 0060 決定6）のは
  **これから出る map を止めただけ**で、**すでに出ていた map は消えない。**
  `rm -rf packages/*/dist && pnpm run build` で緑に戻ることを確認した。

  **CI ではこれは起きない**（clean checkout に古い `dist` が無い）。
  **⟹ 「CI が緑だから手元も緑」は成り立たない向きの非対称である。**
  この ADR では `build` に clean 段を足していない（下の「引き受けた負債」参照）。

- **⭐ 測ったこと8 — 実際に publish して分かった2つ（段0 の実行記録）**

  **1. `npm login` 済みでも publish は `EOTP` で止まる。**

  オーナーが `npm login` を済ませ（`npm whoami` → `takecchi`）、段0 のループを打った結果:

  ```
  npm error code EOTP
  npm error This operation requires a one-time password.
  ```

  **4パッケージとも同じ形で失敗した。**アカウントの 2FA が書き込みにも掛かっているためである。
  この ADR が最初に書いた段0 の手順には `--otp` も token も無く、**そのままでは通らなかった。**

  さらに、この ADR が最初に書いたループには `set -e` が無く、**4つの失敗を全部飲み込んで完走した。**
  1つだけ成功していたら、再実行で `E403` になって話が分かりにくくなるところだった。
  ⟹ 段0 の手順を、**失敗したら止まり・既に上がっているものは飛ばす**形に差し替えた。

  解決は automation token（2FA を迂回する種類）である。オーナーが作成し、
  作業者が `--userconfig` で渡した一時 `.npmrc`（`chmod 600`）から使い、**publish 後に削除した**
  （リポジトリ・`~/.npmrc`・`~/.npm/_logs/` に素のトークンが残っていないことを `grep` で確認した）。

  **2. registry の読み取り側は、書き込みに数分遅れる。CDN を迂回しても遅れる。**

  `@mnemora/core` の publish が `+ @mnemora/core@0.1.0`（成功）を返した**直後**に確認したところ:

  | 確認の口 | 結果 |
  |---|---|
  | `npm view @mnemora/core version` | **E404** |
  | `npm view --prefer-online`（キャッシュを使わない） | **E404** |
  | `curl https://registry.npmjs.org/@mnemora%2Fcore` | **HTTP 404** `{"error":"Not found"}` |
  | `curl .../@mnemora%2Fcore?write=true`（**CDN を迂回する口**） | **HTTP 404** |
  | `npm publish` を同じ tarball でもう一度 | `E403 **You cannot publish over the previously published versions: 0.1.0**` |

  **⟹ publish は成功していた。**読み取り側の 404 は嘘であり、
  **「publish 直後に `npm view` で確認する」は成立しない検査である。**

  作業者はこの検査をループの中に入れていたため、**core の後でループを止めてしまった**
  （publish 自体は成功していたので、実害は「残り3本を別の実行で出した」ことだけである）。
  **publish の成否は `npm publish` の終了状態と出力で判断し、読み取り側の見え方で判断しない。**

  実際に上がったもの:

  | パッケージ | 結果 |
  |---|---|
  | `@mnemora/core@0.1.0` | `+`（初回のループで成功。読み取り側が遅れていた） |
  | `@mnemora/testkit@0.1.0` | `+` |
  | `@mnemora/openai@0.1.0` | `+` |
  | `@mnemora/postgres@0.1.0` | `+` |

  **⚠ この4つに provenance は付いていない**（OIDC ではなく token で出したため。予告どおり）。

- **⭐ 測ったこと10 — npm 上の `0.1.0` は、この ADR が入る commit と一致しない**

  段0 は**未コミットの作業ツリーから**梱包して publish した。その時点の main は `da44116` だったが、
  この ADR を PR に載せる間に main が進み、**publish される中身が変わった。**

  **⚠ この食い違いは、`0.1.1` を出すまで開き続ける**——main へ入る変更のうち
  `dist` や `migrations` に載るものはすべて、npm 上の `0.1.0` には入っていない。
  下の表は「この ADR を書いた時点で確認できたもの」であって、**完全な一覧ではない。**

  npm から `@mnemora/postgres@0.1.0` の tarball を取り寄せて、ツリーと突き合わせた:

  | | npm 上の `0.1.0` | この commit |
  |---|---|---|
  | `packages/postgres/migrations/` | `0001` / `0002` / `0003` | `0001`〜**`0005`**（`0004_contested_with_index.sql` と `0005_analyze_memories.sql` が増えた） |
  | `LICENSE` の著作権行（4パッケージとも） | `Copyright (c) 2026 Takeaki Kobayashi` | `Copyright (c) 2026 takecchi`（#74） |
  | `testkit` の `vector-store-conformance` | space 分離の歯を持たない | 持つ（#75。ADR 0065） |

  **⟹ `@mnemora/postgres@0.1.0` を install して `mnemora-postgres-migrate` を打った人は、
  `0004`（`contested_with_id` の索引。ADR 0062）と `0005`（式索引の ANALYZE）が
  当たらないスキーマを得る。**

  **なぜこうなったか**: 「梱包して publish する」と「その中身を commit する」が別の時点になっていた。
  `--expect-version` は**版の一致**を見るが、**ツリーが commit されているかどうかは見ていない。**

  **どう直すか**: `0.1.0` は上書きできないので、**`0.1.1` を Release 経路で出すことで直す**
  （そちらには 0004 / 0005 と新しい LICENSE が入り、provenance も付く）。
  **同じことが再発しないようにする仕掛けは、この ADR では入れていない**（下の負債）。

- **測ったこと9 — publish 段の3分岐を、npm の実出力を再現して走らせた**

  workflow の publish 段は3つに分岐する。**`npm publish` を CI 以外で打てないため、
  今回のセッションで実際に観測した npm の出力を再現して shell を走らせた。**

  | 場合 | 与えた出力（実観測） | 期待 | 結果 |
  |---|---|---|---|
  | 成功 | `+ @mnemora/core@0.1.0` / exit 0 | 続行 | ✔ exit 0 |
  | 既に上がっている | `E403 ... You cannot publish over the previously published versions: 0.1.0.` / exit 1 | **飛ばして続行** | ✔ exit 0 |
  | 本物の失敗 | `EOTP This operation requires a one-time password.` / exit 1 | **止まる** | ✔ exit 1 |

  **⚠ これは分岐の検証であって、`npm publish` の検証ではない。**
  与えた出力は実観測のものだが、**それを返したのは npm ではなく再現用の変数である。**

  版と dist-tag を決める段も、3つの場合で走らせた:

  | 場合 | 入力 | 版 | dist-tag |
  |---|---|---|---|
  | 通常の Release | `v0.1.1` / `prerelease=false` | `0.1.1` | `latest` |
  | pre-release | `v0.2.0-beta.1` / `prerelease=true` | `0.2.0-beta.1` | **`next`** |
  | `workflow_dispatch`（予行） | — | `0.1.0`（package.json から） | `latest` |

- **測ったこと5 — 変異試験**

  | # | 変異 | 結果 |
  |---|---|---|
  | 1 | `packages/core` に `private: true` を戻す | 赤くなったのは **2本だけ**——core の静的な歯と、動的な門。他3パッケージの同じ歯は緑のまま（変異を入れたパッケージだけが落ちる） |
  | 2 | `packages/openai` の `exports.default` を実在しない先へ | 同じく **2本**（openai の静的な歯と動的な門）。**この変異は ADR 0066 以前の門では検出できなかった**——`main` は実在したままなので |
  | 3 | `findPrivateViolations` を `return []` に潰す | 「検出する」側の1件が赤。「検出しない」側は `[]` と `[]` の比較で緑のまま（ADR 0060・0061 の同種の変異と同じ形の偽陰性） |
  | 4 | `findMissingEntryPoints` の `exports` 走査を潰す | `exports` の歯 **3本**が赤（条件付き形・subpath のラベル・配列形） |
  | 5 | `PUBLISH_TARGETS` で `postgres` を `core` より前に並べる | 順序の歯が赤。メッセージは `@mnemora/postgres（0番目）より後に @mnemora/core（1番目）を publish すると、使う側が install で E404 を見る` |
  | 6 | `PUBLISH_TARGETS` から `openai` を消す | **2本**（件数の歯と、歯の側の直書きリストとの突き合わせ） |
  | 7 | workflow から `id-token: write` を落とす | 1本（OIDC の歯） |
  | 8 | workflow の `npm publish` を `pnpm publish` に差し替える | 1本（決定2 の配線を見る歯） |
  | 9 | `publish.yml` を `release.yml` へ改名する | **4本**（workflow を見る歯すべて） |
  | 10 | workflow から「既に上がっている版を飛ばす」分岐を消す | 1本（冪等の歯） |

  変異はすべて元に戻し、`git status` / `git diff` で残っていないことを確認した。

- **⭐ 測ったこと6 — workflow は、書いた時点で2箇所壊れていた**

  `.github/workflows/publish.yml` を書いたあと、**YAML パーサに通し、shell 段を手元で実行して**
  検証した。**そのどちらも本物の壊れを1件ずつ見つけた**——目で読んでは通っていたものである。

  | # | 壊れ | どう見つけたか | 実際の失敗の形 |
  |---|---|---|---|
  | 1 | step 名 `pnpm pack（workspace: を実版へ置換できるのは pnpm だけ）` に `:` + 空白が入っており、YAML がそこをマッピングとして読む | YAML パーサ（`YAMLParseError: Nested mappings are not allowed in compact mappings at line 111`） | **workflow が構文エラーで一切走らない** |
  | 2 | `git fetch origin main --depth=0` | 手元で実行（`fatal: depth 0 is not a positive number`） | `set -euo pipefail` の下で **tag 検査の段が必ず落ちる** |

  併せて、この検査が依拠している git の意味も実測した——
  `git merge-base --is-ancestor HEAD HEAD` が真である（**git は commit を自分自身の祖先と見る**）。
  これが偽なら、main の tip に打った tag が検査で弾かれていた。

  shell 段（版の取り出し・publish の loop）は `npm publish` を `echo` に差し替えて実際に走らせ、
  publish 順が `core → testkit → openai → postgres` になることを出力で確認した。

  **⟹ 「YAML を目で読んで正しそうだった」は、この2件のどちらも捕まえられなかった。**

- **測ったこと7 — 作業中の事故**

  **⚠ この過程で作業者が事故を1つ起こした**: 変異を `git checkout <file>` で戻したところ、
  **同じファイルの未コミットの編集も一緒に消えた**（`packages/core/package.json` /
  `packages/openai/package.json` / `scripts/publish-pack-checks.mjs`）。
  再適用して復旧し、以降の変異は退避コピーから戻した。
  **未コミットの作業ツリーに対して変異試験をするときは、`git checkout` を戻し手段にしない。**

- **publish の手順（オーナーが打つ）**:

  **段0. 初回 `0.1.0` を手元から出す**（この1回だけ OIDC を使えない。測ったこと3）

  **⚠ 実際にやったときは `npm login` だけでは通らなかった**（下の「測ったこと8」）。
  automation token が要る。

  **これは実際に打った手順である**（2026-09-08。測ったこと8 に結果がある）。

  ```bash
  # 1. 認証。npm login だけでは書き込みが EOTP で止まる（測ったこと8）。
  #    npmjs.com で automation token（2FA を迂回する種類）を作り、一時 .npmrc に置く。
  #    ⚠ publish 後に「削除」と「失効」の両方をすること。
  NPMRC=$(mktemp)
  chmod 600 "$NPMRC"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$YOUR_AUTOMATION_TOKEN" > "$NPMRC"
  npm whoami --userconfig "$NPMRC"       # 誰として認証されるかを確認

  # 2. 梱包。dist の居残りを消してから（測ったこと4）。
  rm -rf packages/*/dist
  pnpm install --frozen-lockfile
  pnpm run test && pnpm run build && pnpm run pack:check
  node scripts/pack-publish-targets.mjs /tmp/mnemora-tarballs --expect-version 0.1.0

  # 3. 依存の向きの順に上げる。
  #    ⚠ set -e が要る——無いと4つの失敗を飲み込んで完走する（測ったこと8）。
  #    ⚠ publish の成否は npm publish の出力で判断する。読み取り側（npm view）は数分遅れる。
  set -euo pipefail
  for p in core testkit openai postgres; do
    T="/tmp/mnemora-tarballs/mnemora-$p/mnemora-$p-0.1.0.tgz"
    OUT=$(npm publish "$T" --access public --userconfig "$NPMRC" 2>&1 | grep -v '^npm notice')
    if   echo "$OUT" | grep -q "^+ @mnemora/$p@0.1.0";                          then echo "✔ @mnemora/$p 上がった"
    elif echo "$OUT" | grep -q "cannot publish over the previously published";  then echo "✔ @mnemora/$p 既に上がっていた"
    else echo "✗ @mnemora/$p 失敗"; echo "$OUT"; exit 1
    fi
  done

  # 4. 後片付け。
  rm -f "$NPMRC"
  ```

  **⚠ この経路の 0.1.0 には provenance が付かない**（OIDC ではないため）。

  **段1. npmjs.com で信頼発行元を設定する**（4パッケージそれぞれ）

  `https://www.npmjs.com/package/@mnemora/<名前>/access` で、次を登録する:

  | 項目 | 値 |
  |---|---|
  | Organization / user | `takecchi` |
  | Repository | `mnemora` |
  | Workflow filename | **`publish.yml`** |

  **⚠ workflow のファイル名まで一致が要る。**`.github/workflows/publish.yml` を改名すると
  publish は 403 で止まる（その旨は workflow の冒頭にも書いてある）。

  **⚠ npm は保存時に設定を検証しない**（npm の文書に明記）。repo 名や workflow 名を間違えても
  保存でき、**publish を打った瞬間に初めてエラーになる。**⟹ 段2 の予行を必ず通すこと。

  **Web UI の代わりに CLI でも打てる**（`npm trust`。npm 11.10.0 以降）。
  `npm login` の資格があればトークンを新しく作る必要は無く、2FA の OTP だけが要る:

  ```bash
  for p in core testkit openai postgres; do
    npm trust github "@mnemora/$p" --repo takecchi/mnemora --file publish.yml --yes --otp <6桁>
  done
  npm trust list @mnemora/core     # 確認
  ```

  **設定したあと、npm のパッケージ設定で「Require two-factor authentication and disallow tokens」を
  選ぶことを npm 自身が勧めている**——選べば、段0 で使った automation token は publish に使えなくなる。

  **段2. 予行する**（registry には何も上がらない）

  Actions から `Publish` を `workflow_dispatch` で、`dry_run` を `true`（既定）で走らせる。

  **段3. 以後の版は GitHub Release を作るだけ**

  1. 4パッケージの `version` を上げて（4つとも同じ版に揃える）、PR を出して **main へ入れる**。
  2. GitHub の Releases から **`v<版>` の Release を作って publish する**
     （tag は Release 作成時に一緒に作られる）。破壊的でない試し版なら
     **pre-release にチェックを入れる**——`latest` ではなく `next` に入る。

  **⚠ `git push origin v0.1.1` だけでは publish されない**（`push: tags` を引き金にしていない）。

  **⚠ `v0.1.0` の Release は作らないこと。**`0.1.0` は段0 で既に上がっており、
  同じ版は上書きできない。Release を作っても「既に在る」で飛ばされて緑になるだけで、
  **provenance の付いた 0.1.0 にはならない。**次の版から OIDC の経路に乗る。

- **採らなかった案**:

  | 案 | 却下の理由 |
  |---|---|
  | **`pnpm publish -r` を CI で使う（pnpm に統一を保つ）** | `--provenance` が無く、OIDC も「他人の器で通らなかった」報告がある（測ったこと3）。**ADR 0060 決定3 の理由（`workspace:` の置換）は梱包にしか掛かっていない**——アップロードまで pnpm に縛る根拠は元から無かった |
  | **`npm publish -w`（npm の workspaces 機能）で出す** | `npm` は `workspace:*` を置換しない。ADR 0060 が実測した穴がそのまま開く |
  | **publish の直前に `workspace:*` を書き換える自作スクリプト** | ADR 0060 が却下済み（置換の正しさを自分で保証する負債が増える）。`pnpm pack` → `npm publish <tarball>` の受け渡しは、その負債を負わずに同じ結果を得る |
  | **初回も CI から出す（一時的に `NPM_TOKEN` を置く）** | 初版は OIDC で出せないので、**トークンを CI に置く段が必ず1回生まれる**。長期トークンを CI に置くのは Trusted Publishing を選んだ理由そのものに反する。**1回だけの手元 publish で済むなら、そちらのほうが露出が小さい** |
  | **`workflow_dispatch` だけにする（Release を引き金にしない）** | 「どの commit を出したか」が残らない。**Release を作る行為そのものが「publish してよい」の表明**であるほうが、意図がリリースノートと一緒に残る |
  | **`push: tags` を引き金にする（当初はこれだった）** | Releases の UI から Release を作ると tag も同時に作られ、**同じ版で2本走る**。オーナーが「GitHub Releases から自動的にリリースしたい」と指定したため、引き金を Release 側へ寄せ、`push: tags` は落とした |
  | **`push: tags` と `release` の両方を引き金にし、`concurrency` の `cancel-in-progress: true` で片方を殺す** | どちらが生き残るかがタイミング次第になる。**publish を途中で殺すと「4本のうち2本だけ上がった」を作りうる** |
  | **GitHub Environment（承認者付き）を挟む** | 人間の関門を1つ増やせるが、**tag を打つ行為がすでにその関門である。**加えて npm 側の信頼発行元設定にも同じ environment 名を書く必要があり、食い違うと 403 になる箇所が1つ増える。**要るとなったら足す**（そのときは npm 側も直す） |
  | **`exports` に `./migrations/*` の口も開ける** | `DEFAULT_MIGRATIONS_DIR` が既にその用を満たしており（実測で tarball 内の実パスを指すことを確認）、**公開面を広げる理由が無い**。塞いだまま出せば、後から開けるのは非破壊である（逆は破壊的） |
  | **`main` / `types` を消して `exports` だけにする** | `exports` を見ない道具（古い bundler・一部の型解決経路）から見えなくなる。**残しておく費用はほぼ無い** |
  | **`pnpm run build` に clean 段（`rm -rf dist`）を足す** | 測ったこと4 を機械的に塞げるが、**全パッケージのビルド時間が毎回伸びる**。この ADR は publish を始める回であって、ビルドの設計を変える回ではない。**代わりに ADR に現象を記録し、publish 手順の段0 に `rm -rf` を明示した**（下の負債にも書いた） |
  | **4パッケージの版を個別に進める運用へ移る** | ADR 0060 が「そのときに決め直す」とした負債。**この回では触らない**（4つ揃えたまま） |

- **引き受けた負債**:

  - **npm 上の `0.1.0` が、リポジトリのどの commit とも一致しない**（測ったこと10）。
    `postgres@0.1.0` は migration `0004` / `0005` を含まず、`testkit@0.1.0` は space 分離の歯を含まない。
    **この差は main が進むたびに広がり、`0.1.1` を出すまで直らない。**
  - **workflow に「作業ツリーが clean であること」の検査は無い。**Release 経路は
    checkout した tag から梱包するので構造的に clean だが、**段0 と同じ手順を手元で
    もう一度打つ人**（緊急の publish など）は同じ穴を踏める。塞ぐなら
    `pack-publish-targets.mjs` に `git status --porcelain` の検査を足す形になるが、
    **この ADR では入れていない**——Release 経路が既定になった以上、手元 publish は例外運用である。
  - **初回 `0.1.0` に provenance が付かない。**OIDC で初版を出せないため（測ったこと3）。
    [npm/cli#8544](https://github.com/npm/cli/issues/8544) が閉じれば解消しうるが、
    **0.1.0 そのものに後付けはできない。**0.1.1 以降は付く。
  - **`npm publish <tarball> --provenance` が実際に通ることを、この器では確かめていない。**
    publish を実行していないためである。**⟹ 通らなかった場合、workflow は最初の
    本番 tag で落ちる**（黙って壊れるのではなく落ちる形にはしてある）。
    段2 の予行（`--dry-run`）でどこまで検出できるかも**確かめていない。**

  **追記（2026-09-09、[ADR 0067](./0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md)）**:
  この空欄は埋まった。**答えは「信頼発行元（Trusted Publisher）の未設定は検出できない」である。**
  `workflow_dispatch`（`dry_run=true`）の run `34262743432`（2026-09-08 18:23 UTC）は、
  信頼発行元が未設定の状態で走ったにもかかわらず、`npm publish（依存の向きの順に、
  tarball を上げる）`を含む全ステップが `success` で終わった。同じ commit・同じ
  workflow の `release` 契機の run `34254090760`（同日 16:56 UTC）は、同じ publish 段で
  `npm error 403 ... OIDC permission denied for this action` により `failure` に終わっている。
  ⟹ **予行と本番のあいだで唯一違う `--dry-run` の有無が、この失敗の再現・非再現を分けた。**
  段2 は段1 の検算になっていない。

  **⚠ 出所の書き分け**: この2本の run の `conclusion` とステップ単位の成否、
  および本番 run のログに出た `OIDC permission denied` の文面は、ADR 0067 を書いた
  作業者が `gh run view <run-id> --json jobs` / `--log` で独立に確認した。**run
  `34262743432` の時点で信頼発行元が未設定だったという状態そのものは、この修正を
  依頼したクローン（当時オーナーへ設定を依頼中で返事待ちだった）の申告であり、
  ADR 0067 の作業者は npmjs.com の設定画面を直接見ていない。**この区別は
  ADR 0067 の本文にも明記してある。
  - **tag が `origin/main` の履歴上に在ることの検査は、「main へ入った時点で CI が緑だった」の検査ではない。**
    CI が赤いまま main へ入った commit に tag を打てば、DB を要する検査を通さずに publish できる。
    塞ぐなら publish 側に Postgres の service container を立てるか、
    branch protection で main を守ることになる——**この回では決めていない。**
  - **`pnpm run build` は `dist/` を掃除しない**ので、古い成果物が居残った手元では
    門が CI と違う結果を出しうる（測ったこと4）。publish 手順の段0 に `rm -rf packages/*/dist` を
    書いたが、**これは規律であって仕掛けではない。**
  - **`@types/pg` を `dependencies` に置いたことで、`pg` の型が
    `@mnemora/postgres` の公開 API の一部になった。**`@types/pg` の破壊的更新は
    このパッケージの破壊的変更になりうる。**型を自前で再宣言して依存を切る案は検討していない。**
  - **`vitest` を `peerDependencies` にしたことで、`@mnemora/testkit` は
    「入れただけでは動かない」パッケージになった。**vitest を入れていない consumer は
    peer の警告を見る（install は失敗しない）。README に明記したが、**歯は無い。**
  - **`publish-targets.mjs` の対象リストは手で保守する。**新しい publish 対象が増えたときに
    ここへ足し忘れることは、**機械的には検知できない**（ADR 0060 と同じ負債のまま）。
    順序のほうは歯が見る。

- **これが覆るとしたら**:

  - **[npm/cli#8544](https://github.com/npm/cli/issues/8544) が閉じて、初版も OIDC で出せるようになったとき。**
    段0（手元からの初回 publish）が不要になる。**次に新しいパッケージを足すときに効く。**
  - **`pnpm publish` が OIDC と provenance を自前で実装したとき。**決定2 の後半（アップロードは npm）が
    覆り、道具を pnpm に戻せる。**そのときも決定2 の前半（梱包は pnpm）は変わらない。**
  - **npm が `exports` の扱いを変えたとき／`exports` を持たない publish を拒むようになったとき。**
    決定5 の `main` / `types` の残置は影響を受けないが、門の検査項目3が変わる。
  - **オーナーが版の進め方を個別に変えると決めたとき。**`--expect-version` が
    「4つとも同じ版」を前提にしているため、`pack-publish-targets.mjs` と workflow の版検査が変わる。

- **確かめたこと / 確かめていないこと**:

  - **確かめた（この器で実行）**: 測ったこと1〜5 のすべて。
    `pnpm pack` → 素の `npm install` → `import` の往復（`exports` 追加の前後で2回）。
    consumer 側の `nodenext` 型解決と、`@types/pg` を consumer に入れずに `pg` の型が
    届くこと（`@ts-expect-error` が効くことを証拠として）。
    4パッケージの `dist/**` の外部 import と宣言済み依存の突き合わせ。
    `pnpm publish --help` / `npm publish --help` のフラグ。
    `npm view @mnemora/core version` が E404 であること（= 未 publish）。
    `scripts/pack-publish-targets.mjs` が実際に4つの tarball を publish 順に並べること、
    版がずれたときに EXIT=1 で落ちること。変異試験1〜6。
    `pnpm run typecheck` / `lint` / `format:check` / `test` / `build` / `pack:check`。
  - **確かめた（段0 を実行した）**: `npm publish <tarball> --access public` が
    automation token で通ること。4パッケージとも `0.1.0` が registry に在ること
    （`E403 cannot publish over the previously published versions` を証拠として）。
    `--access public` が効くこと（scoped パッケージが restricted で拒否されなかった）。
    `pnpm pack` の tarball を `npm publish` に渡す経路が実際に成立すること（決定2 の要）。
  - **確かめていない**: **Trusted Publishing (OIDC) と provenance。**段0 は token 経路であり、
    OIDC を通っていない。⟹ 「OIDC が通る」「provenance が付く」は
    **文書上の既知挙動と他人の報告のままである。**最初にそれが試されるのは
    段1（npmjs.com で信頼発行元を設定）の後の最初の tag である。
  - **確かめていない**: `.github/workflows/publish.yml` が GitHub Actions 上で走ること。
    **YAML の構文（パーサに通した）・shell 段（`npm publish` を `echo` に差し替えて実行）・
    手元で打てる段（`pack:check` / `pack-publish-targets.mjs`）は確かめたが、
    workflow としては一度も走っていない。**とくに `${{ steps.version.outputs.version }}` などの
    GitHub の展開・`actions/setup-node` の `registry-url` が置く `.npmrc`・
    OIDC の token 交換は、**この器では動かせない。**
  - **確かめていない**: DB を要する経路（`DATABASE_URL` が無い。ADR 0015 と同じ非対称）。
    **梱包と publish の判断は DB に依存しない**と見て、DB は立てていない。
  - **確かめた（この器で実行）**: 信頼発行元の設定は **Web UI だけでなく `npm trust` CLI からも打てる**
    （npm 11.10.0 以降。手元は 11.12.1）。
    `npm trust github @mnemora/core --repo takecchi/mnemora --file publish.yml --dry-run` を実行し、
    設定の形（package / file / repository）が意図どおりであることと、
    **この操作に 2FA が必要である**（`Two-factor authentication is required for this operation`）ことを確認した。
  - **確かめていない**: `npm trust` の**本番実行**（`--dry-run` を外した実行）。OTP が要るため、
    オーナーの手が必要である。
