# Claude 以外の経路・ローカル LLM で alteroid を動かす

> **これは使い方のガイドであって、正典ではありません。** 要件と設計は [docs/north_star.md](../north_star.md) / [docs/PRD.md](../PRD.md) / [docs/architecture.md](../architecture.md) が持ちます。矛盾したらそちらが勝ちます。
>
> 書いた時点のコードは `a602ec80`、公式ドキュメントは 2026-10-08 に読んだものです。

## まず仕組み: 何を差し替えると、どこが変わるのか

alteroid は推論の基盤を自作していません。クローン（デーモン）も、マネージャーと作業者（runner）も、[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) が子プロセスとして起こす **Claude Code** の上で走ります。LLM へリクエストを出しているのは Claude Code です。

だから、**Claude Code が読む環境変数（`ANTHROPIC_BASE_URL` など）が SDK の子プロセスまで届けば、alteroid の層もその経路で走ります。** alteroid 自身に「LLM の接続先」という設定はありません。

各層が SDK に渡すモデル名は、既定では**別名**です。別名をどのモデルに解決するかは Claude Code が決めます。

| 層           | 既定の別名 | 差し替える変数（器の環境変数） | コード                            |
| ------------ | ---------- | ------------------------------ | --------------------------------- |
| クローン     | `opus`     | `ALTEROID_CLONE_MODEL`         | `packages/core/src/clone.ts:333`  |
| マネージャー | `opus`     | `ALTEROID_MANAGER_MODEL`       | `packages/core/src/runner.ts:201` |
| 作業者       | `sonnet`   | `ALTEROID_WORKER_MODEL`        | `packages/core/src/runner.ts:204` |

- `ALTEROID_*_MODEL` の値を alteroid は検証しません（`packages/core/src/model-tier.ts` の `resolveModelTier`）。`qwen3-coder` のような別名でない名前もそのまま SDK へ渡ります。
- 別名を使い続ける場合の行き先は、Claude Code の `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` で変わります（[公式: Model configuration](https://code.claude.com/docs/en/model-config)）。`ANTHROPIC_DEFAULT_HAIKU_MODEL` は、セッション名づけのような背景処理のモデルにも効きます。
- **層とモデル帯の対応を変えるのは人間の承認事項です**（[AGENTS.md](../../AGENTS.md)「踏みやすい地雷」）。`ALTEROID_*_MODEL` に置いた値は起動時の表示と `self_status` に出ます。`ANTHROPIC_DEFAULT_*_MODEL` で別名の行き先を変えた場合は、**いまはどこにも出ません**（[#4261](https://github.com/takecchi/alteroid/issues/4261)）。

## 経路の一覧（公式に対応しているもの／互換 API で動くだけのもの）

| 経路                                                                                                | 公式の対応                                                                                | 何で切り替えるか                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Anthropic（Claude のサブスクリプション）                                                            | ✅ 既定                                                                                   | 認証トークンのプール（`alteroid token add`）                                                                             |
| Anthropic API（Console の API キー）                                                                | ✅                                                                                        | `ANTHROPIC_API_KEY`                                                                                                      |
| Amazon Bedrock                                                                                      | ✅                                                                                        | `CLAUDE_CODE_USE_BEDROCK=1` ＋ AWS の資格                                                                                |
| Google Cloud's Agent Platform（旧 Vertex AI）                                                       | ✅                                                                                        | `CLAUDE_CODE_USE_VERTEX=1` ＋ GCP の資格                                                                                 |
| Microsoft Foundry                                                                                   | ✅                                                                                        | `CLAUDE_CODE_USE_FOUNDRY=1` ＋ Azure の資格                                                                              |
| Claude Platform on AWS                                                                              | ✅                                                                                        | `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`                                                                                        |
| LLM gateway（LiteLLM など）の先の **Claude**                                                        | ✅ gateway 経由の接続は公式の手順がある。gateway 製品そのものは Anthropic の保守外        | `ANTHROPIC_BASE_URL` ＋ `ANTHROPIC_AUTH_TOKEN`                                                                           |
| gateway・互換 API の先の **Claude 以外**（Ollama・LiteLLM で OpenAI / Gemini / ローカルモデルなど） | ❌ **公式には対応していない**。Anthropic 互換の API を出しているので動く、というだけ      | `ANTHROPIC_BASE_URL` ＋ `ANTHROPIC_AUTH_TOKEN` ＋ モデル名の対応付け                                                     |
| OpenAI Codex                                                                                        | 別物。層のモデルにはならない。マネージャーが Codex に作業を頼む口（MCP `peer`）として使う | Codex のログインか `CODEX_API_KEY`（[railway/README.md](../../railway/README.md)「Codex に作業を頼めるようにするとき」） |

公式ドキュメントの根拠:

- 公式の経路の一覧: [Enterprise deployment overview](https://code.claude.com/docs/en/third-party-integrations)
- gateway: [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)。逐語で "Anthropic doesn't endorse, maintain, or audit third-party gateway products, and doesn't support routing Claude Code to non-Claude models through any gateway." とあります。
- 資格の優先順位: [Authentication](https://code.claude.com/docs/en/authentication#authentication-precedence)

**Claude 以外のモデルについての正直な見込み。** alteroid の各層は、道具（tool use）を大量に、しかも長い文脈の中で正しく呼べることを前提に作られています。クローンは記憶・委譲・エスカレーションをすべて MCP の道具で行い、マネージャーは作業者への委譲とファイル操作を道具で行います。tool use が弱いモデルでは、ターンが空回りする・道具の引数を壊す・委譲が届かない、という形で止まります。**動くかどうか、どの程度の質で動くかはモデル次第で、alteroid は保証しません。** 能力の等価性（[docs/PRD.md](../PRD.md)）を測っている基準は Claude（Opus / Sonnet）です。

層を Claude 以外へ寄せる前に、まず**部分的に**試すことを勧めます。たとえば作業者だけをローカルモデルにする、です（下の「どこに置くか」の `--scope runner` と `ALTEROID_WORKER_MODEL`）。

## 環境変数をどこに置くか

Claude Code の変数を SDK の子プロセスまで届ける口は3つあります。

| 置き場                                                                      | クローン（デーモン） | マネージャー・作業者（runner） | 向いているもの                                               |
| --------------------------------------------------------------------------- | -------------------- | ------------------------------ | ------------------------------------------------------------ |
| **環境変数の袋**（`alteroid credential set <名前> --scope all/app/runner`） | `all` / `app`        | `all` / `runner`               | **推奨。** 鍵（`ANTHROPIC_AUTH_TOKEN` など）も設定値も置ける |
| 実行環境プロファイル（`alteroid profile set <名前> --scope ...`）           | `all` / `app`        | `all` / `runner`               | シェルで組み立てたいもの。鍵は置かない（下の注意）           |
| 器の生の環境変数（Railway の Service Variables）                            | `app` サービス       | `runner` サービス              | `ALTEROID_*_MODEL`（ここにしか置けない）                     |

- **`scope` の意味**: `all` は両方、`app` はクローンだけ、`runner` はマネージャー（とその作業者）だけ。
- **袋の値は、置いた後のターンの境界から効きます。** 変わるとクローンもマネージャーもセッションを畳んで開き直します（`packages/core/src/credential-service.ts` の `onApplied` / `recycleForToken`）。
- **docker compose では、器の環境変数は `compose.yaml` の `x-shared-env` に列挙したものしか降りません。** `ANTHROPIC_*` は列挙されていないので、`.env` に書いても届きません。袋かプロファイルを使ってください。`ALTEROID_*_MODEL` は列挙済みなので `.env` に書けます（反映には `docker compose up -d` で作り直しが要ります）。
- **`ALTEROID_*_MODEL` は袋にもプロファイルにも置けません**（`packages/core/src/credentials.ts` の `ENV_FILE_OWNED_CREDENTIAL_NAMES`、`packages/core/src/model-tier.ts` の doc）。読むのが器自身のプロセスだからです。
- **プロファイルは袋より後に重なり、同じ名前なら勝ちます**（`packages/core/src/runner.ts` の `#childEnv()`）。両方に同じ名前を置かないでください。
- 重なり方の詳細は [.claude/skills/env-profile/SKILL.md](../../.claude/skills/env-profile/SKILL.md) にあります。

### 層ごとの組み合わせ

| やりたいこと                                | 置き方                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全層を同じ経路へ                            | 袋に `--scope all`                                                                                                                                                                    |
| クローンは Claude、マネージャー以下を別経路 | 袋に `--scope runner`。クローンは今までどおりプールのトークンで走る                                                                                                                   |
| マネージャーは Claude、作業者だけ別モデル   | 同じ gateway が Claude と別モデルの両方を出せるとき（LiteLLM など）に限る。`ALTEROID_WORKER_MODEL` を gateway 上の名前にする。runner の中で接続先は1つなので、Ollama 単体ではできない |

## 手順: Ollama（ローカル）

Ollama は v0.14.0 から Anthropic Messages API 互換の口を持っています（[Ollama: Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)）。

1. **モデルを用意します。** tool use ができるモデルを選んでください（例: `qwen3-coder`）。Ollama の互換 API は `tool_choice`・トークン数の計測口（`/v1/messages/count_tokens`）・プロンプトキャッシュに対応していません（同ページの "unsupported" の一覧）。

2. **器から Ollama に届くようにします。** コンテナの中の `localhost` はコンテナ自身です。
   - Docker Desktop（macOS / Windows）なら `http://host.docker.internal:11434` で手元の Ollama に届きます。
   - Linux の Docker Engine では、`compose.yaml` に `extra_hosts` が無いので `host.docker.internal` を引けません。`compose.override.yaml` を作って `app` と `runner` に `extra_hosts: ["host.docker.internal:host-gateway"]` を足すか、ホストの IP を直接書いてください。
   - Ollama が `127.0.0.1` でしか待ち受けていなければ、コンテナからは届きません（`OLLAMA_HOST=0.0.0.0`）。
   - Node で手元に動かしている場合は `http://localhost:11434` のままで構いません。

3. **接続先と資格を置きます。** `ANTHROPIC_AUTH_TOKEN` は Ollama では読まれませんが、**必ず置いてください**（下の「⚠️ 資格を置かずに接続先だけ変えない」）。

   ```sh
   # docker compose の場合。Node で動かしているなら `docker compose exec -T app` を外す
   echo -n "http://host.docker.internal:11434" | docker compose exec -T app alteroid credential set ANTHROPIC_BASE_URL --scope all --no-secret --yes
   echo -n "ollama"                            | docker compose exec -T app alteroid credential set ANTHROPIC_AUTH_TOKEN --scope all --yes
   ```

4. **モデル名を対応付けます。** 次の2つのやり方があります。
   - **(a) 層のモデル名を直接変える。差し替えが表に出るので、こちらを勧めます。** `.env`（Railway なら Service Variables）に次を書き、`docker compose up -d` で作り直します。

     ```sh
     ALTEROID_CLONE_MODEL=qwen3-coder
     ALTEROID_MANAGER_MODEL=qwen3-coder
     ALTEROID_WORKER_MODEL=qwen3-coder
     ```

     背景処理（Claude Code が裏で使う `haiku`）の行き先も変えておきます。

     ```sh
     echo -n "qwen3-coder" | docker compose exec -T app alteroid credential set ANTHROPIC_DEFAULT_HAIKU_MODEL --scope all --no-secret --yes
     ```

   - **(b) 別名の行き先を変える。** `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` を袋に置きます。器を作り直さずに済みます。ただし、層が別名 `opus` のまま別のモデルで走っていることが、いまは `self_status` にも起動時の表示にも出ません（[#4261](https://github.com/takecchi/alteroid/issues/4261)）。

5. **確かめます。** 次の2つで確認します。
   - `alteroid credential list` で、名前と撒く先が思ったとおりかを見ます。値は SDK の子プロセスにだけ重なり、runner のプロセス自身の env には入りません。だから `docker compose exec runner env` では見えません。
   - クローンに1つ話しかけて、Ollama 側のログにリクエストが来ているかを見ます。

## 手順: LiteLLM（gateway）

LiteLLM の proxy は Anthropic 形式の `/v1/messages` を出し、その先を OpenAI・Gemini・Bedrock・ローカルの vLLM などへ振り分けます（[LiteLLM: Claude Code Quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)、[Use Claude Code with Non-Anthropic Models](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)）。

1. LiteLLM の `config.yaml` の `model_list` に、alteroid から呼ぶ名前（`model_name`）と、その先のモデルを並べます。手順は LiteLLM のページに従ってください。
2. 接続先と資格を置きます。

   ```sh
   echo -n "http://<LiteLLM の所在>:4000" | docker compose exec -T app alteroid credential set ANTHROPIC_BASE_URL --scope all --no-secret --yes
   echo -n "<LiteLLM の virtual key>"     | docker compose exec -T app alteroid credential set ANTHROPIC_AUTH_TOKEN --scope all --yes
   ```

3. モデル名の対応付けは Ollama の手順 4 と同じです。LiteLLM の `model_name` を `opus` / `sonnet` / `haiku` の別名に合わせておけば、(b) の対応付けも要りません。ただし、どの層が実際に何で走っているかが表に出ない点は (b) と同じです。

gateway の先を Anthropic の Claude にする場合は、公式の手順の範囲です（[Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)）。

## Bedrock / Vertex / Foundry

これらは公式の経路です。各ページの環境変数（`CLAUDE_CODE_USE_BEDROCK=1` と AWS の資格、など）を、上の表のとおり袋に置いてください。

- [Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock)
- [Google Cloud's Agent Platform](https://code.claude.com/docs/en/google-vertex-ai)
- [Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry)
- [Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws)

これらの経路では、別名 `opus` / `sonnet` の行き先が Anthropic API と違うことがあります（[Model configuration](https://code.claude.com/docs/en/model-config) の表）。版を固定したいときは `ANTHROPIC_DEFAULT_*_MODEL` を置いてください。

画像の添付は、Bedrock / Vertex の経路では base64 の上限に合わせて小さく扱われます（`packages/core/src/attachment.ts` の `isBase64CappedImageRoute`）。

## 制約と注意（調べて分かったもの）

- **⚠️ 資格を置かずに接続先だけ変えないでください。** Claude Code が資格を選ぶ順番は、クラウドの資格 → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` です（[Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)）。alteroid はプールのトークンを `CLAUDE_CODE_OAUTH_TOKEN` として子に渡します（`packages/core/src/credentials.ts`）。そのため `ANTHROPIC_BASE_URL` だけを置くと、**Claude のサブスクリプションのトークンが、その接続先（gateway やローカルのサーバ）へ送られます。** 公式も「資格の変数を置かずに base URL だけを変えても、サブスクリプションのログインが使われ続ける」と書いています（[Subscriptions and gateways](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)）。
- **認証トークンのプールと回し手は、この経路では効きません。** `ANTHROPIC_AUTH_TOKEN` や `ANTHROPIC_API_KEY` が在ると、Claude Code はプールのトークン（`CLAUDE_CODE_OAUTH_TOKEN`）を使いません。回し手が動く契機は、Claude Code が出す枠の通知（`usage_notice` / `rate_limit`）です（`packages/core/src/dropped-record.ts` の `noteUnclassifiedFailure` の doc）。gateway の先の上限に当たっても、別のトークンへは回りません。
- **プールが空でも走るか。** README は「1本も登録していないと、クローンもマネージャーも走れません」と書いています。これは Anthropic の経路の話です。プールが空のときに走行を止める関門は、コードを grep した範囲では見つかりませんでした。gateway の資格だけで走るはずですが、**実機では確認していません。**
- **利用状況（枠）の表示は、Claude のサブスクリプション向けです。** 枠は Claude Code の `rate_limit_event` と usage の問い合わせで取っています（`packages/core/src/usage-probe.ts`）。gateway の先では意味のある値が出ません。費用の数字は Claude Code が報告するもので、gateway の先の実際の請求とは一致しません。Claude 以外のモデルでどう出るかは**確認していません**。
- **文脈の大きさ。** alteroid のシステムプロンプトと道具の定義は大きいので、文脈の小さいモデルではすぐに溢れます。gateway が自分の言葉で文脈超過を返すと、Claude Code は自動で圧縮しません。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` は 100,000 トークン未満に下げられません（[Troubleshoot gateway errors](https://code.claude.com/docs/en/llm-gateway-connect#troubleshoot-gateway-errors)）。
- **リクエストの未知の欄で 400 が返るとき。** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` を同じ置き場に足してください（同じ表）。
- **プロファイルに鍵を書かないでください。** `GET /profile` は本文ごと返します。袋は指紋しか返しません（[.claude/skills/env-profile/SKILL.md](../../.claude/skills/env-profile/SKILL.md)）。
- **クローンも自分で接続先を変えられます。** プロファイルはクローンも道具（`profile_write`）で書けるので、`ANTHROPIC_*` もクローンが書き換えられます。これがモデル帯の承認を迂回する件は [#4261](https://github.com/takecchi/alteroid/issues/4261) で扱っています。
