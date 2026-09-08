# ADR 0061: ライセンスを MIT にする

- **状態**: 採用 (2026-09)

- **⚠ この ADR が決めていないこと（先に書く）**:

  この ADR は**ライセンスの選定と、その配布**についてだけを記録する。
  次の1つは**この ADR の対象外であり、ここでは何も決めていない**。

  | 決めていないこと | いまの状態 | どこで決まるか |
  |---|---|---|
  | **`"private": true` を外すこと（= publish を始めること）** | 6つすべてに立ったまま。この PR でも外していない | **別の判断（ADR 0060 と同じ整理）。**外す行為そのものが「publish してよい」の決定であるため、この ADR では外さない |

  **⟹ この ADR を「publish してよい」と読まないこと。**
  ここで整えたのは「publish するとなったときに、ライセンスの側で止まる理由が無いこと」だけである。
  `scripts/__tests__/check-publish-pack.test.mjs` の「`private: true` のままである」歯（ADR 0060 で追加）は、
  この ADR でも**触っていない**——存置したままである。

- **文脈**:

  ADR 0060 の時点で、ライセンスは6つとも `"license": "UNLICENSED"` のままで、LICENSE ファイルも
  リポジトリのどこにも無かった（ADR 0060 冒頭の表に明記済み）。ADR 0060 はこれを
  「オーナーの判断待ち」として意図的に対象外にしていた。

  オーナーへの逐語の問いと回答:

  > **問い**: mnemora のライセンスを何にしますか。(a) MIT / (b) Apache-2.0 / (c) UNLICENSED のまま
  > （publish しない）。私の推奨は (a) MIT です。
  >
  > **オーナーの回答**: 「(a) MIT」

  **これはオーナーの決定である。**この ADR の書き手（作業者）が選んだものではない。

  著作権者の表記は `Copyright (c) 2026 takecchi` である。

  **⚠ この節は後から直したものである。**この ADR を採用した時点の表記は
  `Copyright (c) 2026 Takeaki Kobayashi` だった。それは
  `gh api users/takecchi --jq .name` で確認した GitHub の表示名を、この ADR の書き手が
  **機械的に採った値であり、オーナー本人の確認を経ていなかった。**そのため当時のこの節は
  「違う表記を望むなら、オーナーが直接指定し次第、LICENSE 6ファイルと本 ADR のこの節を直す」
  と書いていた。

  **2026-09-08、オーナー本人が確認した。**「`Copyright (c) 2026 Takeaki Kobayashi` で
  合っているか」という問いへの逐語の回答は「**あってるけどtakecchiじゃだめかな**」であり、
  **オーナーは `takecchi` を指定した。**⟹ 当時この節が書いていた条件がそのまま満たされたので、
  書いてあるとおりに **LICENSE 6ファイルと本節を直した**（PR #74）。
  **⛔ これは作業者の判断ではなく、オーナーの決定である。**

- **測ったこと — npm/pnpm の LICENSE 自動継承（実測）**:

  publish 対象4パッケージ（`@mnemora/{core,testkit,postgres,openai}`）はいずれも
  `files: ["dist", ...]` を持ち、`LICENSE` を明示的には含んでいない。それでも
  **`README.md` / `package.json` と同様、`LICENSE` は `files` の指定に関わらず
  常に tarball へ含まれる**（npm/pnpm 双方に共通の既知の挙動）。

  さらに実測して分かったこと: **パッケージ自身のディレクトリに `LICENSE` が無い場合、
  `pnpm pack` は同じ git リポジトリ内の祖先ディレクトリ（ここではリポジトリルート）にある
  `LICENSE` を自動的に見つけて tarball に差し込む。**

  検証手順と結果:
  1. `packages/testkit/LICENSE` を削除し、ルートの `LICENSE` は残したまま `pnpm pack` を実行
     → tarball に `LICENSE` が入った（中身はルートの `LICENSE` と一致）。
  2. さらにルートの `LICENSE` も退避（`mv` で一時的に除去）してから同じことをすると
     → tarball から `LICENSE` が消えた（`tar tzf` で確認）。このとき
     `scripts/check-publish-pack.mjs` を実行すると
     `[@mnemora/testkit] LICENSE ファイルが tarball に入っていません` で **実際に赤くなった**。
  3. 両方を復元すると、緑に戻った。

  **⟹ 実務上は「ルートに `LICENSE` を置くだけ」でも4パッケージの tarball に `LICENSE` は入る。**
  ただし、この ADR は**この自動継承には依存しない**（下の決定を参照）。

- **決定**:

  **1. ライセンスは MIT。**6つの `package.json`（ルート `mnemora` / `packages/core` /
  `packages/testkit` / `packages/postgres` / `packages/openai` / `examples/chat`）すべての
  `license` フィールドを `"MIT"` にする。`UNLICENSED` は1つも残さない。

  **2. `LICENSE` の実ファイルを、ルートと publish 対象4パッケージそれぞれのディレクトリに
  複製して置く（`examples/chat` にも置く）。**

  上の実測どおり、ルートに置くだけでも pnpm の自動継承で4パッケージの tarball には入る。
  **それでも各パッケージのディレクトリに実ファイルを複製したのは、その自動継承に
  依存したくないからである**——祖先ディレクトリの探索は「同じ git リポジトリ内」が条件になっており、
  git 履歴を持たない配布物（例: git 情報を落とした snapshot tarball からの再 pack、
  あるいは将来 npm 以外の道具でパッケージ単体を pack する経路）では効かない可能性がある。
  **配布の道具（pnpm）の非公式な親切機能ではなく、各パッケージ自身が LICENSE を
  持っている状態を、明示的な形で作る。**

  ルートに置いた理由は2つ: (a) GitHub のライセンス検出のため（`gh api repos/takecchi/mnemora`
  の `license` フィールドは、この PR の前は `null` だった）。(b) 上記4パッケージへの自動継承の
  土台として機能する（実ファイルの複製と自動継承は排他ではなく、両方が効く）。

  `examples/chat` は publish 対象ではない（ADR 0060 決定1）が、公開リポジトリの一部として
  読まれる・clone されることはあるため、ここにも `LICENSE` を置いた。

  **3. `files` フィールドには触っていない。**

  上の実測のとおり、`LICENSE` は `files` に列挙しなくても常に tarball へ含まれるため、
  4パッケージの `files: ["dist", ...]`（`postgres` は `["dist", "migrations"]`）はそのままにした。

  **4. tarball の中身を検査する門を拡張した（`scripts/publish-pack-checks.mjs` /
  `scripts/check-publish-pack.mjs`）。**

  新しい仕組みは作らず、ADR 0060 で作った既存の門を拡張した。追加したのは
  `findLicenseViolations(manifest, packageDir)`——**pack して展開した tarball 側の
  `package.json`（作業ツリーのものではない）**の `license` が `"MIT"` と等しいか、
  および同じディレクトリに `LICENSE` が実在するかを検査する純粋関数である。
  `check-publish-pack.mjs` の検査項目バナーにも、既存の6項目と並ぶ形で
  「7. license が "MIT" であり、LICENSE ファイルが tarball に入っていること」を足した。

  **「`UNLICENSED` でないこと」ではなく「`MIT` と等しいこと」を検査する。**
  前者は `Apache-2.0` のような隣の値をそのまま通してしまう弱い歯になる——
  オーナーは MIT を名指しで選んでおり、この ADR が検査したいのは
  「publish 可能な何らかの値」ではなく「選んだ値そのもの」である
  （下の「変異試験」参照）。

  既存の静的 `describe`（`scripts/__tests__/check-publish-pack.test.mjs` の
  「publish 対象4パッケージの package.json（静的）」）にも、4パッケージそれぞれについて
  「license が MIT である」を足した。**ただしこれは作業ツリーの package.json を読むだけの
  補助的な歯であり、tarball の中身を見る動的な歯の代わりにはならない**（コメントに明記）。

- **測ったこと — 変異試験**:

  | # | 変異 | 結果 |
  |---|---|---|
  | 1 | `packages/openai/package.json` の `license` を `MIT` → `UNLICENSED` に戻す（1パッケージだけ） | 赤くなったのは `@mnemora/openai > license が MIT である` の静的な歯**と**、動的な門の歯（`本物どおり起動すると EXIT=0 になる`）の**2本だけ**。他の3パッケージの静的な歯は緑のまま——変異を入れたパッケージだけが赤くなることを確認した |
  | 2 | `packages/postgres/package.json` の `license` を `MIT` → `Apache-2.0` に | 同じ2本が赤くなった。「`UNLICENSED` でないこと」だけを見る弱い歯だとこの変異は通ってしまうが、「`MIT` と等しいこと」を見る歯は隣の値も落とした |
  | 3 | `packages/testkit/LICENSE` を1つだけ消す | **単独では赤くならなかった**——pnpm がルートの `LICENSE` を自動継承したため（上の「測ったこと」参照）。ルートの `LICENSE` も併せて退避すると、動的な門が `[@mnemora/testkit] LICENSE ファイルが tarball に入っていません` で実際に赤くなることを確認した |
  | 4 | `findLicenseViolations` を `return []` に潰す | `findLicenseViolations（ADR 0061）` describe 内の**「検出する」側の4件**（`UNLICENSED` 検出・`Apache-2.0` 検出・LICENSE 欠落検出・両方欠落で2件検出）が赤くなった。「検出しない」側の1件は `[]` と `[]` の比較になり偽陰性のまま緑という、ADR 0060 の同種の変異試験と同じ形の結果だった |

  変異はすべて元に戻し、`git status` / `git diff` で残っていないことを確認した。
  詳しい段階別の記録（段0〜段6）は本 PR の説明に書く。

- **採らなかった案**:

  | 案 | 却下の理由 |
  |---|---|
  | **Apache-2.0** | オーナーが逐語で MIT を選んだ。技術的な優劣で覆す理由が無い |
  | **UNLICENSED のまま（publish しない）** | オーナーが逐語で MIT を選んだ。加えて、`docs/roadmap.md` の Phase 1 が一巡しており、publish を見据えた ADR 0060 がすでに採用されている——ライセンス不在のまま止め置く理由が無い |
  | **`LICENSE` をルートだけに置き、各パッケージへは複製しない（自動継承に委ねる）** | 実測で「動く」ことは確認したが、**git リポジトリの祖先探索という pnpm 側の非公式な親切機能に依存する形**になる。パッケージ単体が git 履歴を離れて再配布される経路（稀だが否定はできない）で無言で壊れうる。各パッケージが自分自身で `LICENSE` を持つ方が、依存先が少ない |
  | **symlink で各パッケージへ配る** | tarball 化で symlink が壊れる既知の落とし穴がある。実測はしていない（実ファイル複製で要件を満たせたため、この案を試す必要が無かった）。**⟹ symlink 案の tarball 実測は未確認のまま** |
  | **`prepack` スクリプトでルートから複製する** | 動くと思われるが、`tsconfig.build.json` や `package.json` の `scripts` 欄（今回触ってよい範囲外）に手を入れる必要が生じる。実ファイルの複製という、触るファイルが少ない案で足りたため採らなかった |
  | **`files` に `"LICENSE"` を明示的に足す** | 実測のとおり、`LICENSE` は `files` の指定に関わらず常に含まれるため、足しても意味が無い。**触らなくてよいものを触らない** |

- **引き受けた負債**:

  - **ルートと4パッケージ（+ `examples/chat`）に置いた6枚の `LICENSE` は実ファイルの複製であり、
    内容が食い違っても、それを検出する歯は無い。** 例えば誰かがルートの `LICENSE` の著作権年だけ
    書き換えて、他の5枚を直し忘れても、この PR で足した門はそれを検出しない
    （門が見るのは「MIT かどうか」と「存在するかどうか」だけで、6枚の内容が同一かどうかは見ていない）。
    **この負債を歯で塞ぐかどうかは、この ADR では決めていない**——塞ぐなら、6枚のハッシュ比較を
    `publish-pack-checks.mjs` に追加する形になるだろうが、今回はスコープに含めなかった。
  - **著作権者の表記は、この ADR の採用時点ではオーナー本人の確認を経ていなかった**
    （GitHub の表示名から機械的に決めた `Takeaki Kobayashi`）。**⟹ この負債は
    2026-09-08 に決着した。**オーナー本人が確認し、逐語で「あってるけどtakecchiじゃだめかな」と
    回答して `takecchi` を指定した。LICENSE 6ファイルと上の「文脈」節を、その指定どおりに
    直した（PR #74）。**⚠ 「経ていなかった」という当時の限界の記録は、消さずにここに残す**
    ——後から読む人が「誰がいつ何と言って決めたか」を辿れるようにするためである。
  - **`findLicenseViolations` は `license` フィールドと `LICENSE` ファイルの存在だけを見る。**
    `LICENSE` の中身が実際に MIT のテキストであるかどうか（誤って別のライセンス文を
    貼ってしまった場合など）は検査していない。

- **これが覆るとしたら**:

  - **オーナーが別のライセンスへ変える判断を下したとき。**決定1・2 は全面的に上書きされる。
  - **pnpm がパッケージディレクトリ外からの `LICENSE` 自動継承をやめたとき。**
    そのときも、各パッケージが自身の実ファイルを持っているため、この ADR の決定2は影響を受けない
    ——**むしろ、自動継承に頼らなかったことがここで効く。**

- **確かめたこと / 確かめていないこと**:

  - **確かめた（この器で実行）**: 6つの `package.json` の `license` が `MIT` であること。
    4パッケージを実際に `pnpm pack` し、tarball を展開して `LICENSE` が実在し
    `package.json` の `license` が `MIT` であることを目視・機械的に確認した。
    pnpm の `LICENSE` 自動継承の挙動（上の「測ったこと」の実測手順）。
    上表の変異試験1〜4。`pnpm run typecheck` / `lint` / `format:check` / `test` / `pack:check` / `build`。
  - **確かめていない**: `npm publish` / `pnpm publish`（`--dry-run` を含む）は一度も実行していない
    （意図的に禁じられている）。DB を要する経路（`DATABASE_URL` が無い。ADR 0015 と同じ非対称）。
    著作権者表記についてのオーナー本人の確認。symlink 案を採った場合の tarball 実測。
