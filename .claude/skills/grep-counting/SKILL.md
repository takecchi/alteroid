---
name: grep-counting
description: grep で数え上げて、その件数を根拠にするときに読む。この器の grep が静かに取りこぼす6つの形 —— 終了コードと件数が嘘をつく / 検索語が複合語に取り込まれる / NUL でバイナリ判定されてファイルを1行も見ない / 検索文字列が改行を跨ぐ / 再帰のとき .gitignore のものを黙って飛ばす / -v と -c を併せたときだけ件数が1少なくなる。どれが道具の話でどれが注意の話か、shim（ugrep）と GNU grep と rg で何が変わるか、CI では起きない形はどれか、生の実測コマンドと出力つき。
---

# `grep` で数えるときに静かに取りこぼす6つの形

<!-- AGENTS.md から移設（2026-09-17）。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **`grep` が静かに取りこぼす形は6つある。1と3と5と6は探し方を変えても見つからない（道具が見ていない／嘘をつく）。2と4は探し方を変えれば見つかる（見ているのに探し方の側で取りこぼす）。前者は道具の話、後者は注意の話である。⚠️ そして3と5と6は道具を替えれば見つかる — 直上の「どの grep か」の軸である**
  1. **終了コード・件数が嘘をつく。** `grep -c` が返す 0 は2つの意味を持つ — 該当が無い / 上流が落ちて何も出力しなかった
  2. **検索語が識別子の一部で、前後が付いた形（camelCase の複合語）に一致しない。** 大文字小文字を区別する既定では、語が複合語に取り込まれた瞬間に境界の文字が大文字化し、素の語と一致しなくなる（`startedHere` で探すと `setStartedHere` を取りこぼす、という形。この具体例自体は別途報告されたもので、今回の実測ではない）。**実測で見つかった実例**（`apps/web/app/test-support.tsx`）: `grep -c 'viewportWidth' apps/web/app/test-support.tsx` は `5`（変数名としての行のみ）を返すが、`setViewportWidth`（`export function setViewportWidth` の定義行を含む）3行を取りこぼす。`-i` を付けると `8` になる。**対策: `-i` を併用する、または識別子の一部として現れる形を想定して短く切って探す**
  3. **ファイルがバイナリ判定され、中身を一切見ない。⚠️ ただしこれは道具に依存する — 下の実例は shim（ugrep の `-I`）の挙動であって、GNU grep 3.8 では起きない**（実測 2026-08-25。後述）**。** 実例（`main` の `69057f1`、PR #92。`apps/web/app/routes/chat.tsx` に生の NUL が2バイト入っていた。PR #102 が撤去）:

     ```
     $ grep -c import apps/web/app/routes/chat.tsx   # NUL があった時点の main
     （空 — 出力そのものが無い。exit 1。0 でもない）
     $ grep -ac import apps/web/app/routes/chat.tsx
     13
     $ tr -dc '\000' < apps/web/app/routes/chat.tsx | wc -c
     2
     ```

     PR #102 の作者はこれを調査中に自分で踏み、`grep -n ErrorNote` が0件を返して「その実装は無い」と読みかけたと報告している。**「0件」と「そのファイルを見ていない」が区別できない。** 実害もあった — 別の調査で「Web UI に『開いている PR』の表示が無い」という結論を grep で出していたが、その grep はこの期間 `chat.tsx` を一度も見ていなかった。NUL 撤去後に28ファイル全走査で取り直しても結論は変わらなかったが、**取り直しが要ることは NUL がある間は分からない。** **対策: `grep -c` と `grep -ac` の結果を突き合わせる。食い違ったら NUL を疑い、`tr -dc '\000' < <file> | wc -c` で確定させる**

     **⚠️ 上の「空 — 出力そのものが無い。exit 1。0 でもない」を GNU grep の挙動として読まないこと。あれを作っているのは shim の `-I`（バイナリと判定したファイルを丸ごと飛ばす）である**（実測 2026-08-25 観測、`ugrep 7.8.4` / `GNU grep 3.8`。NUL を1バイト入れた合成ファイルで取った）:

     ```
     $ printf 'import foo\nbar\x00baz\nimport qux\n' > probe/nul.txt
     $ grep -c  import probe/nul.txt          # shim（ugrep -G -I）
     （空 — 出力そのものが無い。exit 1）
     $ grep -ac import probe/nul.txt          # shim
     2
     $ command grep -c  import probe/nul.txt  # GNU grep 3.8
     2
     $ command grep -ac import probe/nul.txt  # GNU grep 3.8
     2
     $ rg -c import probe/nul.txt
     2
     # 対照（NUL の無いファイル）: grep -c import probe/plain.txt → 1（exit 0）
     ```

     **⟹ 処方そのものは変わらない — shim では `-c` と `-ac` が食い違うので、突き合わせはいまも効く。** 変わったのは**理由**である。**GNU grep しか無い環境（CI・node から spawn した歯・人間の端末かもしれない場所）では `-c` と `-ac` が一致するので、この突き合わせは NUL の検出には効かない。** そこで NUL を疑うなら `tr -dc '\000' < <file> | wc -c` を直接打つこと

  4. **検索文字列が改行を跨ぐ。行指向の grep は行を越えられない。** 実例（PR #103 本文、実測で確認済み）: 「差分判定の保証だけが2ファイルに分かれて厚くなる」という一文全体で `printf '%s' "$BODY" | grep -c '<全文>'` を通すと0件。実際には入っていたが、本文が Markdown の行折り返しで「…2ファイルに」と「分かれて厚くなる…」が別の行に分かれていた。短い断片（「差分判定の保証だけが」）で探し直すと当たった。**PR 本文・`AGENTS.md`・`docs/` はすべて Markdown で折り返される** — 「〜が本文に入っているか確かめて」という指示自体が、この形を踏ませる方向に働く。**対策: 長い文で探さない。特徴的な短い断片で探す**
  5. **再帰（`-r`）のとき、`.gitignore` に載っているものを黙って飛ばす。** これも shim（`--ignore-files`）の挙動で、`rg` の既定も同じである。**GNU grep には無い。** ⟹ `dist/` / `node_modules/` / 生成物を `grep -r` で引くと、**在るのに「無い」が返る**（実測 2026-08-25 観測）:

     ```
     $ git check-ignore -q packages/core/dist/probe.js && echo IGNORED
     IGNORED
     # A) ファイルを名指し → shim も GNU も読む（差が出ない）
     $ grep -c 'NEEDLE' packages/core/dist/probe.js          → 1  exit=0
     $ command grep -c 'NEEDLE' packages/core/dist/probe.js  → 1  exit=0
     # B) ⚠️ 再帰で根から。一致が両側に在ると、結果が返るので欠落が見えない
     $ grep -rn 'NEEDLE' .                                   # shim
     packages/core/src/zz-probe-untracked.ts:1:…             # ← ignore されない側だけ。exit=0
     $ command grep -rn --exclude-dir=.git 'NEEDLE' .        # GNU
     ./packages/core/src/zz-probe-untracked.ts:1:…
     ./packages/core/dist/probe.js:1:…                       # ← こちらは出る
     # C) 無視されるディレクトリ自身を再帰の起点に名指しすれば飛ばさない
     $ grep -rn 'NEEDLE' packages/core/dist                  → 当たる（shim / GNU / rg とも）
     # D) 一致が gitignore 対象にしか無いとき ＝「無い」と読む経路
     $ grep -rn 'ONLYIGNORED' .                              → 出力なし exit=1（shim）
     $ grep -rl 'ONLYIGNORED' . | wc -l                      → 0  PIPESTATUS=1 0（shim）
     $ command grep -rn --exclude-dir=.git 'ONLYIGNORED' .   → ./packages/core/dist/probe.js:1:… exit=0
     $ rg -n 'ONLYIGNORED' .                                 → exit=1
     $ rg -n --no-ignore 'ONLYIGNORED' .                     → 当たる
     # 対照: 追跡ファイルに在る語なら shim も返す（exit=0 で当たる）
     ```

     **⚠️ D より B のほうが静かである。** D は 0 件なので「測れていない 0 かもしれない」と疑う契機が在るが、**B は結果が返る。欠落したぶんは出力にも exit code にも `PIPESTATUS` にも現れない。** ⟹ **数え上げの分母が黙って縮む。** **対策: 生成物・依存・`dist` を含めたいなら `command grep -rn` か `rg --no-ignore` を使う。全走査で数を根拠にするなら、shim・`command grep`・`rg --no-ignore` の3本で取って突き合わせる**

  6. **`-v` と `-c` を併せたときだけ、件数が1少なくなる。** shim（ugrep）の欠陥で、GNU grep には無い。**条件は「入力の末尾に改行が無い」ことだけ**である。⚠️ **`-c` 単独は正しく、`-v` 単独（行を出す側）も正しい。壊れるのは併せたときの件数だけ**なので、**「`-c` が合っているから `-vc` も合っている」と読むと踏む。** **誤差は必ず 0 の側へ倒れる**（返るのは `max(正しい件数 − 1, 0)`）⟹ **「未完は無い」「該当なし」「問題なし」を _作る_ 向きにしか壊れない**（実測 2026-09-06 観測、`ugrep 7.8.4` / `GNU grep 3.8`、Claude Code 2.1.261）:

     ```
     $ printf 'a\nb' | grep -vc 'x'                    → 1   # 正しくは 2（shim）
     $ printf 'a\nb' | command grep -vc 'x'            → 2   # GNU grep
     $ printf 'a\nb' | rg -vc 'x'                      → 2   # rg
     $ printf 'a\nb' | grep -c '.'                     → 2   # ← -c 単独は正しい
     $ printf 'a\nb\n' | grep -vc 'x'                  → 2   # ← 末尾に改行が在れば正しい
     # 1件が0件に化ける形 ＝「該当なし」を作る経路
     $ printf 'a' | grep -vc 'x'                       → 0   # 正しくは 1
     # 書き方は関係ない（-cv / -v -c / 長い形、どれも同じ）
     $ printf 'a\nb' | grep --invert-match --count 'x' → 1
     ```

     **`$(...)` は末尾の改行を落とす。** ⟹ コマンド置換で受けた変数を `printf '%s' "$VAR" |` で流す形は**必ず**この条件に入る。**逆に `echo "$VAR" |` ・ `<<< "$VAR"` ・コマンドから直接パイプする形は改行が付くので踏まない**（実測 2026-09-06 観測）:

     ```
     $ V=$(git log --oneline -3)                # 末尾の改行はここで落ちる
     $ printf '%s' "$V" | grep -vc 'ZZZ'        → 2   # 正しくは 3
     $ echo "$V"        | grep -vc 'ZZZ'        → 3
     $ git log --oneline -3 | grep -vc 'ZZZ'    → 3
     $ printf '%s' "$V" | grep -v 'ZZZ' | wc -l → 3   # ← 分ければどの実装でも正しい
     ```

     **件数が 0 に化けると exit code も 1（該当なし）になる。** 数と exit code が揃って「無い」側へ倒れるので、`if` で受けても気づけない。**⚠️ ただし stdout を `/dev/null` へ捨てたときだけ exit 0 が返った**（同日実測。`> ファイル`・コマンド置換・パイプでは exit 1）。**この食い違いの機序は分かっていない。**

     **ファイル引数でも同じに壊れる**（末尾に改行の無いファイルを名指ししたとき）。**対策: 数えるときは `-v` と `-c` を併せない — `grep -v … | wc -l` に分ける。** `command grep -vc` / `rg -vc` でもよい。**この形を repo に書き込ませない歯が在る**（逐語は `grep -Fn -- '-v と -c を併せた grep' scripts/check-no-grep-vc.test.ts`）

     **⚠️ CI では起きない。** GitHub Actions の `ubuntu-latest` に shim は無く、`grep -vc` は正しい値を返す（実測 2026-09-06 観測、`ubuntu-24.04` / `GNU grep 3.11`。`~/.claude/shell-snapshots/` が存在しない）。⟹ **手元で数えた件数と CI で数え直した件数が食い違う。** 直上の「どの grep か」が、そのままこの項目の軸である
