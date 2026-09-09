# ADR 0070: 版の権威は Release の tag に置く。`package.json` の `version` は権威ではなくなる

- **状態**: 採用 (2026-09)

- **⚠ 先に書く — この ADR が変えること**:

  | | 以前（ADR 0066） | この ADR の後 |
  |---|---|---|
  | 版を決めるもの | `packages/<pkg>/package.json` の `version`（人が上げる） | **Release の tag**（`v0.1.2`） |
  | tag と `package.json` の関係 | **一致を検査する**（`--expect-version`。ずれたら落ちる） | **tag の値を `package.json` へ書き込む**（ずれようがない） |
  | 版上げのコミット | **要る**（PR を1本出す） | **要らない** |
  | `packages/<pkg>/package.json` の `version` の意味 | 権威ある値 | **権威ではない。**「最後に誰かが書いた値」であって、npm 上の最新版とは限らない |

  **⟹ 版を知りたければ registry に訊くこと**: `npm view @mnemora/core version`

- **文脈**:

  ADR 0066 で publish は Release 契機になったが、**版上げは手作業のままだった。**
  `0.1.1` を出すために、4つの `package.json` を手で書き換える PR（#77）を1本出している。

  オーナーの逐語の要求:

  > **「`vX.X.X` みたいな感じでリリースしたときに自動的にそのバージョンに更新されて
  > リリースされるようにしてほしいんだけどこれは一般的じゃないの」**

  > **「てか自動的に `vX.X.X` にすればいいのでは...」**

  作業者は当初この案を勧めなかった（「`package.json` の版が意味を失う」ことを理由に挙げた）。
  **その判断は強すぎた。**tag を版の真実の源にする形は Go・Rust・Python では標準的であり、
  npm でも使われている。npm で Changesets が主流であることは事実だが、
  **「主流でない」は「一般的でない」ではない。**オーナーが要求を繰り返したうえで、
  この ADR はその要求どおりに実装したものである。

- **決定**:

  **1. Release の tag が版を決める。`package.json` はそれを受け取る側になる。**

  `scripts/apply-release-version.mjs` が、publish 直前に4つの `package.json` の
  `version` を tag の値へ書き換える。**この書き換えはコミットされない**——
  runner の作業ツリー上で起き、tarball に載って消える。

  **2. tag は semver として検査する。**

  `${TAG#v}` だけの実装だと `vfoo` は `foo` になり、`package.json` に書き込まれ、
  **`pnpm pack` は文句を言わずに `mnemora-core-foo.tgz` を作る**——
  publish の直前まで誰も気づかない。`scripts/release-version.mjs` の
  `versionFromTag()` がここを落とす。

  **3. dist-tag の食い違いは、`latest` を汚さない側へ倒す。**

  GitHub 側の pre-release チェックと semver の prerelease 部（`-beta.1`）は別物である。
  **どちらか一方でも prerelease なら `next` にする**（`distTagFor()`）。
  理由は非対称性である——**`latest` を誤って汚すと取り消せないが、`next` へ入れ違えるのは
  `npm dist-tag add` で直せる。直せるほうの誤りを選ぶ。**
  食い違ったときは `::warning::` で名指しする。

  **4. 判定は純関数へ、書き込みは CLI へ分ける。**

  ADR 0067 が `decideDryRun` で採った形に揃えた。判定（tag → 版・dist-tag）は
  `scripts/release-version.mjs` が持ち、歯が直接測る。`scripts/apply-release-version.mjs` は
  「決まった値を書く」「書けたことを読み直して検算する」だけをする。

  **5. `--expect-version` は残す。**意味が変わる——「人が上げ忘れていないか」の検査から、
  **「書き込みが4つ全部に効いたか」の事後条件**になる。

- **⭐ 測ったこと1 — `workspace:^` は書き込んだ版で解決される（この設計の要）**

  この設計は「`package.json` を書き換えてから `pnpm pack` すれば、
  `workspace:^` もその版で解決される」ことに全面的に依存している。実測した:

  ```
  書き込み前: core 0.1.1 / postgres の依存 "workspace:^"
  apply-release-version.mjs を v9.9.9 で実行
  ⟹ tarball の version: 9.9.9
  ⟹ tarball の @mnemora/core 依存: ^9.9.9
  ```

  **⟹ 依存の版も一緒に動く。**4つを同じ版に揃えて書くかぎり、この形は成立する。

- **⭐ 測ったこと2 — `JSON.stringify` で書き戻すと `format:check` が赤くなる**

  最初の実装は `JSON.parse` → `manifest.version = version` → `JSON.stringify(m, null, 2)` だった。
  **これは壊れる。**実測した差:

  ```diff
  -  "files": [
  -    "dist"
  -  ],
  +  "files": ["dist"],
  ```

  `JSON.stringify` は短い配列も必ず展開するが、`prettier --parser json` は畳む。
  **workflow はこの段の直後に `pnpm run format:check` を通すので、publish が止まる。**

  ⟹ **JSON 往復をやめ、`version` の行だけを差し替える**形にした
  （先頭2スペースに錨を打ち、入れ子の `"version"` を掴まない。書けたことは読み直して JSON で検算する）。

  **⚠ この食い違いは、作業者が気づいたのではない。**
  「書き換えた package.json が prettier の整形と一致する」という歯が捕まえた。

  **さらに、その歯自身も最初は間違っていた。**`--parser json` で比べていたが、
  **prettier は `package.json` には `json-stringify` パーサを使う**
  （`prettier --file-info` で確認）。`json-stringify` は配列を畳まない。
  ⟹ 歯を `--stdin-filepath package.json` に直した。
  **正しい実装を「違う」と誤判定する歯だった**——歯のほうが間違っていることもある。

- **⭐ 測ったこと3 — Trusted Publishing (OIDC) と provenance が実際に通った**

  ADR 0066 が「文書上の既知挙動と他人の報告のままである」と書いた点が、ここで実測に置き換わった。

  **経緯**: `v0.1.1` の Release は作られたが、publish は失敗していた:

  ```
  npm error 403 Forbidden - PUT https://registry.npmjs.org/@mnemora%2fcore
            - OIDC permission denied for this action
  ```

  除外できたもの: npm は **12.0.2**（>= 11.5.1）、`id-token: write` は在る、
  repo / workflow 名の不一致でもない（**不一致なら npm は 404 を返す**——
  registry は 403 を意図的に 404 で隠す。今回は `PUT` まで到達して
  **「this action」を名指しした 403** ⟹ **npm は身元を認識していた**）。

  原因は npm 側の**許可されたアクション**の設定だった。npm の文書:

  > `npm stage publish` は常に許可される。この信頼発行元が `npm publish` で
  > 直接 publish できるかどうかは選択する。
  > **2026年9月3日以降に作成された設定は `npm stage publish` を許可するのが既定**で、
  > 直接の `npm publish` は任意。

  信頼発行元が設定されたのは 2026-09-09——**既定のまま＝直接 publish が不許可**だった。
  オーナーが4パッケージで直接 publish を許可したのち、同じ run を再実行して成功した。

  **実測できたこと**:

  | | 結果 |
  |---|---|
  | 4パッケージの `0.1.1` | **publish 成功**（OIDC 経由） |
  | provenance | **付いた。**attestation 2件——`https://github.com/npm/attestation/tree/main/specs/publish/v0.1` と **`https://slsa.dev/provenance/v1`** |
  | `0.1.0` に欠けていた中身 | **届いた。**`postgres@0.1.1` に migration `0004` / `0005` が入り、LICENSE の著作権行も `takecchi` になった |

  **⟹ ADR 0066「引き受けた負債」の「npm 上の `0.1.0` がどの commit とも一致しない」は、
  `0.1.1` の公開をもって解消した**（`0.1.0` 自体は上書きできないので残る）。

- **測ったこと4 — 変異試験**

  | # | 変異 | 結果 |
  |---|---|---|
  | A | workflow から `apply-release-version.mjs` の呼び出しを消す | 1本（配線の歯）。**判定の歯は全部緑のまま**——ADR 0067 が挙げた「切り出した判定は、呼ばれていなければ何も守らない」を、この歯が押さえていることの確認 |
  | B | `NPM_TAG` の空チェックを消す | 1本 |
  | C | `versionFromTag` の semver 検査を外す | 2本（純関数側と CLI 側） |
  | D | 食い違いを `latest` 側へ倒す（`\|\|` を `&&` に） | 3本 |

  変異はすべて退避コピーから戻した（`git checkout` は使わない——ADR 0066 測ったこと7 の事故を繰り返さないため）。

- **採らなかった案**:

  | 案 | 却下の理由 |
  |---|---|
  | **Changesets を入れる** | npm の monorepo では主流であり、**版と CHANGELOG が git に残る**という、この repo の「記録と現物を一致させる」姿勢に噛み合う利点がある。**却下ではなく後回し**——オーナーが tag 駆動を名指しで要求した。加えて、`changeset publish` が `workspace:` をどう扱うかを**この器で確かめていない**（ADR 0060 の要である「`pnpm pack` が `workspace:` を置換する」を通るかどうか）。**確かめていない道具へ、動いている経路から乗り換えない。** |
  | **`package.json` の `version` を `0.0.0-managed-by-release` のような番兵にする** | 「この値を見るな」を明示できる利点は在る。しかし `scripts/check-publish-pack.mjs` の版検査（`0.0.0` でないこと・4つ揃っていること）と、`pnpm pack` が作る tarball 名に影響が及ぶ。**この ADR は版の決め方を変える回であって、門の意味を変える回ではない。**代わりに、権威が tag に在ることを**この ADR・スクリプト冒頭・README に書いた。** |
  | **書き換えた `package.json` を commit して main へ push し返す** | git 上の版が常に真実になる利点は在るが、**publish workflow が repo へ書き込む権限（`contents: write`）を持つことになる。**publish の経路に書き込み権限を足すのは、守る面を広げる。 |
  | **`${TAG#v}` のまま（semver 検査を入れない）** | 測ったこと2 の「静かに壊れる」形をそのまま残すことになる。 |
  | **GitHub 側の pre-release チェックだけで dist-tag を決める** | `v0.2.0-beta.1` を pre-release にチェックし忘れて作ると、**beta が `latest` になる**。取り消せない側の誤りを許す形になる。 |

- **引き受けた負債**:

  - **`packages/<pkg>/package.json` の `version` が古いまま放置される。**
    `0.1.1` が入っているが、`0.2.0` を publish した後もそのままである。
    **これを検出する歯は無い**（そもそも権威でない値なので、ずれても壊れない——
    ただし**読んだ人が最新版だと誤解する**）。README とスクリプト冒頭に明記したが、規律である。
  - **`--expect-version` は事後条件になったが、「4つが同じ版であること」以上のことは見ていない。**
    `apply-release-version.mjs` が4つ全部に書くので構造的に揃うが、
    **その構造が壊れたときに気づく口は `--expect-version` しかない。**
  - **`npm publish --tag ""` の挙動をこの器で確かめていない。**空なら手前で落とす門を置いたが、
    **それは「確かめていないことを通さない」であって「確かめた」ではない。**
  - **Changesets との比較を実測していない**（上記）。CHANGELOG が自動生成されないという
    差は残る——**このリポジトリには今も CHANGELOG が無い。**

- **これが覆るとしたら**:

  - **オーナーが CHANGELOG を要求したとき。**tag だけからは生成できないので、
    Changesets か conventional commits の規約が要る。決定1 が覆る。
  - **個別に版を進める運用へ移るとき**（ADR 0060 が残した負債）。
    tag1本が4パッケージを同じ版にする形なので、決定1・5 の両方が変わる。
  - **`pnpm pack` が `workspace:^` を「作業ツリーの版」ではなく別の源から解決するようになったとき。**
    測ったこと1 が根拠なので、その日にこの設計は成立しなくなる。

- **確かめたこと / 確かめていないこと**:

  - **確かめた（この器で実行）**: 測ったこと1〜4 のすべて。
    `apply-release-version.mjs` を実際に走らせ、4つの `package.json` が書き換わり、
    `format:check` を含む6つの門が緑のまま通り、tarball の `version` と
    `@mnemora/core` 依存が `9.9.9` / `^9.9.9` になること。書き換えを退避コピーから完全復元したこと。
    `v0.1.1` の publish 成功・provenance 2件・`0.1.1` の tarball の中身。
  - **確かめていない**: **この workflow の変更が Actions 上で走ること。**
    YAML はパーサに通し、判定と書き込みは手元で実行したが、
    **`release` 契機でこの新しい段が走るのは、次の Release が初めてである。**
  - **確かめていない**: pre-release の Release から `next` へ実際に入ること
    （`distTagFor` の判定は測ったが、**npm 側で dist-tag が `next` になることは未実測**）。
  - **確かめていない**: `npm publish --tag ""` の挙動（上記）。
