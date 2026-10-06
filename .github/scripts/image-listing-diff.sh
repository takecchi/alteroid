#!/bin/sh
# runtime と final のファイル列挙（`docker export | tar -tvf -` から mtime を落として
# sort したもの）を突き合わせる。**1 行でも違えば非 0 で落ちる。除外は無い。**
#
# 非決定的な差（apt のログ・codex の一時ディレクトリ・chunk のハッシュ名など）は、
# この比較に除外を足して消すのではなく、2 つの像を 1 回のビルドで焼く
# （`docker-bake.hcl`）ことで、そもそも出ないようにしてある。
# 使い方: image-listing-diff.sh <runtime.list> <final.list>
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 <runtime.list> <final.list>" >&2; exit 2; }
diff "$1" "$2" || { echo "空の final が runtime とファイル系で違う" >&2; exit 1; }
