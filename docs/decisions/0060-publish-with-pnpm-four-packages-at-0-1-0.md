# ADR 0060: npm へ出すのは4パッケージだけ・初回は `0.1.0`・梱包の道具は pnpm に統一する

- **状態**: 採用 (2026-09)

- **⚠ この ADR が決めていないこと（先に書く）**:

  この ADR は**梱包（packaging）についての決定だけ**を記録する。
  次の2つは**この ADR の対象外であり、ここでは何も決めていない**。

  | 決めていないこと | いまの状態 | どこで決まるか |
  |---|---|---|
  | **ライセンス** | 6つとも `"license": "UNLICENSED"`。LICENSE ファイルは無い | **オーナーの判断待ち。**この ADR は `license` フィールドにも LICENSE ファイルにも触っていない |
  | **`"private": true` を外すこと（= publish を始めること）** | 6つすべてに立っている | **別の判断。**外す行為そのものが「publish してよい」の決定であるため、この ADR では外さない |

  **⟹ この ADR を「publish してよい」と読まないこと。**
  ここで整えたのは「publish するとなったときに壊れないこと」だけである。
  実際に publish するには、上の2つが別途決まる必要がある。

- **文脈**:

  Phase 1 の実装が一巡し、npm の org `@mnemora` はオーナーが取得済みである（ADR 0014）。
  しかし **publish の準備は1つも入っていなかった。**この器で実測した結果:

  | 測ったこと | 実測（この ADR より前） |
  |---|---|
  | `publishConfig` | repo 全体で **0件**。scoped パッケージは既定 restricted なので、そのまま publish すると 402 になるか毎回 `--access public` を手で打つことになる |
  | `version` | 6つすべて `0.0.0` |
  | `prepublishOnly` / `prepack` | 全パッケージで **0件**。publish の workflow も無い |
  | `repository` / `homepage` / `bugs` | 全パッケージで **0件** |
  | `engines` | ルートの `node>=22` だけ。published 側の4つには無い（ルートの `engines` は tarball に伝播しない） |
  | README | publish 対象4つに **1つも無い**。ルート README に `npm` / `install` の文字列は **0件**。動くコマンド例は `examples/chat/README.md` にしかなく、すべて `pnpm --filter`（monorepo の中でしか打てない） |
  | `mnemora-postgres-migrate` の使い方 | どの README にも無い |

- **⭐ 測ったこと — 静かに壊れる2つ**

  上の表は「無いことが見れば分かる」ものばかりである。**次の2つは見ても分からない。**

  **1. `dist` が無いまま pack すると、エラー無し・EXIT=0 で中身1ファイルの tarball が出来る。**

  `packages/core` で `dist/` を消してから `pnpm pack` を打つと:

  ```
  PNPM_PACK_EXIT=0
  package: @mnemora/core@0.0.0
  Tarball Contents
  package.json
  ```

  `files: ["dist"]` の指す先が空でも、pack は**成功として返る**。
  publish の直前に build を忘れる／CI が build 段を飛ばす／`dist` が `.gitignore` されている
  （実際されている）状態で clean checkout から publish する——**どれも同じ形で成功する。**
  そして出来上がるのは、install しても `main` が無い tarball である。

  **2. `npm pack` は `workspace:*` を置換しない。`pnpm pack` は置換する。**

  同じソースツリーから両方で pack して、tarball 内の `package/package.json` を逐語比較した:

  | パッケージ | `npm pack` の dependencies | `pnpm pack` の dependencies |
  |---|---|---|
  | `@mnemora/testkit` | `"@mnemora/core": "workspace:*"` | `"@mnemora/core": "0.0.0"` |
  | `@mnemora/postgres` | `"@mnemora/core": "workspace:*"` | `"@mnemora/core": "0.0.0"` |
  | `@mnemora/openai` | `"@mnemora/core": "workspace:*"` | `"@mnemora/core": "0.0.0"` |

  `workspace:` が残った tarball を素の consumer が install すると、
  `npm error code EUNSUPPORTEDPROTOCOL` / `Unsupported URL Type "workspace:"` で落ちる。
  **⟹ `npm pack` / `npm publish` でこの repo を出してはならない。**

- **測ったこと — その他**

  | 測ったこと | 実測 |
  |---|---|
  | `@mnemora/core` の tarball | 121 ファイル。うち `.map` が **60**、`package/src/` は **0件** |
  | `dist/index.d.ts.map` の `sources` | `["../src/index.ts"]` ⟹ **tarball に存在しないファイルを指す** |
  | `@mnemora/example-chat` を pack すると | **40 ファイル**。`files` も `main` も `bin` も無いため、`src/**` 34 ファイル（`__tests__/*.test.ts` **14本**を含む）と `cassettes/*.json` **2本**（記録済みの実 API 応答）がまるごと入る |
  | ルートの `mnemora` | `files` も `main` も無い monorepo root。publish できる実体が無い |
  | `main` / `types` / `bin` の指し先 | 4パッケージとも実在する。`packages/postgres/dist/bin/migrate.js` は shebang を持つ |

- **決定**:

  **1. publish 対象は `@mnemora/{core,testkit,postgres,openai}` の4つだけにする。**

  ルートの `mnemora` と `@mnemora/example-chat` は**対象から外す**。
  前者は publish できる実体を持たない。後者は entry point を持たず、
  pack するとテストと記録済み API 応答（cassettes）を同梱してしまう。
  **`examples/chat` は「使い方の実演」であって「使う物」ではない**——
  この非対称は `AGENTS.md` の package 表がすでに書いている通りである。

  **2. 初回バージョンは `0.1.0` にする。**（4パッケージとも同じ版で揃える）

  `0.0.0` は「まだ何も選んでいない」の既定値であって、選んだ版ではない。
  `0.x` にすることで「破壊的変更がありうる」を semver の作法で名乗れる。
  ルートの `mnemora` と `@mnemora/example-chat` は publish 対象外なので `0.0.0` のまま動かさない
  （**版を持たないものに版を付けない**）。

  **3. 梱包と publish の道具は `pnpm` に統一する。**

  これは新しい設計判断ではない——**この repo はもともと pnpm workspace であり、
  `npm pack` は `workspace:*` を置換できず、使う側の install が必ず落ちる**（上の実測2）。
  既に使っている道具に合わせるだけである。

  **4. 静かに壊れる2つを、門で塞ぐ。**

  | 打った手 | 何を塞ぐか |
  |---|---|
  | publish 対象4つに `"prepack": "pnpm run build"` | 実測1（`dist` 無しの pack が成功する）。pack / publish のどちらから入っても build を経由する |
  | `scripts/check-publish-pack.mjs` と、それを起動する歯 | 実物の tarball を開けて中身を検査する。`workspace:` の残留・`main`/`types`/`bin` の指し先の不在・`README.md` の不在・`publishConfig.access`・宙に浮いた `.map` を、**tarball の側から**見る |
  | 歯が `"private": true` の存置も検査する | この ADR の対象外である「publish を始める判断」が、**うっかりでは起きない**ようにする |

  **5. `publishConfig.access: "public"` / `engines` / `repository` / `homepage` / `bugs` /
  README を4つに入れる。**

  README の要件は**「使う人が最初の1行を書けること」だけ**に置いた——
  install コマンドと、現物の export を読んで書いた最小の例である。
  **⚠ まだ publish していないことを各 README に明記してある**（`private: true` が立ったままである）。

  **6. publish 向けビルドでは source map を出さない。**

  4つの `tsconfig.build.json` で `declarationMap` / `sourceMap` を `false` にする。
  `files: ["dist"]` は `src` を意図的に除いており（テストの混入を防いでいる）、
  その状態で map を出荷すると**存在しないファイルを指す map** が残る（上の実測）。
  開発用の `tsconfig.json`（`tsconfig.base.json` 経由）は map を出したままにする。

- **採らなかった案**:

  | 案 | 却下の理由 |
  |---|---|
  | **`npm publish` を使い、publish の直前に `workspace:*` を書き換えるスクリプトを足す** | 実測2 の問題を、既にその仕事をしている道具（pnpm）を捨てて自作で埋め直す形になる。**置換の正しさを自分で保証する負債**が増えるだけで、得るものが無い |
  | **初回を `1.0.0` にする** | 「破壊的変更をしない」を名乗ることになる。Phase 1 が一巡しただけで、`docs/roadmap.md` §1.3 の未実装（関係グラフ本体・reranking・`reflect()` の実運用・HTTP server）が残っている。**名乗れない約束を名乗らない** |
  | **初回を `0.0.1` にする** | `0.0.x` は semver 上「どの変更も破壊的でありうる」帯であり、caret 範囲（`^0.0.1`）が patch すら拾わない。使う側の範囲指定が実質固定になる |
  | **`@mnemora/example-chat` も publish する** | entry point が無く、pack すると `__tests__/*.test.ts` 14本と cassettes 2本が入る。`files`/`main` を足せば出せるが、**「使う物」ではないものを npm に置く理由が無い** |
  | **ルートの `mnemora` を「メタパッケージ」として publish する** | `mnemora` という名前を押さえる価値は在るが、**中身の無いパッケージを置くのは、名前の予約を publish で代用する形**である。名前の確保が要るならそれ自体を別に決める（ADR 0014 は名前の決定であって publish の決定ではない） |
  | **`prepublishOnly` を使う（`prepack` ではなく）** | `prepublishOnly` は `publish` でしか走らない。**静かに壊れた tarball は `pack` の側でも出来る**（実測1 は `pack` で再現した）。`prepack` は pack と publish の両方から通る |
  | **map を出したまま `src` も同梱する** | map は直るが、`files: ["dist"]` で src とテストを外した判断（既存）を覆すことになる。**この ADR は梱包を整える回であって、何を出荷するかを広げる回ではない** |
  | **publish 用の GitHub Actions workflow をこの回で足す** | publish を始める判断がまだ無い（冒頭の表）。**引き金だけ先に作らない** |

- **引き受けた負債**:

  - **`prepack` は「build が走ったこと」を保証するが、「build の出力が正しいこと」は保証しない。**
    そこは `scripts/check-publish-pack.mjs` が tarball の側から見る。
    **その門は「`main`/`types`/`bin` の指す先が在るか」までで、`import` して動くかは見ていない。**
  - **`0.1.0` を4つに揃えたことで、以後どれか1つだけを直しても4つとも上げる形になりやすい。**
    個別に版を進める運用へ移るなら、そのときに決め直す（この ADR では決めない）。
  - **publish の順序**は依存の向きで決まる（`core` → `testkit` / `openai` → `postgres`）。
    **これを守らせる仕掛けはまだ無い**——順序を誤ると使う側が E404 を見る。
    `pnpm publish -r` が順序を解決することは**この器では確かめていない**（publish を打てないため）。
  - **`@mnemora/testkit` が `vitest` を runtime の `dependencies` に持っている。**
    `peerDependencies` へ移すべきかどうかは**この ADR では決めていない**（現状維持）。

- **これが覆るとしたら**:

  - **pnpm が `workspace:` の置換をやめる／挙動を変えたとき。**決定3の根拠がそこにあるため。
    `scripts/check-publish-pack.mjs` の「`workspace:` が残っていないこと」の検査が、その日に赤くなる。
  - **`examples/chat` を「使う物」として出す判断が別に入ったとき。**決定1 が変わる。
  - **オーナーが `1.0.0` から始めると決めたとき。**決定2 は設計側の判断であり、オーナーの判断が上に来る。

- **確かめたこと / 確かめていないこと**:

  - **確かめた（この器で実行）**: 上の実測表のすべて。`npm pack` と `pnpm pack` の
    tarball 内 manifest の逐語比較、`dist` 退避後の pack が EXIT=0 で1ファイルの tarball を出すこと、
    `core` の tarball の `.map` 60件と `src` 0件、`index.d.ts.map` の `sources`、
    `example-chat` の tarball 40ファイルの内訳。
  - **確かめていない**: **publish そのもの。**`npm publish` も `pnpm publish` も、
    `--dry-run` も含めて**一度も実行していない**（意図的に禁じられている）。
    ⟹ 「402 になる」「E404 になる」は**文書上の既知挙動であって、この器での実測ではない。**
  - **確かめていない**: publish 後の tarball を素の consumer が install して `import` できること。
    pack → install → import の往復は**この repo の別の調査が報告したもの**であり、
    この ADR ではその報告を再導出していない。
  - **確かめていない**: DB を要する経路。この器には Postgres も docker も `DATABASE_URL` も無く、
    ルートの `pnpm run test` は「DB テストは実行していません」と出る（ADR 0015）。
    **梱包の判断は DB に依存しない**と見て、DB は立てていない。
