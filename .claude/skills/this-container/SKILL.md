---
name: this-container
description: 自分（クローン・マネージャー・作業者）がいま走っている器そのものの事実（置き場・プロセス共有・pids・pnpm test の混雑・python3 が無い 等）と、AGENTS.md がいつ自分の文脈に載るか（ハーネスの読み込み）を確かめる前に読む。
---

この内容は #1192 の再編で AGENTS.md から逐語で移したもの。要約・短縮はしていない。

## AGENTS.md「書く先を決める（この文書とスキルの分担）」から

かつてここにそう書いてあったが、実測（2026-08-22T09:35Z 観測）と食い違っていた。**載り方は層ごとに違い、しかも同じ層でも「どのツールで repo のファイルを触ったか」に依存する。**

- **載せる設定そのものは渡っている。** `settingSources: ['user', 'project', 'local']` は `Options` を組み立てる3つの口すべてに在る（`packages/core/src/claude-provider.ts` の `buildCloneSessionOptions` / `buildCloneDistillOptions` / `buildManagerSessionOptions`）。**効いていないのは配置のほうである** — `settingSources` の `'project'` が解決する先はセッションの `cwd` であって、この文書の在り処ではない
- **クローン**: `cwd` は `paths.root`＝`ALTEROID_HOME`（`apps/daemon/src/index.ts` の `createClone({ cwd: paths.root })`、`Dockerfile` の `ENV ALTEROID_HOME=/data/alteroid`）。**そこにこの文書は無いので、載らない。これはバグではなく設計である** — 同じ箇所に「クローン自身の cwd は workspace とは別に渡す。クローンへ渡している `cwd` と同じ値でなければ、自己認識が嘘になる」と逐語で書いてある。**だから「cwd を repo にすれば直る」はクローンには当てられない**
- **マネージャー**: `cwd` は `runner.workspacePath`＝`ALTEROID_WORKSPACE`（`apps/runner/src/index.ts`、`Dockerfile` の `ENV ALTEROID_WORKSPACE=/workspace`、`manager.ts` の `input.cwd ?? runner.workspacePath`）。**この文書は `/workspace/<マネージャーID>/repo/` の中で、`cwd` の直下ではない。だからセッション開始時には載らない。** ただし**後から載る導線が別に在る**（次の項目）
- **作業者**: マネージャーと同じ導線で届く（作業者自身の直接観測）。`buildWorkerPrompt()`（`packages/core/src/prompt.ts`）は定型文を返すだけで本文を1文字も含まないので、**作業者へ届く経路はこの導線だけである**
- **後から載る導線とは何か。** SDK の型定義に `InstructionsLoaded` フックが在り、`InstructionsLoadedHookInput` の `load_reason` は次の5値を取る（`@anthropic-ai/claude-agent-sdk@0.3.261` 同梱の `sdk.d.ts`）。

  > [sdk-verbatim InstructionsLoadedHookInput.load_reason]
  > load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';

  **`session_start` 以外はすべてセッション途中の読み込み理由である。** そして同じ `sdk.d.ts` は、`Options.settingSources` について別のことも逐語で言っている。

  > [sdk-verbatim Options.settingSources]
  > Must include `'project'` to load CLAUDE.md files.

- **いつ載るかの機構は特定されていない。** 実測が4つあり、**4つとも形が違う**（すべて 2026-08-22、別々のセッション）
  - **マネージャー(1)**: `Bash` の `cat` / `sed -n` / `grep` を repo 配下へ何度打っても載らず、**`Read` ツールで repo のファイルを1つ開いた直後に**全文が差し込まれた。2回目以降の `Read` では再送されなかった
  - **作業者**: 同じく `cat` で読み進めるあいだは載らず、**`Read` を使った後で載った。** 別の作業者は「セッションのごく最初期に載った」と報告しているが、その直前に `.claude/skills/` の `SKILL.md` を開いている
  - **マネージャー(2)**: 開始時は載っておらず（だから `cat` で読んだ）、**作業中に載った。契機は特定されていない** — `cd` で作業ツリーへ入ったことか、器が clone を検知したことか、どちらとも確かめられていない。**この人は `Read` を使っていない**
  - **マネージャー(3)**: **同じセッションの中で、ツリーによって載り方が違った。** `repo` のツリーで何時間も編集していたあいだは載らず、**別の `check` ツリーで `.claude/skills/` の `SKILL.md` を編集した直後に、そちらのツリーの `CLAUDE.md` が全文で載った。** なぜ `repo` 側では載らなかったのかは説明が付いていない
- **だから「`Read` が引き金」とは書けない。** 3例目がそれを否定し、4例目は「同じセッションでもツリーによって違う」という別の形を足す。**言えるのは「開始時に載っていないことがあり、後から載ることがある。何が載せるのかは分かっていない」までである。** これ以上を書くと、この文書はまた自分について嘘をつく
- **5例目が在るが、上の4つとは種類が違う — こちらは機構が分かっている。** マネージャー(4): `cwd`（`/workspace`）の根が**別のマネージャーのチェックアウト**になっていて、その `CLAUDE.md`（`AGENTS.md` への symlink）が `cwd` の直下に在ったため、**セッション開始時に全文が載った**（実測 2026-08-22T15:36Z。同じ日に他の3本のマネージャーも「開始時から載っていた」と報告しているが、そちらは自分では見ていない）。**これは `settingSources` の `project` が `cwd` を解決するという、上に書いたとおりの挙動そのものである** — `nested_traversal` の謎とは無関係なので、**4例の数え上げには足していない**
  - **ここで効くのは「載ったかどうか」ではなく「誰の版が載ったか」である。** 根のチェックアウトは他人のもので、その HEAD は `main` とは限らない（実測のそれは未 push のブランチだった）。**自分がこれから clone する版とは別のものが、指示として自分の文脈に載る。** 上の**「マネージャー: … `cwd` の直下ではない。だからセッション開始時には載らない」は、`cwd` の直下に `CLAUDE.md` が無い前提の上でしか効かない**（そうなっている器で何をするかは「自分が走っている器」が持つ）
- **⚠️ ここに書いてあるのは全部ハーネスの挙動であって、alteroid が制御しているものではない。しかも引き金の側は公開されていない。** 公開の型定義に在るのはイベント名（`InstructionsLoaded`）と `load_reason` の値までで、**何が `nested_traversal` を起こすかは、同梱の README にも CHANGELOG にも型コメントにも書かれていない**（利用者が通常目にしない CLI バイナリ内部の文字列としてのみ確認できた。そこには `trigger_file_path` を「the file Claude touched that caused the load」と説明する記述が在る）。**つまり SDK が上がれば変わりうるし、変わっても赤くならない**（届かなくなるだけである）。**この導線を前提にした設計を入れないこと** — 入れるなら、届いているかを別に観測できる形とセットにする

**毎ターン再送されるかは確かめていない。** マネージャー層でも作業者層でも観測できたのは**1セッションにつき1回**で、2回目以降の `Read` では差し込まれなかった。一度載れば以降は会話履歴として残り続けるので、「毎ターン新しく送られる」のか「1回載って残るだけ」なのかは**この観測では区別できていない**（`sdk-tools.d.ts` の `FileReadOutput` の `source` 欄の doc が、CLAUDE.md が `Read` と同じ重複排除に乗ることを逐語で言っている）。

> [sdk-verbatim FileReadOutput.source]
> Set when the dedup matched a startup-seeded entry (CLAUDE.md / nested memory) rather than a prior Read tool_result

**ただし compaction を跨げば読み直される** — CLI の実装が compaction のときに既読フラグ（`loadedNestedMemoryPaths`）と `readFileState` を丸ごと消しているのを、バイナリ内の文字列で確認した。**実際に起きるところは見ていない。**

- スキルの一覧（名前と説明）は `skills: 'all'` で載る、と書いてあったが、**それが効くのはクローンとマネージャーだけである。作業者には載らない。** `buildManagerSessionOptions`（`packages/core/src/claude-provider.ts`）は `agents` エントリに `skills` を書いていないので（`AgentDefinition.skills` が `'all'` を受けないため意図してそうしてある）。**SDK 側の裏も取れている** — `sdk.d.ts` の `Options.skills` の doc も逐語でそう言っている。

  > [sdk-verbatim Options.skills]
  > Applies to the main session only; subagents use AgentDefinition.skills

  `AgentDefinition.skills` の型は `string[]` のみである（`@anthropic-ai/claude-agent-sdk@0.3.261` 同梱の `sdk.d.ts`）、**作業者に見えているのはハーネス既定の汎用スキルだけで、このリポジトリのスキルは1つも載っていない**（作業者層での直接観測、2026-08-22T09:35Z）。

- マネージャー層では、`cwd`（`/workspace`）配下へ clone した後に `<相対パス>:<スキル名>` の形で一覧が現れた観測例が2本ある（別のマネージャーの報告）。**現れる時機と条件は確かめていない** — 自分では未観測である

## AGENTS.md「自分が走っている器」から

実測(2026-08-22T15:36Z 観測): 根に `AGENTS.md` と `.git` が在り、`git -C /workspace reflog` の末尾が `HEAD@{2026-08-22 22:20:26 +0900}: clone: from https://github.com/takecchi/alteroid.git` だった。**器がそう作るのではない** — `Dockerfile` は `mkdir -p /workspace` で空のまま作るので、**別のマネージャーが根へ clone した結果である**

根がチェックアウトになっている器で `/workspace/<自分のID>/repo` へ clone すると、自分のツリーは相手のツリーの内側に入る。相手が根で `pnpm format:check` / `pnpm lint` を打つと、**走査が自分のツリーまで降りて落ちる** — 自分の側は最後まで緑のままである。実測(2026-08-22T15:50Z): 自分の clone の直下に整形前の `.md` を1つ置いただけで `prettier --check .` が `exit 1`（`[warn] zz-nested-probe/BAD.md`）になった。**確かめたのは素のディレクトリで、入れ子の clone そのものでは試していない**（`.gitignore` に載らないので走査対象になる点は同じである）。実際に 2026-08-22、`/workspace` の下に出来た作業ツリーが別のマネージャーの `eslint` / `format:check` を落としている

- **`/tmp` へ置く帰結: 器が落ちれば消える。** だから下の「clone して最初の変更を入れたら、その時点で push して draft PR を開く」の理由がそのぶん強くなる。**ただし `/workspace` なら残る、でもない** — 残るのは名前付き volume を当てている compose 構成（`compose.yaml` の `${ALTEROID_WORKSPACE_HOST:-workspace}:/workspace`）だけで、**Railway では volume の宣言が無いので**（`railway/runner.json`）**`/workspace` も `/tmp` も器と一緒に消える**（実測 2026-08-22T15:47Z: `df` で `/workspace` `/tmp` `/data` の3つとも同じ overlay）
- **この置き場所の規則は、clone する前には読めない。** 規則はこの文書に在り、この文書は clone した後の作業ツリーの中にしか無い（マネージャーのシステムプロンプトは `AGENTS.md` の所在を告げるだけで、置き場所を指定しない — `packages/core/src/prompt.ts` の `buildManagerSystemPrompt`）。**だから置き場所は依頼文が渡すしかない** — 「作業者へ切り出す」の所有権の項目と同じで、**依頼文に書かれていなければ受け手には現れない**
- **シェルの cwd は `/workspace` へ戻る。** `cd` を1度きりにしない（「静かに失敗する道具」参照）
- **`python3` は無く、`pkill` / `pgrep` も実体が無い。** 作業用のスクリプトは node で書く

  - **「渡したら読むだけ」は、素の git では守れない。** `git status --porcelain` は `.git/index` を書く（実測: git 2.47.3。mtime を 2020-01-01 へ落として打つと現在時刻になる。差分の有無に関係なく毎回書く。`--no-optional-locks` を付けると書かない）。⟹ **他人のツリーを覗くときは `GIT_OPTIONAL_LOCKS=0` を環境に置く**（または `git --no-optional-locks …`）。`grep -Fn -- '作業ツリーの所有権は、常にちょうど1人が持つ' AGENTS.md` の規約は、この形でだけ成立する
  - **退避（停止に備えて成果を出す）が要るときに、持ち主でない側が撃ってよい git / 撃ってはいけない git を分ける。**
    - ⭕ **撃ってよい**: `git push`（作業ツリー・index・HEAD のどれも動かさない。既にコミット済みのものは、持ち主でなくても安全に出せる）、`GIT_OPTIONAL_LOCKS=0` を付けた `git diff HEAD` / `git ls-files --others --exclude-standard` / `git log` / `git rev-list`（実測: この4種は `.git/index` の mtime を動かさない——未コミットの差分は読み取りだけで取れる）
    - ⛔ **撃ってはいけない**: `checkout` / `checkout -b` / `switch` / `add` / `commit` / `reset` / `stash` / `merge` / `rebase`。HEAD・index・作業ツリーのどれかを動かすものは全部
    - ⟹ #1067 本文の「退避専用の別ツリーでは未コミットの差分に効かない」は条件付きでしか正しくない。未コミットの差分は上の読み取りだけの口で取れる（`git diff HEAD --binary` の patch と untracked の一覧）ので、取ったものを別ツリー（`git worktree add` か別 clone）で commit / push すればよい。⟹ 持ち主のツリーでは1文字も書かずに退避が完了する
    - ⚠ ただし `git worktree add` は共有の `.git/` へ書く（`grep -Fn -- '設定に依存する検査は、worktree を分けても切り分けられない' .claude/skills/tool-quirks/SKILL.md` が既に持つ）。中身・index・HEAD は分かれるので⛔には当たらないが、完全に無干渉ではない。いちばん干渉が少ないのは別 clone である
    - ⛔ **測っていない**: `git push` が index を動かさないことはリモートが要るため未測定（doc の判断のみ）。`git status` の書き込み・`--no-optional-locks` で書かないこと・上の4種（diff/ls-files/log/rev-list）が書かないことは、いずれも mtime で実測済み
  - そもそも退避が要る回数を減らすほうが先である。`grep -Fn -- 'clone して最初の変更を入れたら、その時点で push して draft PR を開く' AGENTS.md` の規律が守られていれば、退避で拾うべき未コミットの差分はそもそも小さい。退避の作法は最後の網であって、一番手ではない

- **`CI=true` が入っているので `pnpm install` は `--frozen-lockfile` として振る舞う。** catalog（`pnpm-workspace.yaml`）を触ったら `--no-frozen-lockfile` が要る
- **`pnpm test` は器が混んでいると、既定の並列度で「テスト0本のまま `exit 1`」になる。** vitest の fork pool が `write EPIPE` で死ぬ形で、**出力は30行未満で終わり `Test Files` / `Tests` の行が出ない。** `exit 1` だけを見ると「テストが落ちた」と読めるので、**存在しない失敗を直しに行くことになる**
  - **⚠️ この `write EPIPE` は、この節（自分が走っている器）の下のほうにある pids 上限の項（`gh` の `errno=11` / `git` の `getaddrinfo() thread failed to start` など）と同じ族の可能性が高い。** 「同じ文字列だが別の落ち方」ではなく「同じ pids 枯渇の族が、vitest の fork pool の側に出た顔」だと考えられるが、**そう断定できるだけの測定は無い。** pids 上限の項にも同じ相互参照が張ってある
  - **見分けるのは行の「不在」である。** `Test Files  N passed` / `Tests  N passed` が出ていなければ、通ったのでも落ちたのでもなく**走っていない**。**「落ちた」と「1本も走らなかった」はどちらも `exit 1` である**（変異試験でベースラインを確かめるのと同じ理由）
  - **対処は並列度を下げること。** `pnpm test --maxWorkers=4` で全スイートが完走した（vitest は既定で `nproc` に応じた数の fork を起こす）。**完走したかは件数ではなく、直上の項目の `Test Files` / `Tests` の行が出ているかで見る。だから件数をここに書かない** — テストが増えるたびに腐るうえ、判定にはもともと使えない（ここには `86 files / 1,379 tests` と書いてあり、2日後の実測は `92 files / 1,542 tests` だった）。**器の CPU 数も同じ理由で書かない。要るなら `nproc` で自分で取ること**（ここには `32` と書いてあり、別の器で `48` という報告が上がっていた）。**固定した数は固定した瞬間から腐り、腐ったことは読む側からは分からない。****全スイートは回す** — 回す範囲を狭めるのは能力を削る側で、並列度を下げるのはバーを保ったまま器に合わせる側である
  - **#2905 から、`--maxWorkers` を渡さないときの既定に上限（`vitest.config.ts` の `MAX_WORKERS_CAP`）が掛かっている。** vitest 自身の既定（`availableParallelism() - 1`）がそれより大きい器でだけ効く。CI（4 vCPU）の並列度は変わらない。**`--maxWorkers=<n>` を渡せばそちらが優先される**ので、上の対処（下げて渡す）も、空いている器で上げて渡すのもそのまま効く。上限の値はここに書き写さない（持ち主は `vitest.config.ts`）
  - **`--pool=threads` へ逃げないこと。** プロセス分離が要るテスト（シェルスクリプトと fs のもの）が threads では落ちるので、**器の問題を別の嘘に置き換えるだけ**である
  - **根拠は「`--maxWorkers` を下げたら通った」ということだけである。** 誰と食い合ったかは特定していない — **プロセスをパターンで選ぶ走査は、それ自体が他人を撃つ形**なので行っていない（上の項目）。ここに原因を書き足さないこと
- **同一の作業ツリーで `pnpm build` が2本走ると、互いの `dist` を消し合う。** `pnpm test` の混雑（直上）とは別の落ち方で、**混んでいるかどうかではなく、同じツリーで2本目が走っているかで決まる。** ⚠️ **エラー本文の助言（`@types/…` を入れろ / `declare module` を書け）を真に受けないこと — 依存の宣言不足ではない。** **機構（`tsup` の clean が2箇所に在ること）・4つの顔・実測表と、build の資源を外から絞る口（`PNPM_CONFIG_WORKSPACE_CONCURRENCY` / `RAYON_NUM_THREADS` / `ROLLDOWN_WORKER_THREADS`）は `.claude/skills/build-contention/SKILL.md` に在る**
- **この器は pids 上限に当たることがあり、`gh` の起動すら `errno=11`（`failed to create new OS thread`）で失敗する。** `ulimit -u` は大きい（1048576）ので**ユーザの上限ではなく器の側の上限**である。**再試行は混雑を足すので、待つほうが速い** — ここは「待ちのターンを回さない」の裏面で、**待つしかない場面の実例**である
  - **`gh` 以外にも同じ族の顔が出る（#312）。** `git fetch` などネットワークを使う経路では `fatal: unable to access '...': getaddrinfo() thread failed to start`（**一見ネットワーク障害に見えるが、器の混雑でも出る。再試行しないこと** — 「再試行は混雑を足す」は直上と同じ理由でここにも当てはまる）。`git grep` など局所の並列処理では `fatal: grep: failed to create thread: Resource temporarily unavailable`。**踏んだ人はたいてい出たエラー文字列でこの文書を grep するので、当たる語を増やしておく**
  - **⚠️ 同じ族の顔は、この節の上のほうにある `pnpm test` の項（vitest の fork pool が `write EPIPE` で死ぬ形）にも出ている。** 「同じ文字列だが別の落ち方」と読まないこと — **「同じ pids 枯渇の族が、vitest の fork pool の側に出た顔」である可能性が高いが、そう断定できるだけの測定は無い。** どちらの節から読んでも、もう片方へ辿れるように相互に注記してある
  - **依頼者の観測（2026-08-24 夜）** — この器が同じ枯渇に当たったときに実際に出た4つの顔（依頼者側の観測であり、自分では測っていない）:
    - `Claude Code process terminated by signal SIGABRT`（マネージャー3本が死亡: mgr-6ff7ba34 / mgr-be1ddfaf / mgr-aba73794）
    - `write EPIPE`（作業者が踏んだ）
    - `node` が `uv_thread_create` の assertion で落ちる（作業者が踏んだ）
    - `echo hello` が0行のまま `exit 1`（fork できない。マネージャーが器の状態を確かめようとして踏んだ）

    そのときの実測（依頼者が `runner_list resources` で取得。**この道具は依頼者側にしかなく、器の中からは打てない**）: `runner-primary 1000/1000` → mgr-6ff7ba34 が死亡、`runner-2 984/1000` → mgr-be1ddfaf と mgr-aba73794 が死亡、`runner-3 443/1000` → 死者ゼロ

  - **pids が尽きた器では、状態を見るためのプロセスも起こせない。** 実際に、あるマネージャーが `cat /sys/fs/cgroup/pids.current` すら打てなかった（依頼者の観測）。**＝ 詰まりを検出する手段が、詰まりによって失われる**
  - **器の中から測れなくなったら、外（依頼者の `runner_list resources`）からしか見えない。** 直上の「再試行は混雑を足すので、待つほうが速い」は変わらないが、**「待つ」だけでは器の中からは復帰を観測できない** — 踏んだら連打せず、そのターンを終えて依頼者へ報告する

## AGENTS.md「書く先を決める」から（#1192 の再編 3/3 で移した）

この内容は #1192 の再編で AGENTS.md から逐語で移したもの。要約・短縮はしていない。

**`skills` はコンテキストのフィルタであってサンドボックスではない**（SDK の型定義に明記がある）ので、一覧に出なくてもファイルはディスク上にあり `Read` / `Bash` から到達できる

## AGENTS.md「自分が走っている器」から（#1192 の再編 3/3 で移した）

この内容は #1192 の再編で AGENTS.md から逐語で移したもの。要約・短縮はしていない。

- **器に postgres 17 と pgvector が在る**（2026-09-15 から。`Dockerfile` の runtime ステージ、#965）。**立て方（`initdb` / `pg_ctl` を uid 1001 のまま直に叩く手順と、`pg_createcluster` が使えない理由）は `.claude/skills/postgres-in-container/SKILL.md` に在る**
