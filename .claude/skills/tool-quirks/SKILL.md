---
name: tool-quirks
description: gh / git / grep / find / bash / pnpm / vitest や Claude Code の Bash・Read ツールが静かに失敗する・取りこぼす具体形を数える・マージする・Issue を読む前に読む。
---

この内容は #1192 の再編で AGENTS.md から逐語で移したもの。要約・短縮はしていない。

移す前の AGENTS.md は「ここに残すもの」の一覧としてこう挙げていた:

> - **この器での既知の落ち方** — 静かに失敗する道具、自分が走っている器

## AGENTS.md「踏みやすい地雷」から

**ここから下は北極星の話ではなく、この器で「測ったつもり」になる形である**（器の癖の本体は「静かに失敗する道具」「自分が走っている器」が持つ。ここに置くのは、**踏むと上の判定そのものが狂うもの**だけである）。

- **この文書は1回の読み取りでは全文が届かない。`Bash` の `cat` も `Read` も途中で切れ、切り方が違う。** 実測(2026-08-27、122,432 バイト / 569 行):
  - **`cat AGENTS.md`** → `Output too large (119.6KB). Full output saved to: <パス>` と**先頭 2KB のプレビュー**だけが返る。本文として届いたのは「まず読む」「この文書の役割」と「書く先を決める」の冒頭までだった。閾値は1文字単位で挟んである — **30,000 文字は素通りし、30,001 文字で切られる**（`head -c <N> /dev/zero | tr '\0' 'a'` で二分探索）
    - **⚠️ 訂正（実測 2026-09-17）: 閾値は「文字」ではなく「バイト」である。** 上の二分探索は ASCII で取ったので、そこでは文字数とバイト数が一致していた。実際は **ASCII 30,000 バイトは素通りし、30,001 バイトで切られる**一方、**日本語 10,001 文字（＝30,003 バイト）も同じく切られる**（`awk 'BEGIN{for(i=0;i<10001;i++)printf "あ"}'` で生成して確認）。⟹ **この文書は日本語なので、実際に切られるのは約 10,000 文字である。上の「30,000 文字」は、この文書に対しては3倍甘い。**
  - **`Read`（`offset` / `limit` 無指定）** → `[Truncated: PARTIAL view — …: showing lines 1-277 of 569 total (43598 tokens, cap 25000). …]` が付き、**569 行のうち 277 行まで**しか届かない。切るのは行数ではなくトークン予算である
  - **⚠️ どちらも「切った」とは言うので、静かなのは切り詰めそのものではない。静かなのは exit code のほうである**（`cat` は 0 を返す）。**⟹ 危ないのは切られたことに気づかないことではなく、切られた先を読まないまま「読んだ」として次を判断することである。** 「載っていなければ `cat` でも `Read` でも自分で読めばよい」（「報告の形」「自分が走っている器」）は、**1回打てば読めるという意味では成り立たない**
  - **⟹ `Bash` で読むなら自分で窓を切ること**（`awk 'NR>=A && NR<=B' AGENTS.md`）。**そして1行が長いので、行数で切っても 30,000 文字を超えうる** — 実際に `sed -n` で 230 行ぶんを一度に出して落ちた（`Output too large (45.2KB)`）。`Read` なら上の案内が返す `offset` で読み継げる
- **`pnpm` へ渡すフラグはスクリプト名より前に置く。後ろに置くとスクリプトの引数として素通りする。** 実測(2026-08-27): `pnpm --no-bail -r typecheck` と `pnpm -r --no-bail typecheck` はどちらも exit 0 で 8 パッケージを回るが、`pnpm -r typecheck --no-bail` は `tsc --noEmit --no-bail` に化けて **`error TS5023: Unknown compiler option '--no-bail'.`** で exit 1 になる。**トップレベルの `typecheck` は `pnpm -r typecheck` なので、`pnpm typecheck --no-bail` も同じ形に展開されて同じ顔で落ちる。** ⚠️ **「自分が走っている器」の `pnpm build -- <フラグ>` の項とは別物である** — あちらは `--` を付けた形で、結論は「渡すなら環境変数」だった。こちらは `--` の無い形で、**前に置けば効く**
- **⚠️ worktree の `node_modules` を、symlink で別のツリーの `node_modules` と共有しないこと。各 worktree で独立に `pnpm install --frozen-lockfile` する。** pnpm（v11.27.1）は `pnpm <script>` の前に既定で依存の状態を確かめ（`verify-deps-before-run` の既定が `install`）、ずれていれば内部で実際に install を起こす。確かめに使う状態ファイルは `node_modules/.pnpm-workspace-state-v1.json` で、`node_modules` の直下に在る。**⟹ symlink で共有すると、この状態ファイルも共有される。** 片方のツリーで打つたびに、中の `projects` の絶対パスがそのツリーのものへ書き換わる。すると、もう片方で次に打ったときに「ずれている」と判定され、暗黙の install が走る。実測（2026-09-27T23:4xZ。自分専用の clone と、その worktree の間で）: main と worktree で交互に `pnpm vitest run <1ファイル>` を打つと、8回中8回で `Scope: all 9 workspace projects`（＝暗黙の install）が出た。main 側の状態ファイルの中身は、worktree の絶対パスになっていた。**共有先が他人のツリーなら、自分が打つたびに相手の `node_modules` へ書き込むことになる。** 別の作業者は、この形の直後に共有先の `packages/core/node_modules` が一時的に0件になったのを1度見ている（数秒後に戻った）。ただし再現を狙った12回では0件の瞬間を捕まえられず、機構は確かめられていない
- **`Bash` は `timeout` を指定しないと約 120 秒で制御を返すが、そのとき子プロセスを殺してはいない。返ってくるのは失敗ではなく「バックグラウンドへ移した」という合図である。** 実測(2026-08-27): 180 秒かかるコマンドを `timeout` 未指定・前景で打つと `Command did not complete within its 120s timeout and was moved to the background (ID: …). Output is being written to: …` が返り、そのあとも出力ファイルは `tick 125` から `tick 179` まで伸び続けて、最後は自分で付けておいた `/usr/bin/timeout 180` の exit 124 で終わった（生存は `ps` ではなく、**自分が書かせたファイルの行数が増えるか**で見た。プロセスをパターンで選ぶ走査は他人を撃つ）。**⚠️ 「自分が走っている器」が挙げる `Exit code 143` / `timed out` という文言は、この実測では一度も出なかった。** 版の違いなのか条件の違いなのかは測っていない。**変わらないのは帰結のほうである — 制御が返っても、プロセスは生きている**

## AGENTS.md「静かに失敗する道具」から

- **⭐ 母集合を切る引数は、切ったことを言わない** — `git clone --depth N` のツリーで `git log` / `git diff` を数えると、**`main` 全体ではなく窓の中の値が返る（エラーは出ない）。** ⛔ **「手元に無い」を「存在しない」と読まないこと** — `gh api repos/<owner>/<repo>/commits/<短縮> --jq .sha` で40桁へ展開し、`git fetch --depth=1 origin <40桁>` で名指しで取れる。⚠️ **`gh pr list --limit N` と同じ族である**（実測 2026-09-23、同じ日に3度踏んだ）

- **⭐ `grep -c` の終了コードで検査を繋ぐと、両方向に壊れる（実測2件、2026-09-15、同じ日に向きだけ変えて2回踏んだ）。** `grep -c` は「該当なし」を **exit 1** で返す。**数えた件数と、数えられたかどうかは別のことである。**
  - **1回目（fail-open。履歴に焼けた）**: マージ前の検査を `gh pr view <N> --json body | command grep -c -- '<語>' ; gh pr merge <N> --squash && …` と `;` で繋いだ。**`grep -c` は1件見つけて `1` を出力しながら exit 0 を返す**ので、`;` の後段のマージがそのまま走り、**PR 本文のトレーラが squash でコミットメッセージへ焼かれた**（`main` の `63a33dd`。Issue #1020）
  - **2回目（fail-closed。止まった）**: 直したつもりで `HITS=$(… | command grep -c -- '<語>') && echo "trailer_hits=$HITS" && test "$HITS" -eq 0 && gh pr merge … && echo "state=MERGED …" ; merged_body_hits=$(…); echo "merged_body_hits=$merged_body_hits"` のように、マージ後の後始末チェックだけ末尾に `;` で足していた。**0件だと `grep -c` は exit 1 を返し**、コマンド置換を受けた代入の終了コードも1になる**ので `&&` の連鎖がそこで切れ**、`trailer_hits=…` も `gh pr merge` も `state=MERGED …` も走らなかった。**⚠ ただし出力は0行にはならなかった** —— `;` で繋いだ末尾の後始末チェックは `&&` の失敗と無関係に走るので、**それだけが**画面に出た:

    ```
    merged_body_hits=
    ```

    **この1行（値は空）だけが出たことを「最後まで通った結果」に見えて、マージできたと読みかけた。** 気づいたのは出力を読み返したからではなく、**`gh pr view --json state` を引き直した**からである。⟹ **一般形: `&&` の連鎖が途中で切れても、後ろに `;` で繋いだ行が在ればそれだけが出る。⟹ 生き残った出力が「最後まで通った結果」に見える。**

  - **⟹ 正しい形（実際に使ってマージが通った）:**

    ```sh
    HITS=$(gh pr view <N> --json body --jq .body | { command grep -c -- '<語>' || true; })
    if [ "$HITS" -eq 0 ]; then gh pr merge <N> --squash; else echo "REFUSED: $HITS"; fi
    ```

    **`|| true` で「0件」を正常終了へ直し、判定は `if` で明示する。**
- **⚠️ `pnpm verify` は、ツリーが前回と同じなら何も測らずに exit 0 を返す** — `verify: skipped (tree unchanged since …)` と1行出して終わる（`scripts/verify.mjs` の `decideSkip`。指紋は `verify-core.mjs` の `fingerprint`）。⛔ **これは欠陥ではない**（意図した最適化で、逃げ道も `--force` として在る）。**壊れるのは、その上に乗せた*測り方*のほうである** — 「**2回走らせて `Test Files N` の一致を見る**」を素朴にやると、**1回目でツリーが確定するので2回目は測定にならない**（2回とも exit 0 だが、測ったのは1回だけ）。⟹ **反復で確かめるときだけ `pnpm verify --force -- --maxWorkers=4` を使い、2回目の `Test Files N` の行が実際に出たことを目で確かめること**（`skipped` の1行しか出ていないなら測っていない）。⚠️ **ただし `--force` を常用しないこと** — `verify.mjs` 自身が逐語で「**`--force` を毎回打つ人が出たら、それは指紋が信用されていない合図である**」と書いている。⟹ ⭐ **一般形: 「同じことを2回やって一致を見る」は、道具が2回目を省略する権利を持っているときには成立しない。**反復で確かめるなら、**2回目が実際に走ったことを別の出力で確かめる**（実測 2026-09-12、PR #887 の門で委譲先が踏んだ）
- **⚠️ その前に — `grep` と打っても GNU grep が走るとは限らない。この器では走らない。** Claude Code が profile で `grep` という bash 関数を注入していて、実体は `claude` バイナリを `ARGV0=ugrep` で起こしたもの（`ugrep`、固定引数 `-G --ignore-files --hidden -I --exclude-dir=.git …`）である。`type -a grep` で見える。**本物の GNU grep は `command grep` で呼ぶ。** そして **node / dash / CI から呼ぶと GNU grep に戻る**（bash の profile を通らないため）。⟹ **同じ `grep …` が、打つ主体で別の道具になる** — Bash で打つ AI（ugrep）／歯や CI が spawn したもの（GNU grep）／人間の端末（**未確認**）の3つに分かれる。**正規表現の方言も既定のオプションも違うので、下の5つを読む前に「いま自分はどちらを打っているか」を決めること**（実測 2026-08-25 観測、`ugrep 7.8.4` / `GNU grep 3.8`）
- **`find` も関数で実体は `bfs`** — `-newermt "@<秒>.<小数>"` を拒み、`| wc -l` では黙って0件。整数秒か `command find`
- **`grep` が静かに取りこぼす形は6つある**（終了コードと件数が嘘をつく / 複合語に取り込まれる / NUL でバイナリ判定されて1行も見ない / 改行を跨ぐ / 再帰で `.gitignore` のものを飛ばす / `-v` と `-c` を併せたときだけ1少なくなる）。**1と3と5と6は探し方を変えても見つからない（道具が見ていない／嘘をつく）。2と4は探し方を変えれば見つかる。** ⚠️ **3と5と6は道具を替えれば見つかる — 直上の「どの grep か」の軸である。** **6つの形それぞれの機構・生の実測・対策は `.claude/skills/grep-counting/SKILL.md` に在る。全走査の件数を根拠にするなら、先にそちらを読むこと**

- **`cd` はコマンド列の先頭ごとに置き、失敗したら即終了する** — cwd が戻ったことに気づかず、`gh` が `not a git repository` で20分黙って死んだ。別のマネージャーも PR #91 の作業中に同じ `gh` の `not a git repository` を踏んだと報告している（前面・バックグラウンドどちらの呼びの組み合わせで踏んだかは記録されていない）。**前面のコマンドとバックグラウンドで起動したコマンドは `cd` の寿命の閉じ方が違う** — 実測（2026-08-20T07:44Z）: `run_in_background: true` で `cd /workspace/worker-1aa8c87d/repo && pwd` を起こすと出力ファイルには `cd` 後のパスが書かれるが、直後の前面呼びの `pwd` は元の session cwd のまま変わらなかった（ツール自身も `Session cwd remains ...; directory changes made by the backgrounded command do not apply to subsequent commands.` と明示する）。**バックグラウンドの `cd` はその実行中しか効かず、前面の session cwd には一度も反映されない**のに対し、前面の `cd` は同じ1呼びの中でだけ効いて次の呼びで同じ元の cwd に戻る
- **`command -v` が真でも「呼べる」とは限らない** — 実体の無いシェル関数でも真を返す（この器の `pkill` がそれで、`command pkill` は 127 で落ちる）

- **`gh issue list` / `gh pr list` は `--limit` で静かに取りこぼす** — 作成日降順で N 件取ってから `--jq` でフィルタするので、古いものが窓から落ちる。**`--state all` と `--limit 1000` を両方指定する**
- **`gh pr list --state merged --search '<番号>'` は `#N` という参照ではなく裸の数字列の部分一致で当たる ⟹ 「その issue を名指しした PR」を数える用途には使えない。しかも結果が返るので、欠落ではなく偽陽性として静かに混ざる。** 実測（2026-09-15 観測）:

  ```
  $ gh pr list --state merged --search '#780' --json number,title,url --limit 30
  [{"number":979,"title":"[CI未起動] chore: @anthropic-ai/claude-agent-sdk を 0.3.271 へ上げる", ...}]
  $ gh pr view 979 --json body -q .body | grep -Fc -- '#780'
  0
  $ gh pr view 979 --json body -q .body | grep -Fn -- '780'
  138:...tests 780.06s...   # ← Duration ログの秒数の一部に当たっていた
  ```

  issue #213 も同様（12件ヒット、うち PR #706 の本文に `#213` は0箇所——`204-213` という行範囲表記の一部に当たっていた）。**open issue 50件全件で系統立てて確かめた**（2026-09-15 観測）: `git log --perl-regexp --grep="#${N}(?!\d)" origin/main` と上の `gh pr list --search "#${N}"` を突き合わせると、前者が0件・後者が1件以上という食い違いが12件（延べ候補 PR 34件）。その34件の本文を `grep -cP "#${N}(?!\d)"` で機械的に再検査したところ**全34件が0件**——この食い違い分については `gh pr list --search` が丸ごとノイズだった。

  **⟹ 代わりに `git log --perl-regexp --grep="#${N}(?!\d)" origin/main` を使う**（`(?!\d)` が無いと `#213` が `#2131` にも当たる）。⚠️ **こちらにも限界がある** — コミット本文の文字列一致であって GitHub の issue リンク機構そのものではない。PR の説明から番号を後で消した等の経路は拾えない（そういう例が実在するかは確認していない）。⚠️ **もう1つ** — この repo の squash コミットの件名は末尾に `(#PR番号)` が付くので、素朴な `--grep '#<N>'` は PR 自身の番号にも当たりうる（除くには「件名末尾の `(#…)` を外した残り＋本文に `#N` が在るか」を見る）。⭐ ただし今回の標本（open issue 50件・生ヒット計106件、2026-09-15 観測）ではこの衝突は0件だった——機構として在るが、この標本では実害は出ていない

- **`git log --grep` は既定で大小文字を区別する ⟹ トレーラの数え上げで、大半が窓から静かに落ちる。** 実測（2026-09-15T17:01:19Z 観測、自分で取り直した）:

  ```
  $ git log --format=%H --grep='Co-Authored-By' origin/main | wc -l
  8            ← 完全一致。ここで止めると「この族は少ない」と読める
  $ git log --format=%H -i --grep='co-authored-by' origin/main | wc -l
  93           ← -i を付けるとこうなる
  ```

  **なぜ落ちるのか**: GitHub や各種ツールが既定で付けるのは `Co-authored-by:`（`a` が小文字）である。⟹ `Co-Authored-By` の完全一致で数えると、その大半が窓の外に出る。

  🔑 **⟹ この項目の芯**: **エラーは出ない。小さい数が返るだけである。**⟹ 「この族は少ない」という*間違った安心*が返ってくる。⭐ 他の項目と同じ族（`grep -vc` が「該当なし」を作る向きにしか壊れないのと同型）。

  ⚠ **併せて書く（混同を防ぐため）**: 門そのものは無事だった。`scripts/check-no-attribution-trailers-core.mjs` は大小文字を無視する判定になっており（`grep -Fn -- '大小文字を区別しない' scripts/check-no-attribution-trailers-core.mjs`）、実装者が `main` の実コミット `6a74c9d` に `Co-Authored-By:` と `Co-authored-by:` が同居していることを確認したうえでそう決めている。⟹ 壊れていたのは*数え方*であって、門の挙動ではない。

  ⭐ 同じ日の実測: 同じ「トレーラの数」という言葉で2人が別の式を使い、85 と 86 に分かれた（`🤖 Generated with` の数え方の違い。Issue #1020 コメント）。⟹ 数字を渡すときは*式と窓*（ref・母集団・対象）を一緒に渡すと、差は15秒で解ける。

- **`git worktree` は `.git/config` を共有する ⟹ 設定に依存する検査は、worktree を分けても切り分けられない。** 実測（2026-09-16 観測）: `railway/setup.test.ts` の1件（`GIT_AUTHOR_* が無ければ GH_TOKEN だけ置く（身元が空なら置かない）`）が落ちた。自分の変更が壊したのかを切り分けるため、`git worktree add /tmp/base-main origin/main` で**素の main の作業ツリー**を作って同じテストを回したところ、**そこでも落ちた** ⟹ 「既存の失敗である（自分の変更とは無関係）」と結論しかけた。

  🔴 **その切り分けは汚染されていた。** `git worktree` が作るツリーは**同じ `.git` を共有する**ので、`git config --local` で入れた設定が main 側の実行にも同じように効く。⟹ **両方が同じ原因で落ちていたのであって、「main でも落ちる」は「自分のせいではない」の根拠にならなかった。**

  現物を読んで原因を特定 —— `railway/setup.sh` が身元を `git config user.name` にフォールバックしていた（逐語は `grep -Fn -- 'git config user.name' railway/setup.sh`。⚠️ 行番号は動くので、ここには書かない —— 出典は逐語の grep で残す）:

  ```
  GIT_AUTHOR_NAME_VALUE="$(ask 'コミットの名前 (GIT_AUTHOR_NAME)' "$(git config user.name 2>/dev/null || true)")"
  ```

  `git config --unset user.name` / `git config --unset user.email` → **64/64 緑。**

  🔑 **⟹ 言えること**: `git worktree` で作ったツリーは `.git/config`（`--local` の設定）を共有する。⟹ **設定に依存する検査は、worktree を分けても切り分けられない。**

  ⚠ **言えないこと**: worktree が*何もかも*共有するわけではない（作業ツリーの中身・`HEAD`・index は別）。⟹ 「worktree は使うな」ではなく、**「設定に依存する検査の切り分けには使えない」まで。**

  ⭐ **切り分けたいときの手**: 別ディレクトリへ**新しく clone する**（`.git` ごと別になる）か、疑っている設定を実際に外して回す。

- **PR が本当に緑かの判定は、それ自体が静かに失敗する道具の塊である。** `gh pr view --json statusCheckRollup` が「どの sha の結果か」を返さないこと、draft 由来の `skipped` を緑と数えてしまう形、同じ sha に複数世代が並んだときに `started_at` / `id` / `completed_at` のどれでも世代を決められないこと、run 全体の `conclusion` が両方向に化けること、`mergeStateStatus` の `BLOCKED` と `UNSTABLE` の違い、`gh pr ready` の直後の「0本」の読み方 —— **全部まとめて `.claude/skills/pr-green/SKILL.md` に在る**（実装の正本は `scripts/check-pr-green.mjs`、`pnpm check:pr-green -- <sha>`）。**待ち方そのものは上の「CI の完了を待つ形」が持つ**
- **`gh api repos/…/rules/branches/<枝>` が `[]` を返しても「無保護」ではない。** あれは ruleset だけを見ており、classic branch protection（`branches/<枝>/protection`）は別口である。実測（2026-09-15 観測、自分で取り直した）:

  ```
  $ gh api repos/takecchi/alteroid/rules/branches/main
  []
  $ gh api repos/takecchi/alteroid/branches/main/protection --jq '.required_status_checks.contexts, .allow_force_pushes.enabled, .allow_deletions.enabled'
  ["ci","image"]
  false
  false
  ```

  **⟹ `[]` は「無い」ではなく「この見方では見えない」。**⭐ **そして向きが危ない** —— 保護の話でこれを踏むと、**無保護だと誤認する側**へ倒れる（要らない歯止めを足す／人間へ誤った緊急度を上げる）。**classic（`branches/<枝>/protection`）と ruleset（`rulesets`）の両方を見ること。**

- **`gh api --paginate --slurp` は `--jq` と併用できない**（`gh` がエラーで拒否する）
- **`gh issue view <N> --comments` は本文を出さない。コメントだけに差し替える。** ⟹ **コメントが0件の Issue では出力が0バイト・exit 0 になる**（実測 2026-09-15T06:0xZ: `gh issue view 1003 --comments | wc -c` が `0`、同じ Issue の `--json body` は 4031 文字）。**「Issue とコメントを全部読め」のつもりでこれを渡すと、受け手は本文を1文字も見ない。** そして**落ちないので、渡した側も受け手も気づかない** —— 0バイトは「コメントが無い」とも「引けなかった」とも読めるので、**受け手が疑う契機が無い。**
  - **⟹ 本文とコメントの両方が要るなら `gh issue view <N> --json body,comments` を使う**（1回で両方が取れる。`--jq` で整形してよい）。2回に分けて `gh issue view <N>` と `gh issue view <N> --comments` を打つ形でもよいが、**前者を省くと本文が落ちる**
  - **⚠️ これは委譲文に書き写されて増える種類の誤りである。** 実際に 2026-09-15、あるマネージャーが1日のうちに複数の委譲文へ `gh issue view <N> --comments` と書き、**受け手が Issue 本文を読めていなかった可能性を後から自分で見つけた。** 手順の1行は、間違っていても書き写され続ける
- **`env | cut -d= -f1` は複数行の値で破れる。** `printenv <名前>` を使う
- **テストの中の `console.log` は、そのテストが通ると出力に出ない。** vitest の既定の reporter は console を横取りし、**通ったぶんを捨てる**（落ちたぶんは `stdout | <ファイル> > <テスト名>` の形で出る）。実測（2026-08-22T04:28Z 観測、`vitest@4.1.10`。この repo の `vitest.config.ts` は `reporters` / `silent` / `onConsoleLog` / `disableConsoleIntercept` のどれも指定していないので既定のままである）。**`console.error` も同じで、`process.stdout.write` だけは横取りを通らず、通っても落ちても出る。** 「`HERE` が出ないからこの分岐は通っていない」は、**通っていても同じ見た目になる**
  - **効いているかを「1回落として確かめる」と必ず誤る。** 落ちたぶんは出るので「出た＝ちゃんと出る」と読める。**確かめるなら通るテストで確かめること。** 出すなら `pnpm test --reporter=verbose`（`console.log` が通ったテストでも `stdout | …` として出る）か `process.stderr.write`（既定の reporter のままで出る）
  - **⚠️ 観測に `process.stdout.write` を使わないこと（#314 以降）。** 直上の「横取りを通らず、通っても落ちても出る」はいまも事実で、**出ること自体は変わっていない** — 歯は握り潰さず本物の stdout へ通すし、失敗の差分にも書いた内容が出る。**変わったのは、そのテストが赤くなることである。** `vitest.setup.ts` の歯が「テストが spy を張らずに本物の stdout へ書いた」として `afterEach` で落とす。**変異試験ではこの赤が「変異を検出した」に化ける**（生存＝テストが通った、なので）。実測と、残っている観測手段は `.claude/skills/mutation-testing/SKILL.md`
  - **最も重く出るのは変異試験である** — 生存＝テストが通ったなので、**証拠が要るときにだけ消える。** 詳細は `.claude/skills/mutation-testing/`

- **`gh pr merge --delete-branch` は、その枝を base にしている PR を閉じる。しかも戻せない。** ⚠️ **`gh pr merge` はそれを言わない** — マージの出力は成功だけを返し、巻き添えで閉じた PR は別の PR なので、マージした側の出力には1文字も出ない。実測（2026-09-15T07:3xZ、PR #1008 と #1010。#1010（#1003 段2）は #1008（#781）の枝の上に積んであった stacked PR）:

  ```
  $ gh pr merge 1008 --squash --delete-branch
  $ gh pr view 1008 --json state,mergeCommit
  state=MERGED commit=6623d38a
  $ gh pr view 1010 --json state,baseRefName
  state=CLOSED base=fix/781-toolcontext-conversationid-required   ← 何も言わずに閉じた
  $ gh pr reopen 1010
  API call failed: GraphQL: Could not open the pull request. (reopenPullRequest)
  $ gh pr edit 1010 --base main
  GraphQL: Cannot change the base branch of a closed pull request. (updatePullRequest)
  ```

  **⟹ 取り返しが付くのは枝を消す前だけである。** 閉じたあとは `reopen` も `--base` の付け替えも、base の枝が無いのでどちらも拒まれる（上の生出力）。**⭐ ただし成果そのものは失われない** — head の枝はリモートに残る（`git ls-remote --heads origin <head>` で確認できる）ので、rebase して新しい PR を開き直せば復帰できる。**⚠️ ただし base 側が squash マージされていると、head の枝が抱えている base 側のコミットは main の祖先ではない**ので、**rebase せずに出し直すと base 側の変更が二重に載った差分になる**。**対策: 積んだ PR が在るあいだは `--delete-branch` を付けない。** 先に依存側の base を `gh pr edit <N> --base main` で付け替えてから、base 側をマージする（**付け替えは base の枝が在るうちにしかできない**）

  **⚠️ 対策はもっと単純かもしれない——ただし2標本からの推定で、機構はコードで確かめていない。** 同じ日（2026-09-15）の別の1組（PR #1007 と、それを base にしていた #1013）で、`--delete-branch` を**付けずに**マージしたところ、依存側の PR は閉じずに残り、しかも base が自動で `main` へ付け替わった:

  ```
  $ gh pr merge 1007 --squash            ← --delete-branch を付けていない
  $ gh pr view 1007 --json state,mergeCommit
  state=MERGED commit=be721e77
  $ gh pr view 1013 --json state,baseRefName,isDraft
  state=OPEN base=main draft=true        ← 生きていて、base も main へ付け替わっている
  $ gh api repos/takecchi/alteroid --jq .delete_branch_on_merge
  true                                    ← 枝自体はリポジトリ設定で自動的に消えた
  ```

  **⟹ 枝が消えること自体は #1008/#1010 の組と同じ（`delete_branch_on_merge=true`）。違うのは「誰が・いつ消したか」に見える。** `--delete-branch` を明示すると `gh pr merge` 自身が（依存側の付け替えより先に）枝を消すように見えるのに対し、明示しなければ GitHub 側の自動削除に任せる形になり、そちらは依存 PR の base を付け替えてから消しているように見える。**⚠️ これは実測2件（#1008/#1010 が閉じた組、#1007/#1013 が生き残った組）から見えた違いであって、GitHub 側の削除処理の実装を確認したわけではない。** 断定はしない——**「`--delete-branch` を付けない」だけで足りる可能性は高いが、確認できているのは「上の `gh pr edit --base main` を先にやる対策なら確実に安全」というところまでである。** 急ぐ理由が無ければ、確実な方（先に付け替える）を使うこと。

## AGENTS.md「リポジトリの約束」から

逐語に正規表現のメタ文字（`$ { } ( ) [ ] * + ? . | ^ \` や先頭の `-`）が入ると、`grep -n` はそれを正規表現として解釈し、0件や誤爆（別の行が当たったように見える）を自分で作る。`-F`（fixed strings）は逐語をそのままの文字列として扱うので、「逐語の一部で指す」という意図とちょうど一致する。**`--` は必須である** — 逐語が `-` から始まると、`--` の無い形は道具ごとに壊れ方が違い、一部はカレントディレクトリの中身にも依存する（実測 2026-08-25、#408。shim=ugrep 7.8.4・GNU grep 3.8・`git grep` は「固まる」「exit 1 で無出力」「別ファイル・別行の偽陽性（文脈行付き。読み手には正しい出典に見える）」のいずれかになり、`rg` だけは exit 2 で明示的に拒否して黙って壊れることが無かった）。`grep -Fn -- '<逐語>' <path>` の形であれば、上のメタ文字全種と先頭の `-` を含めて4主体（shim / GNU grep 3.8 / `rg -F` / `git grep -F`）で当たることを実測済み（生の出力は PR #447）

- **`git diff --stat origin/main <ブランチ先端>` の答えは、実行した瞬間の `main` の状態に依存する。** これは「この PR が何を変えるか」ではなく「main からブランチ先端へ移動したら何が変わるか」を答えている — **#99 と #101 では正しく表示された。** ただしそれは両方とも直前に rebase したばかりで main と起点が一致していたからで、コマンド自体の正しさの証明にはならない。main が #99・#101 の2本で進んだ後、起点を `a3c3f93`（それ以前）のまま持つ #100 でこれを打つと以下が出た:

  ```
  $ git diff --stat origin/main pr100f
   .env.example                |  2 +-
   AGENTS.md                   |  8 ++++++--
   apps/daemon/src/schedule.ts | 47 +--------------------------------------------
   compose.yaml                |  7 +------
   packages/core/src/clone.ts  |  7 +++----
   railway/README.md           |  2 +-
   6 files changed, 13 insertions(+), 60 deletions(-)
  ```

  `schedule.ts` から47行・`compose.yaml` から6行が消える形は、直前にマージした #101 を巻き戻す差分に見える。これを「#100 の diff」として読み、そのままマージした。**出力は嘘をついていない** — 聞いた問い（この PR は何を変えるか）と、コマンドが答えた問い（main からここへ移動すると何が変わるか）が違っていただけである。**「#100 は無傷だった」は仕組みで守られたのではなく、たまたま踏まなかった側である**（マージ後の実測）:

  ```
  $ git show --stat --format='' origin/main   # #100 のマージコミット
   AGENTS.md | 4 ++++
  $ git show origin/main:apps/daemon/src/schedule.ts | grep -n 'DEFAULT_INITIATIVE_EVERY_MINUTES ='
  76:export const DEFAULT_INITIATIVE_EVERY_MINUTES = 55;
  ```

  GitHub の squash マージがブランチ固有のコミットだけを載せたから #101 が無傷だっただけで、この検査コマンドの正しさによるものではない。**対策: `MB=$(git merge-base origin/main <branch>); git diff --stat $MB <branch>` で起点を自分で取り直す、または `gh pr diff <N> --name-only` を使う。⭐ 後者を推す** — merge-base を自分で取る形は取り忘れると壊れた形に戻るが、`gh pr diff` は間違えようがない。
  **一般化すると、「文の意味が文の外の状態に依存し、状態が揃っているうちは気づく契機が無い」という同じ形が2つ並ぶ:**

  |                            | 意味が何に依存するか                             |
  | -------------------------- | ------------------------------------------------ |
  | 「（変更が本番に）入った」 | **デプロイの状態**（マージと反映は別。上の項目） |
  | `git diff main branch`     | **main の状態**（rebase 直後か、その後進んだか） |
