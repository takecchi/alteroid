---
name: test-in-chunks
description: 作業者（AI）が `pnpm test` を回すときに読む。Bash の既定タイムアウト（作業者は約300秒）で背景へ落ちる・大きな出力が保存ファイルへ回されて読もうとして拒否で止まる、の2つを避けるための「小さく分けて、小さい出力で回す」手順。パッケージ・shard ごとの推奨コマンド、既定 reporter が `dot` へ倒れる条件（`scripts/test-guard-core.mjs` の `resolveReporterArgs`）、この器で `CI=true` が既定で入っていて自動では効かないこと、実測の分割表（観測時刻つき）を持つ。
---

# `pnpm test` を小さく分けて、小さい出力で回す

## これが要る理由

作業者がこのリポジトリで `pnpm test`（または `pnpm --filter <pkg> test`）を素の
まま1本で回すと、2つの形で止まることがある。

1. **Bash ツールの既定タイムアウト**（作業者は約300秒）に当たり、コマンドが
   前景から背景へ自動的に移される（`.claude/skills/tool-quirks/SKILL.md`
   「`Bash` は `timeout` を指定しないと約120秒で制御を返す」と同じ族——閾値は
   ツール・版で違うが、**指定しなければ待たされずに背景へ落ちる**という形は同じ）。
2. **vitest 既定の reporter（`default`）の出力が大きくなり**、道具が「大きな
   出力は保存ファイルへ回す」形へ落とすことがある。作業者がその保存ファイルを
   読もうとして拒否（`[PII Data Handling]` 等）で止まる。

対策は3つ組み合わせる——**(a) Bash ツールの `timeout` パラメータを明示する**
（600000ms 以下。シェルの `timeout` コマンドだけでは足りない——外側の Bash
ツール自身のタイムアウトは別に効くため、両方を揃える）、**(b) vitest の
reporter を `dot` にする**（通ったテスト1本ごとの行を出さず、出力を小さくする）、
**(c) パッケージ・shard 単位で分けて回す**（1回のコマンドが長時間・大出力に
ならないようにする）。

## (b) 既定 reporter が `dot` へ倒れる条件——ただしこの器では自動では効かない

`scripts/test.mjs` は `scripts/test-guard-core.mjs` の `resolveReporterArgs` /
`hasReporterFlag` を使い、**3条件がすべて揃ったときだけ** `--reporter=dot` を
既定にする——(1) 利用者が `--reporter` を1つも渡していない (2) `stdout` が
TTY でない (3) `CI` が未設定。

**⚠️ この器（Claude Code の Bash ツール）は `CI=true` を既定で環境に持つ**
（実測: `node -e "console.log(process.env.CI)"` で `true` が返る、観測
2026-09-29）。**⟹ 条件(3)が最初から満たされないので、作業者がこの Bash ツール
経由で `pnpm test` を打つ限り、上の歯は自動では効かない。** 効かせたいときは
明示的に `--reporter=dot` を渡すか、`env -u CI` で `CI` を外して打つこと
（後者は実測で確認済み——下の「実測した生コマンドと結果」を見よ）。

**変異試験ハーネスは影響を受けない。** `.claude/skills/mutation-testing/
mutate-core.mjs` は `pnpm test` を呼ぶときに `--reporter=default` を明示する
ので、`hasReporterFlag` が真になりこの歯を素通りする（値は変わらない）。

**⟹ この器で実際に使う形は、下の推奨コマンドのとおり `--reporter=dot` を
明示すること。** 既定が自動で効く器（`CI` が無い環境）では省略してもよいが、
省略した場合の挙動を確かめずに信じないこと——`CI` の値は自分で
`node -e "console.log(process.env.CI)"` などで確かめられる。

## (a) Bash ツールの timeout と、出力を絞る形

- **Bash ツールの `timeout` パラメータを毎回明示する**（600000ms＝600秒以下。
  シェルの `timeout <秒>` コマンドと**両方**要る——外側（Bash ツール自身の
  制御）と内側（プロセスの寿命）は別の機構である）。
- **シェルの `timeout` には `-k <猶予秒>` を添える**（例: `timeout -k 5 260 …`）。
  `-k` を付けないと、`timeout` が送る TERM で子プロセスが終わらなかったとき
  ハングしたまま Bash ツール側のタイムアウトまで待たされる形になりうる
  （実測: `packages/storage-pg` の shard 3/3 を `-k` 無しで 300秒・560秒の
  タイムアウトで打つと、`grep` 越しでも `tail` 越しでも1バイトも出力が
  出ないまま打ち切られた。`-k 5` を足して 585秒で打ち直すと `Duration
560.06s` で正常に完走した——**ハングではなく、単純にその shard が
  重かっただけ**だったと分かったのは `-k` を足して確実に完走させてからで
  ある。詳細は下の「実測: storage-pg の3分割が均等でない」）。
- **出力は最初から絞る**——`--reporter=dot` に加え、
  `2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|×'` で集計行・失敗行だけを
  残す。パイプの終了コードは `; echo "EXIT:${PIPESTATUS[0]}"` で取る
  （`grep` 自体の終了コードでは判定しない——`AGENTS.md`「静かに失敗する道具」
  「パイプの終了コードは、既定で最後のコマンドのものである」と同じ理由）。
- **保存された背景タスクの出力ファイルは読みに行かない。** 大きな出力が保存
  ファイルへ回されて拒否で止まったら、同じ結果を取り直そうとせず、範囲を
  絞って（下の分割）取り直す。
- **一時ファイルを作るなら `.scratch/` の下だけに置く**（`.gitignore` 済み）。
  **⚠️ リダイレクト（`>` `>>` `tee` でファイルへ書くこと）は使わないのが
  この器の既定の作法である**——`| grep` / `| tail -N` で十分に絞れないほど
  出力が大きいと感じたら、それは分割の単位が粗すぎるサインなので、まず
  shard・スコープを細かくすることを考える。

## (c) パッケージ・shard 単位で分ける——推奨コマンド

**先に `pnpm build` が要る。** ワークスペース間の型解決が各パッケージの
`dist/` に依存するため、build 前の test は失敗する（`.claude/skills/
dev-setup/SKILL.md`）。

各コマンドはリポジトリの根から打つ想定（`cd <パッケージ> && pnpm test -- …`
でも `pnpm --filter <pkg名> test -- …` でも同じ引数が通る——`--scope` は
各ワークスペースの `package.json` の `test` script が既に埋め込んでいる)。

```
pnpm build

# --maxWorkers は 1〜2 に絞る（器が混んでいると fork pool が write EPIPE で
# 死に、Test Files / Tests の集計行そのものが出ないことがある。
# AGENTS.md「静かに失敗する道具」）。

cd packages/api-client && timeout -k 5 60  pnpm test -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/cli             && timeout -k 5 60  pnpm test -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-fs  && timeout -k 5 60  pnpm test -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/runner          && timeout -k 5 60  pnpm test -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/daemon          && timeout -k 5 90  pnpm test -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/web             && timeout -k 5 150 pnpm test -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"

# root の scripts/**（railway/ ・ .github/scripts/ ・ docker/ ・ root 直下は
# scripts/ より小さいので同じコマンドで一緒に流してよい。別に測るなら
# `pnpm test railway/` のように部分一致で絞る）
timeout -k 5 90  pnpm test scripts/ -- --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"

# packages/core（309ファイル）は8分割。1本も240秒を超えない（実測は下）
for i in 1 2 3 4 5 6 7 8; do
  cd packages/core && timeout -k 5 120 pnpm test -- --shard=$i/8 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT($i/8):${PIPESTATUS[0]}"
done

# packages/storage-pg（37ファイル、@electric-sql/pglite で実サーバ不要）は3分割。
# ⚠️ shard によって重さが大きく違う（下の実測）。shard=3/3 だけ余裕を持たせる。
cd packages/storage-pg && timeout -k 5 200 pnpm test -- --shard=1/3 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && timeout -k 5 120 pnpm test -- --shard=2/3 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && timeout -k 5 590 pnpm test -- --shard=3/3 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL'; echo "EXIT:${PIPESTATUS[0]}"
```

**`pnpm test` 全体を1本では回さない。** 上のパッケージ・shard の並びを
順に（または手が空いている別の依頼と並行して）回せば、全スイートを
1回のコマンドに詰め込まずに済む。

## `--scope` と分割の口（`--shard` / `--reporter`）の関係——素通しされることの歯

各ワークスペースの `test` script（`node ../../scripts/test.mjs --root=../..
--scope=<pkg>/src` の形）は、利用者が渡す `--shard=1/3` や `--reporter=dot`
を**位置引数と取り違えない**——`scripts/test-guard-core.mjs` の
`resolveScopedArgs` / `findPositionalIndices` が `=` 形の引数
（`-` で始まる）をすべてフラグとして扱うため、`--scope` の範囲判定には
一切混ざらない。この歯（`=` 形が素通しされること）は
`scripts/test-guard-core.test.ts` の「`resolveScopedArgs は --shard=1/3 /
--reporter=dot（`=` 形）を位置引数と取り違えず素通しする`」で固定してある。

**⚠️ ただし空白区切りの値渡し（`--shard 1/3`）は別。** `--shard` は
`VALUE_TAKING_FLAGS`（`--maxWorkers` / `--minWorkers` / `--reporter` /
`--testNamePattern` / `-t` だけを持つ一覧）に入っていないため、値
（`1/3`）が素の位置引数として範囲判定に持ち込まれる。実測（`resolveScopedArgs`
経由、`--scope=pkg-a/src` に対して `--shard 1/3` を渡した場合）:

```
test-guard: 範囲内に一致なし — 「1/3」に部分一致するテストファイルが範囲
（pkg-a/src）の中に1本も無い。
綴りを確認すること。範囲の外まで見たいなら root の `pnpm test <パスの一部>`
を使うこと。
```

**⟹ `--shard` は必ず `=` 形（`--shard=1/3`）で渡すこと。** 空白区切りだと
`EXIT_SCOPE_VIOLATION`（exit 8）でテストが1本も走らないまま断られる。
この生の文言は `scripts/test-guard-core.test.ts` の「`実測: --shard 1/3
（空白区切り）を --scope と併用すると断られる`」に固定してある——**直すかどうか
は依頼者判断で、ここではまだ直していない**（`--shard` を
`VALUE_TAKING_FLAGS` へ足せば直る可能性が高いが、それ自体は未検証）。

## 実測した生コマンドと結果（観測 2026-09-29、この器・この枝で計測）

**この表は実測（測った列）である。** 「240秒以内か」の列は依頼で指定された
閾値（packages/core にのみ課された条件）に対する筆者の判定であって、実測
そのものではない——両者を混同しないこと。器は他の作業者・マネージャーと共有
なので、同じコマンドでも別の時刻には違う秒数が出ることがある。

`pnpm build` 実測: 開始 `2026-09-29T00:07:14Z` / 終了 `2026-09-29T00:08:01Z`
（約47秒、exit 0）。

| 対象                    | 実行コマンド（`--maxWorkers=2 --reporter=dot` 共通） | 観測開始(UTC) | 観測終了(UTC) | Test Files行                      | Duration行  | exit | 240秒以内か（判定）          |
| ----------------------- | ---------------------------------------------------- | ------------- | ------------- | --------------------------------- | ----------- | ---- | ---------------------------- |
| packages/api-client     | `pnpm test`                                          | 00:10:37      | 00:10:44      | 2 passed (2)                      | 4.12s       | 0    | ○                            |
| apps/cli                | `pnpm test`                                          | 00:10:17      | 00:10:32      | 22 passed (22)                    | 12.23s      | 0    | ○                            |
| packages/storage-fs     | `pnpm test`                                          | 00:10:48      | 00:11:13      | 34 passed (34)                    | 22.24s      | 0    | ○                            |
| apps/runner             | `pnpm test`                                          | 00:12:05      | 00:12:22      | 20 passed (20)                    | 14.53s      | 0    | ○                            |
| apps/daemon             | `pnpm test`                                          | 00:11:18      | 00:12:00      | 31 passed (31)                    | 39.07s      | 0    | ○                            |
| apps/web                | `pnpm test`                                          | 00:12:26      | 00:13:48      | 66 passed (66)                    | 78.97s      | 0    | ○                            |
| root scripts/           | `pnpm test scripts/`                                 | 00:57:49      | 00:58:24      | 63 passed (63)                    | 32.66s      | 0    | ○                            |
| packages/core 1/8       | `pnpm test -- --shard=1/8`                           | 00:52:14      | 00:52:44      | 39 passed (39)                    | 27.42s      | 0    | ○                            |
| packages/core 2/8       | `pnpm test -- --shard=2/8`                           | 00:54:09      | 00:54:35      | 39 passed (39)                    | 23.82s      | 0    | ○                            |
| packages/core 3/8       | `pnpm test -- --shard=3/8`                           | 00:54:39      | 00:55:04      | 39 passed（10 expected fail込み） | 21.90s      | 0    | ○                            |
| packages/core 4/8       | `pnpm test -- --shard=4/8`                           | 00:55:08      | 00:55:58      | 39 passed (39)                    | 47.64s      | 0    | ○                            |
| packages/core 5/8       | `pnpm test -- --shard=5/8`                           | 00:56:02      | 00:56:31      | 39 passed (39)                    | 26.28s      | 0    | ○                            |
| packages/core 6/8       | `pnpm test -- --shard=6/8`                           | 00:56:37      | 00:57:16      | 38 passed (38)                    | 36.16s      | 0    | ○                            |
| packages/core 7/8       | `pnpm test -- --shard=7/8`                           | 00:57:20      | 00:57:44      | 38 passed (38)                    | 21.99s      | 0    | ○                            |
| packages/core 8/8       | `pnpm test -- --shard=8/8`                           | 00:52:50      | 00:54:02      | 38 passed (38)                    | 69.93s      | 0    | ○（最大でも70秒未満）        |
| packages/storage-pg 1/3 | `pnpm test -- --shard=1/3`                           | 00:14:32      | 00:17:05      | 13 passed (13)                    | 150.02s     | 0    | ○                            |
| packages/storage-pg 2/3 | `pnpm test -- --shard=2/3`                           | 00:17:10      | 00:18:08      | 12 passed (12)                    | 55.51s      | 0    | ○                            |
| packages/storage-pg 3/3 | `pnpm test -- --shard=3/3`（`-k 5`・585秒枠）        | 00:42:27      | 00:51:50      | 12 passed (12)                    | **560.06s** | 0    | **×（240秒を大きく超える）** |

### 実測: storage-pg の3分割が均等でない

`packages/storage-pg` は37ファイルを3分割すると 13/12/12 ファイルへ分かれる
（ファイル数はほぼ均等）が、**テスト件数は 100 / 37 / 286 と大きく偏る**——
vitest の `--shard` はソートしたファイル一覧を等分割するだけで、ファイルごとの
テスト件数や実行時間は見ないため、重いテストファイルが1つの shard に集中
すると、ファイル数が同じでも所要時間は大きく変わる（今回は shard=3/3 が
286件と最多——同じ12ファイルの shard=2/3 の37件の8倍近い秒数になった）。

**⚠️ この偏りに気づく前、shard=3/3 を `timeout 300`・`timeout 560`（どちらも
`-k` 無し）で打ち、`grep` 越し・`tail -60` 越しのどちらでも出力が1バイトも
出ないまま打ち切られたことがある。** 一見「ハングした」ように見えたが、
`-k 5` を足して十分な枠（585秒）で打ち直すと `Duration 560.06s・exit 0` で
正常に完走した——**実際には単に重い（560秒かかる）だけで、ハングでは
なかった**。`timeout`（`-k` 無し）だけだと、指定秒数で SIGTERM を送っても
子プロセスがちょうど処理の山場で終了できず、そのまま Bash ツール側の
外枠まで無出力で待たされる形になりうる、という当時の仮説は**まだ機構として
確認していない**——`-k` を足した後は毎回完走したので、再現して切り分ける
ところまではやっていない。**確認できているのは「580秒級の枠と `-k` を
足せば実際に完走する」ところまでである。**

**⟹ 依頼者への申し送り**: `packages/storage-pg` を「1本が240秒を超えない
分割」にしたいなら、3分割ではなく4〜5分割に増やすか、shard=3/3 相当の重い
ファイル群だけを別枠で回す必要がある。**どのファイルが重いのかは、この
実測では特定していない**（ファイル単位の実行時間はここでは測っていない）。

## 検証（この skill を書いた回に通したもの）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm check:no-env-passthrough`
- `pnpm test scripts/test-guard-core.test.ts -- --maxWorkers=2 --reporter=dot`
  （新しい歯を含む。生の要約行は PR 本文・依頼者への報告に貼ってある）
- `node .claude/skills/mutation-testing/mutate.mjs selftest --scenario all`

生の要約行はこの skill には書き写さない（腐る）。正本は PR の報告・
`ci.yml` の `ci` job である。
