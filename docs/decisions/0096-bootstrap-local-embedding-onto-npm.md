# ADR 0096: `@mnemora/local-embedding` を npm へ載せる — 初版は OIDC で出せないので、tag 由来の中身を手元から1回だけ出す

- **状態**: 採用 (2026-09)

- **⚠ この ADR が決めたこと・決めていないこと（先に書く）**:

  | | |
  |---|---|
  | **決めた** | `@mnemora/local-embedding` の初版を **`0.1.4`** とし、**`v0.1.4` の tag から梱包した中身**を手元から1回だけ publish する。以後は他5つと同じ OIDC 経路に合流させる |
  | **決めた** | `v0.1.4` の Release を**先に**切る。CI が5つを OIDC + provenance で出し、`local-embedding` だけ落ちる——**この赤を受け入れ、段1・段2 の後に workflow を再実行して緑にする**（⚠ **落ち方の予測は外れた。**403 ではなく **E404** だった。測ったこと7） |
  | **やった（この ADR の後）** | **`v0.1.4` を実際に出した。**5つは CI が OIDC + provenance で、`@mnemora/local-embedding@0.1.4` は段0 として手元から publish 済み。⟹ **6パッケージとも registry に `0.1.4` が在る**（測ったこと8）。**取り消せない** |
  | **まだ済んでいない** | 🔴 **段1・段2（オーナーの 2FA / web UI）。**これが済むまで、次の Release でも `local-embedding` は publish されない |
  | **決めた** | 手元の梱包は `scripts/apply-release-version.mjs` を通す（CI と同じ経路。版の決め方を二重に持たない） |
  | **決めた** | 公開前に `packages/local-embedding/README.md` へ **利用者側の `onnxruntime-node` postinstall の止め方**を書く（下の測ったこと6） |
  | **決めていない** | 個別に版を進める運用。**6つ揃えて上げるまま**（ADR 0060 が残した負債を引き継ぐ） |
  | ✅ **解消した（運用）** | 段0 のトークン露出。**revoke 済み**（2026-09-10、実測。負債3。**確認は要らない**） |

- **文脈**:

  `packages/local-embedding` は ADR 0085 で新設され（PR #118）、`PUBLISH_TARGETS` の末尾にも
  入っている。にもかかわらず **registry に存在しない**（`npm view` が E404）。

  理由は2つあり、**どちらも「忘れていた」ではない**:

  1. 最後の Release `v0.1.3` が指す commit は `fe83e1f`（PR #91）で、
     **`packages/local-embedding` はその時点で存在しない**（下の測ったこと4）。
     tag より後に入ったので、publish の対象に入ったことが一度も無い。
  2. **初版を Trusted Publishing (OIDC) で出すことはできない**
     （[npm/cli#8544](https://github.com/npm/cli/issues/8544)。下の測ったこと3）。

  オーナーへの逐語の問いと回答:

  > **問い**: 段0（手元からの初版 publish）で、`@mnemora/local-embedding` を
  > どの版として出しますか。これは取り消せません。
  > (a) `v0.1.4` を今切る → bootstrap は tag 由来の `0.1.4` /
  > (b) `0.1.3`（現在の他5つの最新に揃える） /
  > (c) `0.1.4-bootstrap.0` + `--tag bootstrap`
  >
  > **オーナーの回答**: 「v0.1.4 を今切る → bootstrap は tag 由来の 0.1.4」

  ⚠ **オーナーは最初 (b) を提案していた**（「v0.1.3では？現在の最新。次回以降は releases で
  リリースすると全部バージョン一致の状態でリリースされるで良いのでは？」）。
  下の測ったこと4・5 を示したうえで (a) に変わっている。**この ADR は (b) を却下した
  記録ではなく、(b) の前提のうち何が成り立ち何が成り立たなかったかの記録である。**

- **⭐ 測ったこと1 — 渡されたトークンは、3段のうち1段しか打てない**

  ADR 0066 は publish を「段0（手元からの初回）→ 段1（信頼発行元の設定）→
  段2（直接 publish の許可）→ 段3（Release）」に分けた。オーナーから publish 用トークンを
  受け取ったので、**各段が実際に打てるかを1つずつ測った**:

  | 段 | 結果 | 根拠 |
  |---|---|---|
  | **段0** publish | ✅ **打てる** | 下の probe |
  | **段1** `npm trust` | 🔴 **E403** | `npm trust list @mnemora/core` → `403 Forbidden - GET https://registry.npmjs.org/-/package/@mnemora%2fcore/trust` |
  | **段2** 直接 publish の許可 | 🔴 **CLI に存在しない** | `npm trust github --help` のフラグは `--file` / `--repository` / `--environment` / `--dry-run` / `--json` / `--registry` / `-y` のみ。**許可アクションを切り替える口が無い** ⟹ web UI 専用 |

  **⭐ 段0 の能力は、非破壊で測れた。**ADR 0067 が「`--dry-run` は副作用の直前で
  判定される条件を構造的に検出できない」と実測しているので、**予行では権限を測れない。**
  代わりに **既に registry に在る版へ本番 publish を試みた**——上書きは構造的に不可能なので、
  **返る 403 の種類だけが情報になる**:

  ```
  $ npm publish mnemora-core-0.1.1.tgz --access public --tag bootstrap-probe
  npm error You cannot publish over the previously published versions: 0.1.1.
  ```

  **権限の 403 ではなく、版の衝突。**⟹ 認証・認可を通り抜けて版検査まで到達している
  ＝ publish の権限は在る（ADR 0066 測ったこと8 が使ったのと同じ証拠の形）。
  副作用が無いことも確認した——`dist-tags` は `latest: 0.1.3` のままで、
  **`bootstrap-probe` は作られていない**（publish は書き込みの前に拒否されている）。

  ⚠ **npm 自身が、この経路を畳もうとしている**:

  > npm tokens that bypass 2FA are being restricted for account changes and **direct publishing**.

  ⟹ **段0 を手元のトークンで打てること自体、いつまでも当てにできない**（負債4）。

- **⭐ 測ったこと2 — 段1・段2 はオーナーの手が必要で、代行できない**

  測ったこと1 の帰結である。**トークンを預かっても3段は揃わない。**
  段1 は 2FA を要求し（ADR 0066 が `npm trust ... --dry-run` で
  `Two-factor authentication is required for this operation` を確認済み）、
  段2 は web UI にしか無い。⟹ **この ADR の作業者が打てるのは段0 だけである。**

- **⭐ 測ったこと3 — npm/cli#8544 は、いまも OPEN**

  ADR 0066 が「これが覆るとしたら」に挙げた条件（初版も OIDC で出せるようになる）は
  **まだ満たされていない**:

  ```
  $ gh api repos/npm/cli/issues/8544
  { "state": "open", "title": "Allow publishing initial version with OIDC",
    "closed_at": null, "updated_at": "2026-08-05T09:31:49Z" }
  ```

  ⟹ **段0 は今回も必要である。**`@mnemora/anthropic` のときと同じ形になる
  （registry 上の初版 `0.1.2` は 2026-09-09T07:26:52Z で、`v0.1.3` の CI run は 07:50 開始
  ——**時刻からも、初版が CI ではなく手元から出されたことが読める**）。

- **⭐ 測ったこと4 — `v0.1.3` に `packages/local-embedding` は存在しない（(b) を落とした根拠）**

  ```
  $ git ls-tree -d v0.1.3 packages/
  packages/anthropic  packages/core  packages/openai  packages/postgres  packages/testkit
  ```

  ⟹ `@mnemora/local-embedding@0.1.3` を出すと、**どの commit も指さない版**になる。
  「0.1.3 に何が入っているか」を調べる人は `v0.1.3` を checkout して、
  **ディレクトリごと無いのを見る。**

  🔴 **これは ADR 0066 が「引き受けてしまった」と記録し、ADR 0070 が `0.1.1` の公開をもって
  解消したと宣言した負債の、再導入である**（ADR 0066: 「npm 上の `0.1.0` は、この ADR が
  入る commit の中身と一致しない」／ADR 0070 測ったこと3: 「⟹ ADR 0066『引き受けた負債』の
  『npm 上の `0.1.0` がどの commit とも一致しない』は、`0.1.1` の公開をもって解消した」）。

  **そして (b) が買おうとしていた「全部バージョン一致」は、(b) を選ぶ理由にならない**——
  版は Release tag が決めるので（ADR 0070）、**bootstrap 版が何であれ `v0.1.4` で6つとも
  `0.1.4` に揃う。**⟹ 揃うことはどの案でも同じように手に入り、
  **(b) だけが「commit を指さない版」を代償として払う。**

  ⚠ **registry 上の版が揃っていることを見ている歯は無い。**`--expect-version` と
  `check-publish-pack.mjs` の検査項目2 が見ているのは**作業ツリーの `package.json`** であって、
  registry ではない。⟹ (b) が買う「揃い」は、**門が見ていない揃い**である。

- **⭐ 測ったこと5 — 🔴 この作業者が (b) に対して立てた反論は、間違っていた（訂正の記録）**

  **この節は、この ADR の作業者自身の誤りの記録である。**

  (b) に対して最初に立てた反論は「`local-embedding@0.1.3` は中身が #127 由来なのに
  `@mnemora/core: ^0.1.3` を要求するので、利用者に古い core が入って壊れる」だった。
  **測ったら、壊れない**:

  | | |
  |---|---|
  | `local-embedding` が core から取るもの | **型3つだけ** — `Ctx` / `EmbeddingProvider` / `EmbeddingSpaceId`（`import type` のみ。実行時に core を触らない） |
  | `EmbeddingProvider` interface | `core@0.1.3` の `dist/interfaces/embedding-provider.d.ts` と main の `src/interfaces/embedding-provider.ts` が**一字一句同じ**（`readonly space` と `embed(ctx, texts)` の2員のまま。ADR 0090 も ADR 0095 もこの interface を変えていない） |

  ⟹ **(b) は技術的には成立した。**落とした理由は測ったこと4 の1点だけであり、
  **「壊れるから」ではない。**

  ⚠ **推測を事実の顔で言いかけた。**AGENTS.md「確かめていないことは『確かめていない』と書く」
  に反しており、**測る前に反論として提示したのが誤りだった**（オーナーへは訂正済み）。

- **⭐ 測ったこと6 — 公開前に直すべき点が1つ在った（linux/x64 で CUDA EP が落ちてくる）**

  `packages/local-embedding/README.md` は
  「**このリポジトリでは** `onnxruntime-node` の postinstall を拒否している」としか書いておらず、
  **`allowBuilds` は公開物に付いていかない。**⟹ 利用者には何も届いていなかった。

  `onnxruntime-node@1.24.3` の `script/install-metadata.js` を読んで測った既定値:

  | プラットフォーム | postinstall が落とすもの |
  |---|---|
  | **`linux/x64`** | 🔴 **`cuda12`**（このリポジトリの既存実測で 302MB） |
  | `linux/arm64` / `darwin/x64` / `darwin/arm64` / `win32/x64` / `win32/arm64` | 無し（`[]`） |

  `script/install.js` の既定経路（`INSTALL_FLAG === undefined`）は、
  **依存として入るとき早期 return しない**（早期 return するのは
  `--onnxruntime-node-install=skip` のときと、`<ORT_ROOT>/js/node/` 内のローカル install のとき）。

  ⚠ **効くのは linux/x64 ——大半の CI runner・Docker image・サーバである。**
  手元の mac では起きないので、**気づくのは本番の image を焼くときになる。**
  ⟹ README に、npm / yarn / pnpm 別の止め方（`ONNXRUNTIME_NODE_INSTALL=skip` 等）を書いた。

- **⭐ 測ったこと7 — 🔴 落ち方の予測が外れた。403 ではなく E404 だった**

  **この ADR は「確かめていない」として「`local-embedding` だけ 403 で落ちる」と書き、
  「ずれたらこの ADR を直すこと」と条件を付けていた。ずれたので直す。**

  run [`34452890407`](https://github.com/takecchi/mnemora/actions/runs/34452890407) の実測:

  ```
  ✔ @mnemora/core@0.1.4 を publish した
  ✔ @mnemora/testkit@0.1.4 を publish した
  ✔ @mnemora/openai@0.1.4 を publish した
  ✔ @mnemora/postgres@0.1.4 を publish した
  ✔ @mnemora/anthropic@0.1.4 を publish した
  npm error code E404
  npm error 404 Not Found - PUT https://registry.npmjs.org/@mnemora%2flocal-embedding - Not found
  ✗ @mnemora/local-embedding@0.1.4 の publish が失敗した（exit 1）
  ```

  **⭐ 順序の予測は当たり、落ち方の予測だけが外れた。**5つが完走してから末尾が落ちており、
  `PUBLISH_TARGETS` の「未公開は末尾」の規律は**設計どおりに働いた。**

  **なぜ 403 と予測したのが誤りだったか。**ADR 0070 測ったこと3 が
  **403 と 404 の使い分けを既に測っていた**（逐語）:

  > repo / workflow 名の不一致でもない（**不一致なら npm は 404 を返す**——
  > registry は 403 を意図的に 404 で隠す。今回は `PUT` まで到達して
  > **「this action」を名指しした 403** ⟹ **npm は身元を認識していた**）

  ⟹ **403 は「身元は認識したが、その操作は許していない」**であり、
  **404 は「そもそも身元を結び付ける先が無い」**である。
  `v0.1.1` が 403 だったのは**パッケージが既に在り**、信頼発行元だけが未設定だったから。
  今回は **パッケージ自体が存在しない**ので、npm には結び付ける先が無い ⟹ **404 が正しい。**

  🔴 **この ADR は、参照した ADR 0070 に答えが書いてあったのに読み違えた。**
  `v0.1.1` の事例（既存パッケージ）を、初版（不存在）へそのまま当てたのが誤りである。
  ⟹ **教訓: 403 と 404 は「未設定」と「不存在」を区別する信号であって、
  どちらも『権限が無い』ではない。**

- **⭐ 測ったこと8 — 段0 を実行した（実行記録）**

  | | |
  |---|---|
  | 梱包元 | **`v0.1.4` の tag を checkout**（`faa25c6`）。⭐ **`packages/` は手元のブランチと `git diff --name-only` で差分ゼロ**だったことも別途確認した |
  | 版の書き込み | `RELEASE_TAG=v0.1.4 node scripts/apply-release-version.mjs`（**CI と同じ経路**）→ 6つとも `0.1.1 -> 0.1.4`、`npm_tag=latest` |
  | 門 | **`pnpm run pack:check` を tag の上で通した**（6パッケージ、検査項目8つ） |
  | tarball | `version: 0.1.4` / `@mnemora/core: ^0.1.4`（**`workspace:` は 0 件**）/ `license: MIT` / `access: public` / `dist` 8ファイル + `README.md` + `LICENSE` |
  | publish | `npm publish <tarball> --access public --tag latest` → **`+ @mnemora/local-embedding@0.1.4`** |
  | 依存の順序 | ⭐ tarball が `^0.1.4` を要求するので、**段0 は CI が `core@0.1.4` を出した後でなければならなかった**。「Release を先に切る」順序がこれも満たしていた（**この含意は決定時に見えていなかった。結果的に正しかっただけである**） |

  **⭐ ADR 0066 測ったこと8 の「読み取りが書き込みに遅れる」を再確認した。**
  `npm publish` が `+` を出した時刻は **08:05:57Z**（registry の `time` も同じ）だが、
  その後**約4分間、読み取りは 404 を返し続けた**——`npm view`（未認証・認証つきの両方）と、
  **CDN を迂回する `?write=true` も 404** だった。t+4min で HTTP 200 になった。

  ⟹ **publish の成否は `npm publish` の出力で判断するのが正しい**（workflow の逐語コメントの
  とおり）。**この4分間に「失敗した」と判断して再実行すると、E403 を見て混乱する。**

  最終状態:

  | package | npm |
  |---|---|
  | core / testkit / openai / postgres / anthropic | **0.1.4**（OIDC + provenance） |
  | **local-embedding** | **0.1.4**（`dist-tags: { latest: "0.1.4" }` / `versions: ["0.1.4"]` / **provenance なし**） |

- **⭐ 測ったこと9 — 素の consumer で往復した（公開物が実際に使える）**

  ADR 0066 測ったこと1 と同じ検査を、**registry から取った実物**に対して行った:

  | | 結果 |
  |---|---|
  | `npm install @mnemora/local-embedding@0.1.4`（素の npm、`--ignore-scripts`） | **成功**。`^0.1.4` が **`@mnemora/core@0.1.4` に解決された** |
  | `import("@mnemora/local-embedding")` | **成功**。13 の export が読める |
  | `new LocalEmbeddingProvider().space` | **`{ provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 }`** |

  ⭐ **`space` がモデルを読み込まずに確定していることも、ここで裏が取れた**
  （README の主張どおり。`new` は 42MB を落とさない）。

- **⭐ 測ったこと10 — ⚠ 公開物の依存に high が5件在る（すべて推移的・`fixAvailable: false`）**

  素の consumer で `npm audit` を打った結果（`high: 5` / `critical: 0`）:

  | package | 経路 | 中身 |
  |---|---|---|
  | `adm-zip` | `onnxruntime-node` → | 細工した ZIP で 4GB 確保 / **展開時に destination symlink を辿り任意ファイルを上書き** |
  | `onnxruntime-node` | `@huggingface/transformers` → | 上の `adm-zip` |
  | `sharp` | `@huggingface/transformers` → | libvips（CVE-2026-33327 / -33328 / -35590 / -35591）と libheif（GHSA-g89c-p67h-r497 / GHSA-2jg2-4ch7-h545）の継承 |
  | `@huggingface/transformers` / `@mnemora/local-embedding` | — | 上2つの巻き上げ |

  ⭐ **脆弱な経路は、どちらもこのパッケージが使わない経路である**——
  `sharp` は**画像入力**用（`pnpm-workspace.yaml` の既存コメントが「テキスト埋め込みでは
  通らない」と書いている）で、`adm-zip` は **`onnxruntime-node` の postinstall が
  アーカイブを展開するところ**である。

  🔴 **⟹ 測ったこと6 で README に書いた「postinstall を止めろ」は、302MB を節約する話だと
  思って書いたが、`adm-zip` の展開経路そのものを踏まないことでもあった。**
  **止める理由が1つ増えている**（この含意は README を書いた時点では見えていなかった）。

  ⚠ **`fixAvailable: false`**——上流に修正版が無いので、この repo では直せない。
  ⛔ **`@huggingface/transformers` を捨てる判断はしない**（ADR 0085 の土台であり、
  この ADR の範囲外である）。**測って記録するところまでが、ここでできることである。**

- **決定**:

  **1. bootstrap 版は `0.1.4`。中身は `v0.1.4` の tag から梱包する。**

  測ったこと4 が (b) を落とし、残る (a) / (c) の差は
  「`latest` を作るか」と「main を今リリースするか」だった。オーナーは (a) を選んだ。
  **(a) だけが、registry 上の全版が commit を指す状態を保つ。**

  **2. `v0.1.4` の Release を先に切る。publish run が1回赤くなることを受け入れる。**

  Release → CI が `PUBLISH_TARGETS` の順に publish → **5つは OIDC + provenance で成功し、
  末尾の `local-embedding` だけ落ちる**（⚠ 落ち方は 403 と予測したが、実測は **E404**。測ったこと7）。

  ⭐ **この形は `scripts/publish-targets.mjs` が明示的に想定している**（逐語):

  > **未公開のものが途中に居ると、その後ろが publish されない。**
  > `@mnemora/anthropic` を4番目に置いていた時点では、失敗したときに
  > **`@mnemora/postgres` が取り残される**形だった

  ⟹ **末尾に置く規律が、まさにこの赤を「他を巻き込まない赤」にしている。**
  段1・段2 の後に workflow を再実行すれば、6つとも
  「既に上がっている版を飛ばす」冪等分岐に落ちて**緑になる**（ADR 0066 決定）。

  **3. 手元の梱包は `scripts/apply-release-version.mjs` を通す。**

  `v0.1.4` を checkout しても `package.json` の `version` は `0.1.1` である
  （版の権威は tag であって git の値ではない。ADR 0070）。
  ⟹ **CI が使うのと同じスクリプトで書き込んでから `pnpm pack` する。**
  手元で `0.1.4` と手で書くと、**版の決め方が2箇所になる**（ADR 0070 が1箇所に集めた意味が消える）。

- **採らなかった案**:

  | 案 | なぜ採らないか |
  |---|---|
  | **(b) `0.1.3` に揃える** | 測ったこと4。`v0.1.3` に `packages/local-embedding` が存在しないので、**どの commit も指さない `latest`** ができる。ADR 0070 が解消を宣言した負債の再導入。**そして買おうとしていた「版の揃い」は (a) でも同じように手に入る**（版は tag が決めるため）。⚠ 技術的には成立する（測ったこと5）——落としたのは追跡可能性の1点である |
  | **(c) `0.1.4-bootstrap.0` + `--tag bootstrap`** | `latest` を作らないので**本物の `0.1.4` が最初から provenance 付きの `latest` になる**という利点が在り、**main を今リリースしたくない場合はこれが最善だった。**採らなかったのは、オーナーが `v0.1.4` を今切ると判断したためである。⟹ **この案は「覆るとしたら」の側に残る**（次に新しいパッケージを足すとき、まだ main をリリースできない状態なら、これが第一候補になる） |
  | **初版も CI から出す（`NPM_TOKEN` を一時的に置く）** | ADR 0066 が既に却下している（長期トークンを CI に置くのは Trusted Publishing を選んだ理由そのものに反する）。**今回はさらに悪い**——測ったこと1 の警告どおり、2FA を迂回するトークンは直接 publish を制限されつつある |
  | **`local-embedding` を `PUBLISH_TARGETS` から一時的に外して `v0.1.4` を緑で通す** | 赤い run を1回避けられるが、**「publish 対象なのに出ていない」状態が門から見えなくなる。**外したことを戻し忘れれば、次の Release でも黙って出ない。**赤は情報である**——`publish-targets.mjs` の規律は赤を消すためではなく、赤が他を巻き込まないために在る |
  | **README の onnxruntime の点を後回しにする** | tarball には README が入る。**初めて npm に現れる版の README が、利用者に何も伝えない状態で固定される。**直すのは今回が最後の機会に近い（測ったこと6） |

- **引き受けた負債**:

  1. 🔴 **`@mnemora/local-embedding@0.1.4` に provenance が付かない。**OIDC で初版を出せないため
     （測ったこと3）。**6パッケージ中1つ、1版だけ**の非対称であり、`v0.1.5` 以降は解消する。
     ⚠ ADR 0066 が `0.1.0` について引き受けた負債と**同じ種類**だが、範囲は狭い
     （あちらは4パッケージ全部で、かつ中身が commit と一致しなかった。今回は
     **中身は `v0.1.4` の tag と一致する**）。
  2. **`v0.1.4` の publish run が赤で履歴に残る。**再実行で緑になるが、
     **「赤い run が正常だった回」が1つできる。**この ADR がその唯一の説明である。
  3. ✅ **段0 のトークン露出 — 解消済み。**2026-09-10 に revoke された
     （実測: `npm whoami` が `E401`）。**⛔ 確認も作業も要らない。**
     教訓のみ: 次の段0 はトークンを渡さず、オーナー自身が打つ。
  4. **段0 の経路そのものが失われうる。**npm が 2FA 迂回トークンの直接 publish を
     制限しきると、**次に新しいパッケージを足すときの段0 が打てなくなる**
     （その場合はオーナーが 2FA 付きの対話的 publish を打つほかない）。
  5. **`PUBLISH_TARGETS` への足し忘れは、今回も機械的に検知できない。**
     ADR 0060・ADR 0066 と同じ負債のまま。**今回はたまたま足されていた。**
  6. **README に書いた `ONNXRUNTIME_NODE_INSTALL=skip` の経路は、この repo では測っていない。**
     pnpm が既定で postinstall を拒否している状態で動くことは測ってあるので
     「CUDA EP 無しで動く」は押さえられているが、**npm 経路でその env を渡す形そのもの**は
     未検証である（README にもそう書いた）。
  7. 🔴 **`0.1.4` の README は、測ったこと10（依存の high 5件）を書いていない。**
     **公開された版の README は、もう直せない。**測ったのが publish の後だったためである。
     ⟹ **README への追記はこの ADR と同じ変更に含めた**ので `0.1.5` から載るが、
     **`0.1.4` を install した人には届かない。**
     ⚠ **順序を間違えたことが、この負債の本体である**——
     測ったこと6（README を直す）と測ったこと10（audit）は**同じ検査で一緒に出るべきもの**
     だった。**素の consumer での往復を publish の前に一度もやっていない**
     （やれたはずである。`pnpm pack` の tarball を直接 install すればよかった）。
     ⟹ **次に新しいパッケージを出すときは、往復を段0 の前に置くこと。**
  8. 🔴 **段1・段2 が済んでいないので、`local-embedding` は次の Release でも publish されない。**
     `v0.1.5` を切ると、**同じ 404 でまた赤くなる**（`0.1.4` が在るので今度は 403 になるはずだが、
     **これも予測であって実測ではない**——測ったこと7 で一度外している）。
     ⟹ **段1・段2 は次の Release より前に済ませる必要がある。**

- **これが覆るとしたら**:

  - **[npm/cli#8544](https://github.com/npm/cli/issues/8544) が閉じたとき。**
    段0 が要らなくなり、**新しいパッケージは Release を切るだけで出る。**
    決定1〜3 のすべてが不要になる。
  - **npm が 2FA 迂回トークンの直接 publish を完全に止めたとき。**負債4 が発火する。
    段0 は「オーナーが対話的に打つ」だけになり、**この ADR の「作業者が段0 を打つ」形は消える。**
  - **オーナーが版の進め方を個別に変えると決めたとき。**`--expect-version` が
    「6つとも同じ版」を前提にしているため、bootstrap の議論そのものが変わる
    （新しいパッケージを `0.1.0` から始められるようになり、(c) 相当の案が要らなくなる）。
  - **`npm trust` が許可アクションの切り替えに対応したとき。**段2 が CLI から打てるようになり、
    測ったこと2 の「代行できない」が段1 だけに狭まる。

- **確かめたこと / 確かめていないこと**:

  - **確かめた（この器で実行）**: 測ったこと1〜10 のすべて。
    `npm whoami` が `takecchi` を返すこと。`npm trust list` が E403 になること。
    `npm trust github --help` に許可アクションのフラグが無いこと。
    既存版への publish が**版の衝突**で拒否され、`dist-tags` に副作用が無いこと。
    `git ls-tree -d v0.1.3 packages/` に `local-embedding` が無いこと。
    `core@0.1.3` の tarball を取得して `EmbeddingProvider` の `.d.ts` を main と突き合わせたこと。
    `onnxruntime-node@1.24.3` の `install-metadata.js` の `requirements`。
    `pnpm run pack:check` が**6パッケージで通ること**（手元のブランチと、`v0.1.4` の tag の上で2回）。
  - **確かめた（段0 と Release を実行した）**: 測ったこと7〜10。
    run `34452890407` の実測（5つ成功 → 末尾が **E404**）。
    `@mnemora/local-embedding@0.1.4` が **`+` を出して publish されたこと**と、
    その後**約4分間 読み取りが 404 だったこと**（`?write=true` を含む）。
    6パッケージとも `0.1.4` であること。素の consumer での install → `import` →
    `space` の確認。`npm audit` の high 5件。
  - **⚠ 外した予測（記録として残す）**: **落ち方を 403 と書いたが E404 だった**（測ったこと7）。
    **参照した ADR 0070 に答えが書いてあったのに読み違えた。**
  - **確かめていない**: **段1・段2 の後に workflow を再実行して緑になること。**
    冪等分岐は ADR 0066 が実測しているが、**6パッケージ全部が飛ばされる形**は走っていない。
    ⟹ **段1・段2 が済んだら、この ADR を3度目に直すこと。**
  - **確かめていない**: **`0.1.4` が実際にモデルを落として推論できること。**
    測ったのは `import` と `space` までで、`embed()` は**一度も呼んでいない**
    （42MB のダウンロードを伴うため）。live テストは repo 内では opt-in で在る。
  - **確かめていない**: `ONNXRUNTIME_NODE_INSTALL=skip` を渡した npm 経路（負債6）。
  - **確かめていない**: DB を要する経路（`DATABASE_URL` を立てていない。ADR 0015 と同じ非対称）。
    **梱包と publish の判断は DB に依存しない**と見た。
