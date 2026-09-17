---
name: branch-cleanup
description: 枝を消してよいかを判定するときに読む。squash マージでは compare の behind / identical が効かず着地済みの枝も diverged を返すこと、git diff のファイル数でも判定できないこと、使う4段の手順（MERGED の PR → 記録された headRefOid → マージ後に積まれた分が main に在るか → 通らなかったら消さない）、2段目が要る理由の実測、headRefOid と先端が食い違うもう1つの理由（同名の枝の作り直し）と activity API での見分け方、ref がいつ動いたかを committer.date で測らないこと。
---

# 枝を消す前に「着地したか」を判定する

<!-- AGENTS.md から移設（2026-09-17）。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

**枝を消す前の「着地したか」の判定は、`compare` の `behind` / `identical` では取れない。squash マージに効かないためである。**

squash マージは枝のコミットを `main` へ載せず、**新しい1コミットを作る。⟹ 枝側のコミットは `main` の祖先にならない**ので、`gh api repos/OWNER/REPO/compare/<main sha>...<枝 sha>` は**着地済みの枝でも `diverged` を返す。** 実測(2026-08-26、`main` / `release/prod` / `codiva/*` を除く15本): **`diverged` が15本、`behind` と `identical` は0本。**

**`git diff <main sha> <枝 sha>` のファイル数でも判定できない。** 枝は `main` から遅れているので、**差分は `main` 自身が進んだ分に埋もれる**（同じ15本で 3〜396 ファイル）。

**⟹ 使う手順は4段。1段でも取れなかったら消さない:**

```sh
# 1. その枝を head とする MERGED の PR が在るか
gh pr list --repo OWNER/REPO --state merged --head <枝名> --json number,state
# 2. その PR の記録された head と、枝の「いまの」先端が一致するか
gh pr view <N> --repo OWNER/REPO --json headRefOid --jq '.headRefOid'
git ls-remote <url> refs/heads/<枝名> | cut -f1
# 3. 食い違うなら、マージ後に積まれた分が main に在るかを測る
git diff <headRefOid> <枝の先端> > /tmp/tail.patch
git -C <main のツリー> apply --check -R /tmp/tail.patch   # 通れば main に在る
```

**⚠️ 4段目: 3 が通らなかったら消さない。** 通らないのは「`main` に無い」ではなく「**判定できない**」である —— `main` 側がその後に書き換わっていれば、**中身が在っても文脈が合わずに落ちる。**

**なぜ2段目が要るか —— 1段目だけで消すと、マージの後に積まれた未着地の中身ごと消える。** 実測(2026-08-26): MERGED の PR を持つ枝**3本すべて**で、`headRefOid` と現在の先端が食い違った（**3本とも**マージ後に1本積まれていた）。

**⚠️ 「判定できない」を「消してよい」へ倒さないこと。** 消すのは取り消しにくい側なので、**3つ目の状態（判定できない）は「消さない」へ落とす。**

- **枝がいま触られているかを、先端コミットの `committer.date` で測らないこと。ref がいつ動いたかを持つのは `gh api "repos/<OWNER>/<REPO>/activity?ref=refs/heads/<枝>"` である。** 実測(2026-08-27、この repo の5本): `release/prod` は activity の `push` が `2026-08-26T21:49:25Z`、先端の `committer.date` が `2026-08-26T21:44:43Z` で **4分42秒**ずれた。`fix/distill-shutdown-dedup` は `force_push` が `2026-08-21T09:04:52Z`、`committer.date` が `09:04:24Z`、**`author.date` は前日の `2026-08-20T11:53:59Z`** である（rebase / amend の跡）。**⚠️ 倒れた側を上げておく — 測れた `committer.date` の乖離は数秒〜4分42秒で、「push 時刻とは無関係」までは示せていない。** 言えるのは「一致するとは限らない」と「`author.date` は日の単位でずれる」までである
- **上の4段の手順で `headRefOid` と先端が食い違う理由は、「マージ後に積まれた」以外にもう1つある — 同名の枝が消されて作り直されている場合である。** 実測(2026-08-27): `feat/api-surface` の activity は `branch_creation`(`2026-08-12T22:23:27Z`) → `branch_deletion`(`22:31:21Z`) → `branch_creation`(`22:59:22Z`) の3件を持ち、**MERGED の PR #16 が記録している head は最初の作成のほうで、いまの先端とは別物である**（`gh api repos/takecchi/alteroid/commits/<いまの先端>/pulls` は空を返す）。**手順そのものは変えなくてよい** — 2段目で食い違い、3段目も通らないので（実測: `git diff 6c4a605 cddcc23c` が出す 629 行の patch を `main`（`dbf66da`）のツリーへ `git apply --check -R` すると `patch does not apply` で exit 1）、「判定できない」へ落ちて結論は「消さない」で正しい。**変わるのは食い違いの読み方である** — 「マージ後に1本積まれた」と読むと、実際には**別物の枝**を同じものとして扱うことになる。**そして activity は `branch_deletion` と `force_push` を別のイベントとして持つので、この2つはこの API の側で区別できる**
