---
name: test-in-chunks
description: 作業者（AI）が `pnpm test` を回すときに読む。Bash の既定タイムアウト（作業者は約300秒）で背景へ落ちる・大きな出力が保存ファイルへ回されて読もうとして拒否で止まる、の2つを避けるための「小さく分けて、小さい出力で回す」手順。パッケージ・shard ごとの推奨コマンド、既定 reporter が `dot` へ倒れる条件（`scripts/test-guard-core.mjs` の `resolveReporterArgs`。`CLAUDECODE` の有無を見る——Claude Code の Bash ツール経由の実行では自動で効く）、`--shard` が空白区切り・`=` 形のどちらでも素通しされること、`packages/storage-pg` の重いファイル（`index.test.ts`）の実測、実測の分割表（観測時刻つき）を持つ。
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

## パッケージのディレクトリで vitest を直接叩いても root の設定が効く（#2157）

**この節の推奨コマンド（`pnpm test` / `pnpm --filter <pkg> test` / `cd <pkg> &&
pnpm test`）は、どれも `scripts/test.mjs` を経由する。** それとは別に、
`cd <pkg> && pnpm exec vitest run <file>` や `pnpm --filter <pkg> exec vitest
run <file>` のように **vitest を直接叩く**打ち方もある——変異試験の赤緑を
素早く測りたいときなど、この打ち方をした作業者が実際にいた。

**2026-09-29（#2157）より前は、この直接叩きだけ root の `vitest.config.ts`
（`setupFiles`・`clearMocks: false`・`~` の別名）が一切効かなかった**——
`apps/*` / `packages/*` のどこにも `vitest.config.*` が無く、vitest は
そのパッケージのディレクトリを `root` として動いていたため。実測（直した
PR より前、observed 2026-09-29）:

```
$ cd apps/daemon && pnpm exec vitest run src/token-watch.test.ts --reporter=dot
 RUN  v5.0.1 /home/worker/trees/mgr-8bda6d38/apps/daemon
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

（`RUN` 行が `apps/daemon` になっている——root ではない。`setupFiles` の
`scrubSecretEnv` が掛からないので、本物の秘密を環境から消さないまま走って
いた。`apps/web` だけは代わりに `apps/web/vite.config.ts`（React Router
プラグイン入り）を拾ってしまい、逆に `Error: React Router Vite plugin can't
detect preamble` で落ちていた。）

**直した後は、各ワークスペースに置いた `vitest.config.ts`（中身は
`vitest.workspace-config.ts` の `workspaceVitestConfig(import.meta.url)` を
呼ぶだけ）が拾われる。** `root` を repo の根に固定し、`test.dir` をそのパッケージの
ディレクトリへ絞ることで、直接叩いても `RUN` 行が repo の根になり、
`setupFiles` / `clearMocks: false` / `~` の別名が効き、走査対象はそのパッケージ
だけに絞られる。**`pnpm test` / `pnpm --filter <pkg> test`（`--root=../..` を
vitest へ渡す）の挙動は変わらない**——`--root` が設定ファイルの探索基点にも
なるため、そちらは今までどおり root の `vitest.config.ts` を見つける（新しく
足したワークスペース側の `vitest.config.ts` は素通りされる）。配線の歯は
`scripts/vitest-workspace-config.test.ts`。

## (b) 既定 reporter が `dot` へ倒れる条件——この器では自動で効く

`scripts/test.mjs` は `scripts/test-guard-core.mjs` の `resolveReporterArgs` /
`hasReporterFlag` を使い、**2条件がすべて揃ったときだけ** `--reporter=dot` を
既定にする——(1) 利用者が `--reporter` を1つも渡していない (2) `CLAUDECODE`
が設定されている（空文字列でない）。

**経緯（最初の版は狙った相手に効かなかった）**: 最初の版は「`stdout` が
TTY でない・`CI` が未設定」の2条件だった。ところが**この器（Claude Code の
Bash ツール）は非TTY のまま `CI=true` を既定で環境に持つ**（実測: `node -e
"console.log(process.env.CI)"` で `true` が返る、観測 2026-09-29）ため、
狙った相手（作業者がこの Bash ツール経由で打つ `pnpm test`）にちょうど
効かない条件になっていた——TTY 判定は満たすが、CI 判定で毎回弾かれていた。

**条件を、狙っている主体（Claude Code の Bash ツール）そのものを見る形へ
変えた。** `CLAUDECODE` は Claude Code の CLI / SDK が自分の子プロセスへ注ぐ
環境変数で（実測: `node -e "console.log(process.env.CLAUDECODE)"` で `1` が
返る、観測 2026-09-29）、**人間が端末で直接打つときにも、GitHub Actions の
runner にも無い**（`GITHUB_ACTIONS` は未設定——同日観測）。⟹ どちらも
今までどおり vitest 既定の reporter のままになる。

**実測: 何も指定せずに打つだけで dot になる**（`env -u CI` も要らない）:

```
$ pnpm test scripts/test-guard-core.test.ts -- --maxWorkers=2
$ node ./scripts/test.mjs scripts/test-guard-core.test.ts -- --maxWorkers=2

 RUN  v5.0.1 /home/worker/trees/mgr-8bda6d38-w3

············································································································

 Test Files  1 passed (1)
      Tests  108 passed (108)
```

（観測 2026-09-29T01:18:37Z、exit 0。`--reporter` を1文字も渡していないのに
点が出ている——既定が dot へ倒れている証拠）

**変異試験ハーネスは影響を受けない。** `.claude/skills/mutation-testing/
mutate-core.mjs` は `pnpm test` を呼ぶときに `--reporter=default` を明示する
ので、`hasReporterFlag` が真になりこの歯を素通りする（値は変わらない）。

**⟹ この器では下の推奨コマンドの `--reporter=dot` は省略してもよい**——
既定で入る。それでも明示してあるのは、他の器（`CLAUDECODE` が無い環境）へ
このコマンド列をそのまま持ち出したときに既定の reporter（大きい出力）へ
戻ってしまわないようにするためである。

## (a) 締め切りは `--deadline-seconds`。外側の `timeout` には頼らない

**外側の `timeout`（シェルの `timeout` コマンド）を `grep` と組み合わせて
使うと、時間切れのときにパイプの読み手（`grep`）まで巻き込んで殺されることが
ある。** GNU coreutils 9.7 の `timeout` は、時間切れのときに**パイプの読み手にも
SIGTERM を送る**。

**測った列（実測、マネージャー、この器、観測 2026-09-29T07:0xZ。コマンドと
生の出力そのもの）**:

```
$ timeout 3 sleep 10 | (trap 'echo "reader got TERM" >> .scratch/reader.log' TERM; cat; echo "reader EOF ok" >> .scratch/reader.log; echo visible); echo "EXIT:${PIPESTATUS[*]}"
Terminated
visible
EXIT:124 0
（.scratch/reader.log: reader got TERM / reader EOF ok）
$ timeout 3 sleep 10 | cat; echo "EXIT:${PIPESTATUS[*]}"
Terminated
EXIT:124 143
$ timeout --foreground 3 sleep 10 | (cat; echo "reader-alive-after-eof"); echo "EXIT:${PIPESTATUS[0]}"
reader-alive-after-eof
EXIT:124
```

**判定の列（測った列から導いた解釈であって、実測そのものではない）**: `-k`
の有無に関わらず、`timeout`（`--foreground` を付けない既定の形）は時間切れの
ときにパイプ全体（子だけでなく `grep` / `tail` などの読み手も含む）へ
SIGTERM を送る。⟹ 作業者がよく打つ `timeout 590 pnpm test … 2>&1 |
grep -E 'Test Files|…'` は、打ち切られると `grep` ごと殺され、それまでの
出力も「打ち切られたこと」自体も1行も残らない——無出力のまま `EXIT:124` だけ
が返る（今夜、複数の作業者がこの形で「無出力のまま EXIT:124」に止まった。
`--foreground` を付ければパイプの読み手は生き残るが〔3本目〕、それは呼び出す
側が毎回 `timeout` の引数を選び直すことに賭ける形であって、`scripts/test.mjs`
の側では直せない）。

**だから、外側の `timeout` に頼らず、`scripts/test.mjs` 自身が持つ
`--deadline-seconds=<n>` を使う**（値は1以上の整数・秒。実装・使い方の詳細は
`scripts/test.mjs` 冒頭の doc、純粋関数の歯は `scripts/test-guard-core.test.ts`、
子プロセスの生死まで含めた統合の歯は `scripts/test-mjs-deadline.test.ts`）。
締め切りに達したら、`grep` を巻き込む前に自分の stdout へ必ず1行
（`test-guard: --deadline-seconds=<n> で打ち切った…`）書き切ってから終わる
——`grep -E 'Test Files|Tests |Duration|FAIL|test-guard'` に `test-guard` を
足しておけば、集計行が1行も出ない回でもその1行だけは通る。

- **Bash ツールの `timeout` パラメータを毎回明示する**（600000ms＝600秒以下）。
  **⚠️ この値は `--deadline-seconds` の値（秒）× 1000 より必ず大きくすること**
  ——ラッパ自身の締め切り（`--deadline-seconds` + 内部の kill 猶予、数秒）が
  先に発火するように余裕を持たせる。Bash ツール側のタイムアウトが先に発火
  すると、ラッパが「打ち切った」1行を書き切る前に外側から殺される形に
  戻ってしまい、この節の対策が意味を失う。
- **出力は最初から絞る**——`--reporter=dot` に加え、
  `2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'` で集計行・
  失敗行・打ち切りの1行だけを残す。パイプの終了コードは
  `; echo "EXIT:${PIPESTATUS[0]}"` で取る（`grep` 自体の終了コードでは
  判定しない——`AGENTS.md`「静かに失敗する道具」「パイプの終了コードは、
  既定で最後のコマンドのものである」と同じ理由）。
- **保存された背景タスクの出力ファイルは読みに行かない。** 大きな出力が保存
  ファイルへ回されて拒否で止まったら、同じ結果を取り直そうとせず、範囲を
  絞って（下の分割）取り直す。
- **一時ファイルを作るなら `.scratch/` の下だけに置く**（`.gitignore` 済み）。
  **⚠️ リダイレクト（`>` `>>` `tee` でファイルへ書くこと）は使わないのが
  この器の既定の作法である**——`| grep` / `| tail -N` で十分に絞れないほど
  出力が大きいと感じたら、それは分割の単位が粗すぎるサインなので、まず
  shard・スコープを細かくすることを考える。

### 旧い形（シェルの `timeout -k` を外側に置く）はもう推奨しない

以前はシェルの `timeout <秒> -k <猶予秒>` を外側に置く形を勧めていた
（`-k` を付けないと、`timeout` が送る TERM で子プロセスが終わらなかったとき、
ハングしたまま Bash ツール側のタイムアウトまで待たされる形になりうるため。
実測: `packages/storage-pg` の shard 3/3 を `-k` 無しで 300秒・560秒の
タイムアウトで打つと、`grep` 越しでも `tail` 越しでも1バイトも出力が出ない
まま打ち切られた。`-k 5` を足して 585秒で打ち直すと `Duration 560.06s` で
正常に完走した——**ハングではなく、単純にその shard が重かっただけ**だったと
分かったのは `-k` を足して確実に完走させてからである。詳細は下の
「実測: storage-pg の3分割が均等でない」）。

**この形は上の「パイプの読み手ごと殺される」実測により、もう推奨しない**
——`--deadline-seconds` はラッパの内側で完結するので、外側の `timeout` も
`-k` も要らなくなる。下の推奨コマンドはすべて `--deadline-seconds` へ
置き換えてある。

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

cd packages/api-client && pnpm test -- --deadline-seconds=60  --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/cli             && pnpm test -- --deadline-seconds=60  --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-fs  && pnpm test -- --deadline-seconds=60  --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/runner          && pnpm test -- --deadline-seconds=60  --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/daemon          && pnpm test -- --deadline-seconds=90  --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd apps/web             && pnpm test -- --deadline-seconds=150 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"

# root の scripts/**（railway/ ・ .github/scripts/ ・ docker/ ・ root 直下は
# scripts/ より小さいので同じコマンドで一緒に流してよい。別に測るなら
# `pnpm test railway/` のように部分一致で絞る）
pnpm test scripts/ -- --deadline-seconds=90 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"

# packages/core（309ファイル）は8分割。1本も240秒を超えない（実測は下）
for i in 1 2 3 4 5 6 7 8; do
  cd packages/core && pnpm test -- --shard=$i/8 --deadline-seconds=120 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT($i/8):${PIPESTATUS[0]}"
done

# packages/storage-pg（43ファイル、@electric-sql/pglite で実サーバ不要）。
# **shard ではなく「重い5本を1本ずつ」＋「残り38本を2組」で回す**（PR #2102 で
# 旧 index.test.ts を index.*.test.ts の5本へ割った後の形。旧3分割は、割った後も
# 1/3 が 335秒になり 300秒の枠に収まらなかった——下の「実測: 割った後」）。
# --exclude は `=` で繋ぐ形で渡す（空白区切りだと値が位置引数として扱われ、
# `resolveScopedArgs` が「範囲内に一致なし」の exit 8 で断る。実測 2026-09-29T04:2xZ）。
cd packages/storage-pg && pnpm test -- index.persona --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && pnpm test -- index.journal-jobs-schedule --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && pnpm test -- index.commitments-inbox-archive --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && pnpm test -- index.sessions-tokens-credentials --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && pnpm test -- index.auth --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && pnpm test -- '--exclude=**/index.*.test.ts' --shard=1/2 --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
cd packages/storage-pg && pnpm test -- '--exclude=**/index.*.test.ts' --shard=2/2 --deadline-seconds=590 --maxWorkers=2 --reporter=dot 2>&1 | grep -E 'Test Files|Tests |Duration|FAIL|test-guard'; echo "EXIT:${PIPESTATUS[0]}"
# ⚠️ 7行とも Bash ツールでは1行ずつ別の呼びにし、ツールの timeout 引数に
# 600000 を入れる（並べると1呼びで10分を超える）。**ツールの timeout 引数は
# 必ず `--deadline-seconds` の値（秒）× 1000 より大きくすること**——storage-pg
# の行は `--deadline-seconds=590` なので、ツールの timeout 引数は 600000
# （590秒の締め切り＋内部の kill 猶予＋余裕）のままでよい。
```

**打ち切ったときの見え方（実測、`--deadline-seconds=5` で短く取った例）**:
`grep -E 'Test Files|test-guard'` を通しても、集計行が無いまま
`test-guard: --deadline-seconds=5 で打ち切った（vitest が 5 秒で終わらなかった）。
集計行は出ていない——通ったのでも落ちたのでもない。分けて回す:
.claude/skills/test-in-chunks/SKILL.md` の1行だけが見える。**この1行が見えた
回は「まだ判定していない」であって「落ちた」でも「通った」でもない**——
`EXIT` は `EXIT_DEADLINE`（10）になる。分割の単位（shard・パッケージ）を
もっと細かくして取り直すこと。

**`pnpm test` 全体を1本では回さない。** 上のパッケージ・shard の並びを
順に（または手が空いている別の依頼と並行して）回せば、全スイートを
1回のコマンドに詰め込まずに済む。

## shard に何が入るかを、走らせずに見る（`pnpm test:shard-files`）

**`vitest list --shard=<i>/<n> --filesOnly` は使わない。** vitest 5.0.1 は `list` で
`--shard` を黙って無視し、範囲の全ファイルを返す（`--help` には載っているので、効いた
ように見える）。実測（2026-09-29T06:5xZ、`packages/storage-pg/src`）: `--shard=1/3` も
`--shard=3/3` も 43 件。

代わりに root で `pnpm test:shard-files <scope> <i>/<n>` を打つ（PR #2136）。テストを
1本も走らせずに、その shard に入るテストファイルを1行1ファイルで出す。仕組みは
vitest 自身の `--shard` に「どのテストにも当たらない `-t`」を付けて JSON で読む形で、
割り当ての規則を書き写していない（`scripts/test-shard-files-core.mjs` の冒頭の doc）。

```
$ pnpm -s test:shard-files packages/storage-pg/src 3/3
…（14行のファイル名）
test-shard-files: packages/storage-pg/src --shard=3/3 → 14 ファイル
```

ファイルの import は走るので、重い範囲でも数秒〜十数秒かかる（`packages/storage-pg/src` の
3本で 26 秒。実測 2026-09-29T06:57Z）。

## `--scope` と分割の口（`--shard` / `--reporter`）の関係——素通しされることの歯

各ワークスペースの `test` script（`node ../../scripts/test.mjs --root=../..
--scope=<pkg>/src` の形）は、利用者が渡す `--shard=1/3` や `--reporter=dot`
を**位置引数と取り違えない**——`scripts/test-guard-core.mjs` の
`resolveScopedArgs` / `findPositionalIndices` が `=` 形の引数
（`-` で始まる）をすべてフラグとして扱うため、`--scope` の範囲判定には
一切混ざらない。この歯（`=` 形が素通しされること）は
`scripts/test-guard-core.test.ts` の「`resolveScopedArgs は --shard=1/3 /
--reporter=dot（`=` 形）を位置引数と取り違えず素通しする`」で固定してある。

**空白区切りの値渡し（`--shard 1/3`）も、いまは `=` 形と同じく素通しされる**
（#2063 の続きで `--shard` を `VALUE_TAKING_FLAGS` へ足した）。当初は
`VALUE_TAKING_FLAGS` に `--shard` が入っておらず、値（`1/3`）が素の位置引数
として範囲判定に持ち込まれ、`EXIT_SCOPE_VIOLATION`（「範囲内に一致なし」）
で断られる形を実測して固定していたが、`--reporter` / `--maxWorkers` など
他の値必須フラグと同じ扱いへ揃えた。実測（api-client、観測
2026-09-29T01:18:47Z、exit 0）:

```
$ cd packages/api-client && pnpm test -- --shard 1/2 --maxWorkers=2 --reporter=dot
$ node ../../scripts/test.mjs --root=../.. --scope=packages/api-client/src -- --shard 1/2 --maxWorkers=2 --reporter=dot

 RUN  v5.0.1 /home/worker/trees/mgr-8bda6d38-w3

····

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

（api-client は全2ファイル・全10テストなので、`--shard 1/2` で1ファイル・
4テストへ絞られたことが確認できる）

この反転は `scripts/test-guard-core.test.ts` の「`--shard 1/3（空白区切り）は
--scope と併用しても素通しされる`」に固定してある——**元の「断られる」形を
測っていた歯は消していない**（テストの期待値を反転し、元のコメントへ経緯を
追記した。`AGENTS.md`「テストを弱めずに直す」の反転の条件に従っている）。
保証が弱くなっていない理由: 素通しの対象は文字列としてちょうど `--shard` に
一致し、かつ直後の要素が `-` で始まらない（＝値らしい）ときだけで、
`EXIT_SCOPE_VIOLATION`（範囲外・範囲内不一致）の判定そのものは1文字も
変えていない。

## 実測した生コマンドと結果（観測 2026-09-29、この器・この枝で計測）

**この表は実測（測った列）である。** 「240秒以内か」の列は依頼で指定された
閾値（packages/core にのみ課された条件）に対する筆者の判定であって、実測
そのものではない——両者を混同しないこと。器は他の作業者・マネージャーと共有
なので、同じコマンドでも別の時刻には違う秒数が出ることがある。

`pnpm build` 実測: 開始 `2026-09-29T00:07:14Z` / 終了 `2026-09-29T00:08:01Z`
（約47秒、exit 0）。

| 対象                                   | 実行コマンド（`--maxWorkers=2 --reporter=dot` 共通） | 観測開始(UTC) | 観測終了(UTC) | Test Files行                      | Duration行  | exit | 240秒以内か（判定）             |
| -------------------------------------- | ---------------------------------------------------- | ------------- | ------------- | --------------------------------- | ----------- | ---- | ------------------------------- |
| packages/api-client                    | `pnpm test`                                          | 00:10:37      | 00:10:44      | 2 passed (2)                      | 4.12s       | 0    | ○                               |
| apps/cli                               | `pnpm test`                                          | 00:10:17      | 00:10:32      | 22 passed (22)                    | 12.23s      | 0    | ○                               |
| packages/storage-fs                    | `pnpm test`                                          | 00:10:48      | 00:11:13      | 34 passed (34)                    | 22.24s      | 0    | ○                               |
| apps/runner                            | `pnpm test`                                          | 00:12:05      | 00:12:22      | 20 passed (20)                    | 14.53s      | 0    | ○                               |
| apps/daemon                            | `pnpm test`                                          | 00:11:18      | 00:12:00      | 31 passed (31)                    | 39.07s      | 0    | ○                               |
| apps/web                               | `pnpm test`                                          | 00:12:26      | 00:13:48      | 66 passed (66)                    | 78.97s      | 0    | ○                               |
| root scripts/                          | `pnpm test scripts/`                                 | 00:57:49      | 00:58:24      | 63 passed (63)                    | 32.66s      | 0    | ○                               |
| packages/core 1/8                      | `pnpm test -- --shard=1/8`                           | 00:52:14      | 00:52:44      | 39 passed (39)                    | 27.42s      | 0    | ○                               |
| packages/core 2/8                      | `pnpm test -- --shard=2/8`                           | 00:54:09      | 00:54:35      | 39 passed (39)                    | 23.82s      | 0    | ○                               |
| packages/core 3/8                      | `pnpm test -- --shard=3/8`                           | 00:54:39      | 00:55:04      | 39 passed（10 expected fail込み） | 21.90s      | 0    | ○                               |
| packages/core 4/8                      | `pnpm test -- --shard=4/8`                           | 00:55:08      | 00:55:58      | 39 passed (39)                    | 47.64s      | 0    | ○                               |
| packages/core 5/8                      | `pnpm test -- --shard=5/8`                           | 00:56:02      | 00:56:31      | 39 passed (39)                    | 26.28s      | 0    | ○                               |
| packages/core 6/8                      | `pnpm test -- --shard=6/8`                           | 00:56:37      | 00:57:16      | 38 passed (38)                    | 36.16s      | 0    | ○                               |
| packages/core 7/8                      | `pnpm test -- --shard=7/8`                           | 00:57:20      | 00:57:44      | 38 passed (38)                    | 21.99s      | 0    | ○                               |
| packages/core 8/8                      | `pnpm test -- --shard=8/8`                           | 00:52:50      | 00:54:02      | 38 passed (38)                    | 69.93s      | 0    | ○（最大でも70秒未満）           |
| packages/storage-pg 1/3                | `pnpm test -- --shard=1/3`                           | 00:14:32      | 00:17:05      | 13 passed (13)                    | 150.02s     | 0    | ○                               |
| packages/storage-pg 2/3                | `pnpm test -- --shard=2/3`                           | 00:17:10      | 00:18:08      | 12 passed (12)                    | 55.51s      | 0    | ○                               |
| packages/storage-pg 3/3                | `pnpm test -- --shard=3/3`（`-k 5`・585秒枠）        | 00:42:27      | 00:51:50      | 12 passed (12)                    | **560.06s** | 0    | **×（240秒を大きく超える）**    |
| packages/storage-pg index.test.ts 単体 | `pnpm test -- index.test.ts`（`-k 5`・595秒枠）      | 01:31:05      | 01:40:32      | 1 passed (1) / 262 tests          | **564.75s** | 0    | **×（shard=3/3 の重さの実体）** |

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

### 実測: 重い1本を特定した——`index.test.ts`（5588行）

**まず軽い方法を試したが、狙いどおりには効かなかった。** `pnpm exec vitest
list --shard=3/3 --filesOnly packages/storage-pg/src` は shard を無視して
**37ファイル全部**（storage-pg の全テストファイル）を返した——`list`
サブコマンドは `--shard` を受け付ける（`--help` にオプションとして出る）が、
実際の絞り込みには反映されない（実測、観測 2026-09-29T01:19:15Z・
2026-09-29T01:30:47Z の2回、`--filesOnly` の有無どちらでも同じ）。**⟹ `list`
で shard の中身を確認する方法はこの版の vitest（5.0.1）では使えない。**

**代わりに行数で当たりを付けて実測した。** `wc -l packages/storage-pg/src/
*.test.ts` で最大は `index.test.ts`（5588行、2位の `usage.test.ts` の
1431行を大きく引き離す）。これを単独で回すと:

```
$ cd packages/storage-pg && pnpm test -- index.test.ts --maxWorkers=2 --reporter=dot
 Test Files  1 passed (1)
      Tests  262 passed (262)
   Duration  564.75s (tests 99%, transform 1%)
```

（観測 2026-09-29T01:31:05Z〜01:40:32Z、exit 0）

**shard=3/3 全体（12ファイル・286テスト・560.06s）と比べると、
`index.test.ts` 単体（262テスト・564.75s）でほぼ同じ時間・ほぼ同じテスト数
になる**——⟹ shard=3/3 の重さは実質的に `index.test.ts` 1本に集中している
（残り11ファイルの合計は24テストで、他の shard の1ファイルあたりの軽さと
矛盾しない）。**これ以上の個別ファイル測定はしていない**（重い1〜2本が
特定できれば止めてよい、という依頼の条件を満たしたため）。

**⟹ 依頼者への申し送り（更新）**: `packages/storage-pg` を「1本が240秒を
超えない分割」にしたいなら、`index.test.ts` を単独の枠（590秒級の
timeout）で回し、残り36ファイルを別に（例: 2分割程度で）回す形が良さそうで
ある。**ただし `--exclude` フラグ（vitest にはある）と `--scope` の組み合わせ
は試していない**——`index.test.ts` を除いた残りをどう指定するのが安全かは
未検証。**ファイルを割る改修（`index.test.ts` 自体を分ける等）はしていない**
（依頼者の判断待ち）。下の推奨コマンドには、単独実行の1行だけを足した。

### 実測: 割った後（PR #2102。観測 2026-09-29）

`index.test.ts` を最上位 `describe` の単位で `index.*.test.ts` の5本へ割った（テストの本文は
1文字も変えていない。突き合わせの方法は PR #2102 の本文）。**上の「申し送り」はこれで片付いた。**
上の旧3分割の表と節は、割る前の記録として残してある。

| 対象（測った列）                                    | Test Files | Tests | Duration | 観測（UTC）                                                                     |
| --------------------------------------------------- | ---------- | ----- | -------- | ------------------------------------------------------------------------------- |
| `index.persona`                                     | 1          | 42    | 101.90s  | 作業者の実測（04:0x 頃）                                                        |
| `index.journal-jobs-schedule`                       | 1          | 64    | 213.97s  | 04:17:06Z〜04:20:43Z（#2087 の契約テスト1本を足した後。足す前は 63本・162.57s） |
| `index.commitments-inbox-archive`                   | 1          | 57    | 128.71s  | 作業者の実測                                                                    |
| `index.sessions-tokens-credentials`                 | 1          | 60    | 139.25s  | 作業者の実測                                                                    |
| `index.auth`                                        | 1          | 40    | 95.54s   | 作業者の実測                                                                    |
| 残り38本 `--exclude=**/index.*.test.ts --shard=1/2` | 19         | 114   | 167.43s  | 04:11:40Z〜04:14:30Z                                                            |
| 残り38本 `--exclude=**/index.*.test.ts --shard=2/2` | 19         | 55    | 140.69s  | 04:14:35Z〜04:16:59Z                                                            |
| （参考）割った後の旧3分割 `--shard=1/3`             | 15         | 264   | 335.45s  | 作業者の実測（300秒を超える）                                                   |

判定（測った値ではない）: 1本あたり最長が約 214秒で、器が混むと 240秒に近づく。`index.journal-jobs-schedule`
がこれ以上重くなったら、次はこのファイルを割る。

## 検証（この skill を書いた回に通したもの）

- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm check:no-env-passthrough`
- `pnpm test scripts/test-guard-core.test.ts -- --maxWorkers=2 --reporter=dot`
  （新しい歯を含む。生の要約行は PR 本文・依頼者への報告に貼ってある）
- `node .claude/skills/mutation-testing/mutate.mjs selftest --scenario all`

生の要約行はこの skill には書き写さない（腐る）。正本は PR の報告・
`ci.yml` の各 job（test は `test`、selftest は `mutation-selftest`）である。
