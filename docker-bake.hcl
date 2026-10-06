# CI の `image` job が final と runtime を「同じ 1 回のビルド」で焼くための定義。
#
# 2 本の `docker/build-push-action` で別々に焼くと、片方は上流の gha キャッシュから
# 古い層を取り、もう片方は同じ RUN を走らせ直すことがある（実測: PR #3174 の run
# 37419381099、後者が apt / npm install -g codex / pnpm build を全部やり直した）。
# RUN の出力は非決定的（apt のログ・codex の一時ディレクトリ・chunk のハッシュ名など）
# なので、そうなると突き合わせが「中身の欠落」ではなくビルドごとのゆらぎで落ちる。
# bake は 1 回の solve で両ターゲットを焼くので、共通の層は 1 度だけ作られ、
# `final`（`FROM runtime`）と `runtime` は同じ層を共有する。
#
# Railway と compose は使わない（Dockerfile を直接焼く）。CI 専用。
variable "BUILD_REV" {
  default = ""
}

group "default" {
  targets = ["runtime", "final"]
}

target "runtime" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "runtime"
  tags       = ["alteroid:ci-runtime"]
  args = {
    ALTEROID_BUILD_REV = BUILD_REV
  }
}

target "final" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "final"
  tags       = ["alteroid:ci"]
  args = {
    ALTEROID_BUILD_REV = BUILD_REV
  }
}
