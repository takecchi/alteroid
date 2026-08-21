# 提案 — 複数のコーディングエージェント（provider）に対応する

> **⚠️ この文書は正典ではない。** `docs/north_star.md` / `docs/PRD.md` / `docs/architecture.md` /
> `docs/roadmap.md` の4本だけが正典であり、この文書は**人間の承認を待っている提案**である。
> ここに書かれた設計は1行も実装されていない。矛盾したら正典が勝つ。
>
> 承認されたら、この文書の §7 にある文言を正典側へ移し、この文書は消す。
> 却下されたら、この文書ごと消す（提案が中途半端に残ると、次に読む者が正典と誤読する）。

観測時刻: 2026-08-20T16:11Z〜16:30Z（この文書の事実はすべてこの時刻の観測）
対象コミット: alteroid `1f8cbb2` / codiva `11cee35`（tag v0.5.1）

---

## 0. 何を決めたいのか

「Claude Code 以外のコーディングエージェント（codex / grok …）をクローン・マネージャー・作業者の
各層で使えるようにしたい」という依頼に対して、**正典を壊さずに成立する形**を1つ提示し、
人間の承認を得る。

依頼者から確認済みの前提（2026-08-20 の対話で確認。この文書の設計はこの4点に依存する）:

| 論点 | 決まったこと |
| --- | --- |
| 動機 | ①得意分野で使い分け ②Claude の枠に当たった時の継続 ③コスト ④ベンダーロックイン回避（4つ全部） |
| 対象の層 | **クローン層も含めて全部** |
| 正典の扱い | **基準は Claude Code のまま。provider は「方針」として足す**（north_star:3 の定義文は書き換えない） |
| 進め方 | 実装前に相談。この文書がその相談である |

---

## 1. 出発点の事実（実測）

### 1-A. この方向の議論・実装は過去に一度も無い

```
$ gh issue list --state all --limit 1000 --search codex|grok|gemini|OpenAI|LLM|マルチ
$ gh pr    list --state all --limit 1000 --search 同上
（該当なし。"provider" のヒットは #71 / #27 で、どちらも packages/core/src/auth-providers.ts
  ＝人間のログイン手段の話。エージェントの provider ではない）

$ git log -S'codex' -S'grok' -S'gemini' -S'openai' --all -i --format='%h %cI %s'
（4語すべて 0 件）
```

`docs/roadmap.md` の未完項目は6件で全部 M5（sticky routing / fencing / 移送 / workspace locator /
複数 Service デプロイ / 等価性回帰テスト）。**M0〜M6 に他 provider の項目は1つも無い。**

### 1-B. alteroid の要件を担っている実体は、SDK の機能そのものである

`docs/architecture.md:53-54` が明言している:

```
53: **マネージャーと作業者は実装物ではない。** どちらも実体は Claude Code そのものであり、
    alteroid が書くのは配線（起こす・話しかける・クローンへ回す・日誌に落とす）だけである
54:  - **作業者層の本体は `agents` 定義1個**（`model: 'sonnet'`、`tools` 省略）
```

コードで裏を取ると、正典の要件と SDK 機能が1対1で対応している:

| 正典の要件 | 実現している SDK 機能 | 実装箇所 |
| --- | --- | --- |
| 作業者層（PRD「層ごとの能力」の3層） | `agents: { worker: { model: 'sonnet' } }` | `packages/core/src/runner.ts:756-766` |
| 権限境界（PRD「権限境界」） | `canUseTool` + `AskUserQuestion` | `runner.ts:780`, `runner.ts:1265` |
| 可観測性・監査（PRD「可観測性」） | `PostToolUse` フック | `runner.ts:782`, `clone.ts:2082-2086` |
| クローンの記憶への蒸留（寿命モデル） | `PreCompact` フック | `clone.ts:2062-2066` |
| デーモン再起動後の引き取り（M4 受け入れ基準） | `SessionStore` + `Options.resume` | `runner.ts:773-774`, `795-815` |
| 人間の MCP 連携（PRD「業務範囲」） | `settingSources: ['user','project','local']` | `clone.ts:2051`, `runner.ts:769` |
| クローンの自作道具25個 | インプロセス MCP（`createSdkMcpServer` / `tool`） | `packages/core/src/tools.ts:1631-1641` |
| 制御面の保護3枚目（別 UID） | `spawnClaudeCodeProcess` | `runner.ts:777-779`, `817-826` |
| 台帳（消費の観測） | `result.modelUsage` / `rate_limit_event` / usage limit の文言定数 | `usage.ts:498-499`, `runner.ts:1017`, `usage-limits.ts:73-76` |

**この表が、この提案の全体の難しさである。** codiva では provider が機能を持たないことは
「UI が縮退する」で済むが、alteroid では**同じ欠落が受け入れ基準を割る**。

### 1-C. 既にある DI の口は、provider 境界としては使えない

`queryFn?: typeof query` が3箇所にある（`clone.ts:227` / `runner.ts:192` / `runner-local.ts:37`。
`runner.ts:498` の `RunnerSessionOptions.queryFn` は必須）。これを provider の差し替え口に
流用したくなるが、**codiva が同じ地点で明示的に却下している**（codiva `docs/ARCHITECTURE.md:156-160`）:

```
- 逆に SDK の `query()` の署名（`AsyncIterable<SDKUserMessage>` + `Options` + `canUseTool` +
  control request）を共通 IF にすると、**全 provider に Claude の制御モデルの模倣を強いる**。
  Codex / Grok が control request を持つ保証はない。
```

**この提案は codiva の結論を採る。** `queryFn` はテスト用の差し替え口として残し、
provider 境界は別に作る。

### 1-D. codiva には既に完成した provider 抽象がある（そのまま参考にできる）

codiva v0.5.1 は `claude` / `codex` / `grok` の3実装を持っている。中心は
`src/core/agent-ports.ts` の `AgentAdapter`（抽象の線は**1ターンぶんのストリーム**）。
アダプタの責務は3つだけ:

1. ストリームを開く（`open`）
2. provider のメッセージを `AgentEvent[]` へ写す
3. 失敗文言を `AgentStopCause`（`auth` / `rate_limit` / `connection` / `failed`）へ分類する

状態の畳み込みは全 provider 共通の `applyAgentEvent` 1本。そして**持たない機能を型で申告する**:

```ts
// codiva src/core/claude-adapter.ts:37   permissions:true  interrupt:true setModel:true resume:true modelCatalog:true usage:true  cost:true  transcript:true
// codiva src/core/codex-adapter.ts:87    permissions:false interrupt:true setModel:true resume:true modelCatalog:true usage:false cost:false transcript:false
// codiva src/core/grok-adapter.ts:78     permissions:true  interrupt:true setModel:true resume:true modelCatalog:true usage:false cost:false transcript:false
```

**そのまま持ち込める資産**:

- codiva `.claude/rules/sdk-integration.md`（279行）— 「他 provider のアダプタを足すときの規約」が
  実測込みで書かれている。とくに「1ターン=1プロセス」（codex）と「1セッション=1プロセス+双方向RPC」
  （grok）を**どちらもアダプタの形として認める**、エージェント側から来た要求には必ず答える
  （放置するとターンが永久に終わらない）、`grok` の `session/cancel` は通知で `id` を付けると
  `-32601`（実測）、`codex exec` の指示文の前に `--` を必ず置く（`-` 始まりの入力で clap が落ちる）
- 新 provider の追加が3ステップに閉じている形（`AgentId` に値追加 → `<x>-adapter/parse/errors.ts`
  → 合成ルートに1エントリ）

**持ち込めないもの**: codiva は人間が TUI の前に居て `/agent` で選ぶ前提なので、
capability が false のときは**黙って UI から消す**。alteroid は無人で回るので、
消えたことに気づく人間が居ない（§3-C で扱う）。

### 1-E. codex / grok が持たないもの（codiva の実測に基づく）

| | 許可要求を上げる | 中断 | resume | モデル一覧 | 使用状況 | コスト | ログ復元 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| codex | **×** | ○ | ○ | ○ | **×** | **×** | **×** |
| grok | ○ | ○ | ○ | ○ | **×** | **×** | **×** |

codex が `permissions: false` である理由（codiva `.claude/rules/sdk-integration.md:107-113`）:

```
`codex exec` の JSON モードは承認要求を CLI 内部で自動 reject してストリームに何も出さないので、
codiva が UI へ上げる経路が原理的に無い。ここで「それらしい許可ダイアログ」を出すと、
ユーザーが許可したのに実際は拒否されているという嘘になる。
```

**判定（確認ではない）**: この表の `permissions` 列と §1-B の「権限境界」行を重ねると、
**codex をマネージャー層に置くと PRD「権限境界」の経路が消える**。
`usage` / `cost` 列と「台帳」行を重ねると、**codex / grok では消費が観測できない**。

---

## 2. 正典との整合 — なぜこれはデグレードではないのか

依頼者の判断（「基準は Claude Code のまま、provider は方針として足す」）を前提にすると、
2つの禁止（north_star:29-30）との関係はこう整理できる。

### 2-A. むしろ現状がデグレードである、という読み

north_star:38 はこう言っている:

```
38: クローン自身は Claude Code ではなく**人間**の写像である。そして**人間は道具を持たない存在ではない**
    — PC の前に座った人間は、Claude Code に頼むだけでなく、自分でも端末を叩き、ファイルを開き、
    ブラウザで確認する。
```

**人間は Claude Code だけを使っているわけではない。** 手元に codex を入れて使い分けている人間の
写像であるクローンが、Claude Code しか選べないなら、それは能力の削除の側に近い。
この読みだと、この提案は「機能追加」ではなく**デグレードの修正**になる。

**ただしこれは強く主張しない。** 「人間が Claude Code に対してできること」（PRD:31）が等価性の
基準として明文化されている以上、「人間が codex に対してできること」は基準に含まれていない。
だからこれは**提案の理由づけとしては使えるが、正典の解釈としては人間が決めること**である。

### 2-B. 「既定を動かさない」ことが禁止の側を守る

- `docs/PRD.md:61`「**役割とモデル帯の対応は固定である**（Fable = クローン、Opus = マネージャー、
  Sonnet = 作業者）。変更には人間の承認が要る」
- north_star:54「階層を潰す・安いモデルへ寄せる『最適化』をしていないか？」
- north_star:30「制限が必要なら…**方針**…で表す。**方針は設定で開けられなければならない**」

この3つを同時に満たす形は1つしかない:

> **既定は Claude Code（Fable / Opus / Sonnet）のまま1文字も動かさない。他 provider は
> 人間が明示的に選んだときだけ入る。alteroid 自身がコストや枠を理由に勝手に寄せることはしない。**

**とくに「Claude の枠に当たった時の継続」を自動フォールバックとして実装してはいけない。**
それは alteroid が自分の判断で層のモデル帯を差し替えることであり、PRD:61 の「人間の承認が要る」を
実装で迂回することになる。**枠に当たったことをクローンへ知らせ、クローンが記憶に根拠を持って
判断する**形なら権限境界（PRD:90）の枠内に収まる — 判断の主体が人間の写像であるクローンだからである。
この線引きは §7 で正典へ足す文言に含める。

### 2-C. 「エージェント実行基盤は自作しない」は破らない

`docs/PRD.md:21`「エージェント実行基盤は自作せず Claude Agent SDK をラップする」。

**これは「provider ごとの harness をラップする」に一般化できる**（自作していないことは変わらない）。
ただし**素のモデル API を足すのは別問題である**:

- `codex` / `grok` / `gemini` CLI = **エージェント harness**。ラップの対象になる
- `grok-3` / `gpt-5` のような**素のモデル API** = ラップする harness が無い。
  agent loop を自作することになり、PRD:21 の違反になる

依頼文の「codex, grok...」はこの2種類が混ざりうる語である。**この提案が対象にするのは前者だけ**。
grok については、xAI が `grok agent`（ACP = stdio 上の JSON-RPC）という harness を出しており、
codiva がそれを実装済みなので前者に入る（codiva `src/utils/grok.ts:49-68`）。

---

## 3. 設計案

### 3-A. 境界は2つ要る（1つではない）

codiva は境界が1つで足りている（`AgentAdapter`）。alteroid は層の性質が違うので2つに割れる。

```
                       ┌─────────────────────────────────────────┐
  クローン層           │ AgentAdapter + ToolHost（道具の外出し）  │  ← 境界②
  （Fable / 人間の写像）└─────────────────────────────────────────┘
                                     │ 委譲（エスカレーション・プロトコル。provider 非依存）
                       ┌─────────────────────────────────────────┐
  マネージャー＋作業者 │ AgentAdapter                            │  ← 境界①
  （Opus / Sonnet）     └─────────────────────────────────────────┘
```

**境界①（マネージャー・作業者）** は codiva の `AgentAdapter` がほぼそのまま使える。
`packages/core/src/runner.ts`（1617行）を `claude-adapter` に切り出し、
`RunnerSession` は provider 非依存の `AgentEvent` だけを見る形にする。

**境界②（クローン）** は別物である。クローンは「コーディングエージェントのセッション」ではなく、
**25個の自作道具（記憶・受信箱・スケジューラ・プロファイル・委譲）を持つ長寿命ホスト**であり、
その道具はインプロセス MCP（`createSdkMcpServer`、`tools.ts:1631`）で生えている。
インプロセス MCP は Claude Agent SDK の機能なので、他 provider では成立しない。

→ **道具を stdio MCP サーバとして外へ出す必要がある。** これは境界①より重い工事だが、
副作用として good なことが1つある: **道具が provider から独立し、`GET /openapi.json` と同じ
「1つの実装を全経路が通る」形になる**。

### 3-B. `AgentCapabilities` は alteroid では2種類に分かれる

codiva の capability は全部「あると嬉しい」ものだが、alteroid では**要件を担っているもの**と
**そうでないもの**が混ざる。ここを区別しないと、選べる provider の一覧が
「要件を割る選択肢」を並べた表になる。

| capability | alteroid で担っている要件 | 欠けたときに起きること |
| --- | --- | --- |
| `permissions` | PRD「権限境界」 | **人間の最終承認の経路が消える**（north_star:25） |
| `toolAudit`（＝ `PostToolUse` 相当） | PRD「可観測性」 | **聞かずに実行した判断が日誌に残らない**（PRD:100） |
| `resume` + `sessionStore` | M4 受け入れ基準（引き取り） | デーモン再起動で走行中の仕事が復元できない |
| `subagents` | PRD「層ごとの能力」の3層 | **作業者層が存在しなくなる** |
| `mcpServers` | PRD「業務範囲」 | 人間の MCP 連携がその層から見えない |
| `usage` / `cost` | 台帳（可観測性） | 消費が観測できない（§3-D） |
| `compactionHook`（＝ `PreCompact` 相当） | クローンの寿命モデル | 記憶への蒸留が起きない（クローン層のみ） |
| `interrupt` / `setModel` / `modelCatalog` / `transcript` | （要件ではない） | 操作が減るだけ |

**提案**: 上の表の上7行を **`requirementBearing`（要件を担う）** として型で区別し、
それを欠く provider は

1. **既定にできない**（型ではなく、選択の経路で弾く）
2. 選ばれたときに**何が失われるかを人間へ出す**（黙って縮退しない）

の2つを強制する。**codiva の「黙って UI から消す」は採らない** — codiva には見ている人間が居るが、
alteroid には居ないからである。

### 3-C. 「黙って縮退しない」の具体形

`AGENTS.md`「範囲外でも気づいたことは上げる」「取れない軸に 0 の行を作らない。値そのものを
作らず、取れない理由を出力に書く」に従う。

- **`alteroid provider status`（仮）と `GET /providers`** に、各 provider の capability と
  「この層に置いた場合に失われる要件」を出す
- 層に非既定の provider が置かれている間、**日報（`daily_report`）に必ず1節載る** —
  「マネージャー層は codex で走っている。権限境界の確認は上がらない。消費は取れない」
- **クローンの自己認識（`self.ts`）に載せる** — いま既に `claudeCodeVersion` / `apiKeySource` を
  載せているのと同じ場所（`self.ts:131,138,204,205`）。クローンが自分の道具の欠落を知らないまま
  判断すると、権限境界の判断自体が壊れる

### 3-D. 台帳に「取れない」を持たせる

`packages/core/src/usage.ts:475-505` のコメントが既にこの危険を書いている:

```
 * 層ごとに写し取りを書くと、どちらかが SDK の綴り（`costUSD` の大文字）を
 * 取り違えたときに片方だけ 0 が積まれ、その差は「その層は安い」と読める。
```

codex / grok は `cost` / `usage` を報告しない（§1-E）。**そのまま繋ぐと 0 が積まれ、
「その provider は安い」と読める行が台帳に生える。** これは依頼者の動機③（コストを下げたい）を
検証不能にするだけでなく、積極的に誤らせる。

**提案**: 台帳の行に「消費が取れない provider で走った」ことを表す状態を足し、集計では
**0 として足さず、取れなかった区間として別に出す**。`layer` / `site` の軸は provider とは
別軸なので触らない（`AGENTS.md` 地雷「消費の層をモデル名で見分ける」と同じ理由）。

### 3-E. `spawnClaudeCodeProcess` の代替（制御面の保護3枚目）

`runner.ts:777-779` は SDK の `spawnClaudeCodeProcess` フックで子プロセスを別 UID へ降ろしている
（`docs/architecture.md:135`。マネージャーが自分の許可確認に自分で答えられないようにする3枚目）。

**判定（確認ではない）**: CLI を spawn する provider（codex / grok）では、**むしろ簡単になる**。
alteroid 側が自分で `spawn` するので、`uid` を指定するだけで済む（SDK のフックに依存しない）。
逆に言うと、**この保護は provider ごとにアダプタが実装する責務になる**ので、
`AgentAdapter` の契約に「別 UID で起こせること」を入れる必要がある。ここを optional にすると、
保護が1枚静かに落ちた provider が選べるようになる。

### 3-F. 触るファイルの見積り（判定であって確認ではない）

| ファイル | 行数 | 何をするか |
| --- | --- | --- |
| `packages/core/src/runner.ts` | 1617 | `claude-adapter` へ切り出し。`AgentEvent` の語彙を導入 |
| `packages/core/src/clone.ts` | 3004 | 同上（境界②）。道具の外出しの影響がここに集まる |
| `packages/core/src/tools.ts` | 1642 | インプロセス MCP → stdio MCP サーバへの二重提供 |
| `packages/core/src/usage.ts` | — | 「取れない」状態の追加 |
| `packages/core/src/usage-limits.ts` | 201 | provider ごとの文言分類（アダプタへ移す） |
| `packages/core/src/store.ts` | — | `Stores.sessionStore?: SessionStore` の SDK 型露出を自前型へ |
| `packages/core/src/runner-protocol.ts` | — | `mirror` イベントの zod に SDK の SessionStore key 形状が焼き付いている |
| `packages/storage-pg/src/session-store.ts` | — | `implements SessionStore` を自前型へ |

**この規模を1つの PR でやらないこと。** §5 の段階分けを提案する。

---

## 4. 却下した案（と却下の理由）

| 案 | 却下の理由 |
| --- | --- |
| 既にある `queryFn` を provider 境界に流用する | codiva が同じ地点で却下している（§1-C）。全 provider に Claude の制御モデルの模倣を強いる |
| capability が欠けたら codiva と同じく黙って縮退する | 見ている人間が居ない。「聞かずに実行した判断は必ず日誌に残る」（PRD:100）が静かに死ぬ |
| 枠に当たったら自動で別 provider へフォールバックする | alteroid 自身が層のモデル帯を差し替えることになる（PRD:61 の迂回）。§2-B |
| 素のモデル API（OpenAI 互換エンドポイント）を足す | agent loop の自作になり PRD:21 に反する。§2-C |
| provider ごとに CLI を同梱する | codiva が却下している（使わない人にプラットフォーム別バイナリを配る）。`git` / `gh` と同じく PATH のものを起こす |
| north_star:3 の定義文から Claude Code を外す | 依頼者が「基準は Claude Code のまま」を選択済み |

---

## 4-B. 実装の進捗（この PR で入ったもの）

依頼者の承認（2026-08-21）を受けて、**P1 の一部**を実装した。**provider は Claude だけのままで、
挙動は1文字も変えていない。**

| 入ったもの | 中身 |
| --- | --- |
| `packages/core/src/agent-session-options.test.ts` | 特性試験。SDK へ渡す `Options` を固定する。**「無いこと」の固定が本題**（`tools` / `maxTurns` を渡さない、クローンには `canUseTool` を繋がない） |
| `packages/core/src/agent-ports.ts` | provider 非依存の語彙。`AgentCapabilities` の10個が「どの要件を担っているか」を JSDoc に持つ。SDK を import しない（番人テストで固定） |
| `packages/core/src/claude-provider.ts` | `Options` を組み立てるのはここだけ。3か所（クローン本体・蒸留・マネージャー）から移した |

**入っていないもの**（次の単位。§5 の P1 の残り以降）:

- **読み側の中立化**（provider のメッセージ → `AgentEvent` → 共通の畳み込み）。`clone.ts` /
  `runner.ts` はいまも `SDKMessage` を直接ディスパッチしている。ここを分けないと2つ目の
  provider は載らない
- **`AgentAdapter.open()`**。中立の `AgentRunRequest` を作るには、クローンの道具（インプロセス
  MCP）の外出しが要る（P5）。いま無理に中立の顔を被せると、SDK 型が `agent-ports.ts` へ
  漏れて番人テストが落ちるか、`queryFn` と同じものを別名で作るだけになる
- **§3-B の「要件を担う capability を欠く provider を既定にできない」の強制**。語彙
  （`missingRequirementCapabilities`）は入ったが、選択の経路がまだ無い（provider が1つなので
  選択そのものが無い）
- **§3-D の台帳の「取れない」状態**。provider が1つで、その provider は消費を報告するので、
  いま入れても検証できる状態が作れない

### 正典（`docs/`）に §7 の文言を入れなかった理由

依頼者は「基準は Claude Code のまま、provider は方針として足す」を選び、実装の承認も出した。
それでも §7 の文言を正典へ移すのは**次の provider が載ってからにした**。

理由は1つ。いま「provider は差し替えられる」と PRD に書くと、**docs が要求していることを
コードが満たしていない状態**になる。`AGENTS.md` は「これらの文書とコードが矛盾したら、バグなのは
コードである」と定めているので、それは自分で自分にバグを1件作る操作である。**語彙だけが先に
入っている状態は、要件ではなく準備として正しく読める。**

## 5. 段階分け（提案）

**依頼者が「全部の層」を選んでいるので、最終形は境界①②の両方である。** ただし順序には
成り立っている依存がある（手順ではなく事実であり、事実が変われば書き換える）。

- **P0（実装ゼロ・今日から使える）** — マネージャーが `Bash` で `codex exec` / `grok` を叩く。
  人間が Claude Code の中から codex を呼ぶのと同じことで、**既に可能である**（`tools` を絞って
  いないので道具は在る）。層としての provider にはならず、日誌には `Bash` の `tool_use` として
  載る。**要件の欠落は1つも起きない。**
  → 動機①（使い分け）の相当部分がここで満たされる可能性がある。**先にこれを実測すべきである**
  （提案者は未実測。根拠は `tools` を渡していないという静的な事実だけ）
- **P1** — `AgentEvent` の語彙と `applyAgentEvent` 相当を導入し、**Claude だけを**アダプタへ
  切り出す。この時点で provider は1つしか無く、**外から見た挙動は1バイトも変わらない**
  （`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」の逆で、
  「出力・挙動を1文字も変えていないことを示す」条件つきの構造変更）
- **P2** — 台帳の「取れない」状態、`GET /providers`、日報の節、`self` への反映。
  **provider を足す前に、足したときに人間が気づける形を先に作る**
- **P3** — 2つ目の provider（マネージャー層）。codex は `permissions: false` なので、
  **grok を先にする方が要件の欠落が少ない**（`permissions: true`）
- **P4** — 作業者層の provider 化。`agents` 定義に相当する機構を持たない provider では
  「マネージャー1体＝provider の1セッション」に潰れる。ここは**層が消える**ので、
  代わりに何を置くかを設計してから着手する
- **P5** — 境界②（クローン層）。道具の stdio MCP 外出しが本体

**依存**:

- **P2 は P3 より先でなければならない。** 逆順だと、要件が欠けた provider が入った状態を
  誰も観測できない期間が生まれる
- **P4 は P3 の後でしかできない。** 作業者は「マネージャーが切り出したもの」なので、
  マネージャー側の provider が決まらないと切り出し方が決まらない
- **P5 は P1 と独立している。** クローンの道具の外出しは、マネージャー側のアダプタ化を待たない
- **P1 は単独で価値がある。** provider が1つのままでも、`runner.ts` の1617行から
  「SDK の形の知識」が分離されるのは可読性の改善である

---

## 6. 未決事項（人間に決めてほしいこと）

1. **P0 の実測をしてから P1 に進むか。** マネージャーが `Bash` で `codex exec` を叩ければ
   動機①がどこまで満たされるかは、**実際に試すまで分からない**。提案者はこれを未実測である
2. **「作業者層が消える provider」を許すか。** `agents` 相当を持たない provider をマネージャーに
   置くと3層が2層になる。PRD「層ごとの能力」の3層は固定の設計判断（PRD:61）なので、
   ここは人間の承認が要る
3. **`permissions: false` の provider を選べるようにするか。** 選べる形にすると、
   「権限境界が無い状態」を人間が選べることになる。選べない形にすると codex がマネージャー層に
   入らない（作業者層なら入りうる）
4. **台帳で消費が取れない provider を、コスト削減の根拠として使えないことを受け入れるか。**
   動機③（コスト）は、その provider では**測れない**（§3-D）
5. **`docs/roadmap.md` に M7 として足すか、M5 の後に割り込ませるか。** M5 は未完（fencing / 移送 /
   デプロイ定義 / 等価性回帰テスト）で、**等価性の回帰テスト（M5 PR7）は provider が増えると
   意味が変わる**（何と何の等価性を測るのか）。順序に依存がある可能性がある

---

## 7. 承認されたら正典へ足す文言（案）

**この節の文言は提案である。** 承認されるまで `docs/` の4本には1文字も入れない。

### 7-A. `docs/PRD.md`「層ごとの能力」の末尾へ足す案

```markdown
### provider — 層を動かすエージェントは差し替えられる（方針であって既定ではない）

各層を動かすコーディングエージェント（provider）は差し替えられる。人間が自分の PC で
Claude Code と他のエージェントを使い分けているのと同じ自由であり、選べないことは能力の
削除の側にある。

ただし**既定は動かさない** — クローン = Fable / マネージャー = Opus / 作業者 = Sonnet の
Claude Code が既定であり、等価性の基準もそこに置いたままである（上記「層ごとの能力」）。
他 provider は**人間が明示的に選んだときだけ**入る。これは禁止2の言う方針であって、
設定で開けられなければならないもののひとつである。

- **alteroid 自身が provider を選び直さない。** コストや枠（usage limit）を理由に
  自動で別 provider へ寄せることは、層とモデル帯の対応を実装が勝手に変えることであり、
  「変更には人間の承認が要る」を迂回する。枠に当たった事実はクローンへ知らせ、
  どうするかはクローンが記憶に根拠を持って判断する（「権限境界」）
- **provider が持たない能力を、持っているように見せない。** 許可確認を上げられない
  provider に「それらしい確認」を出すと、人間が承認したのに実際は拒否されているという嘘になる。
  持たないことは持たないと出す
- **要件を担う能力を欠く provider は、既定にできない。** 権限境界（許可確認）・
  可観測性（全ツール実行の記録）・引き取り（session の再開）・3層（サブエージェント）・
  業務範囲（MCP 連携）は要件であって好みではない。欠けたまま走らせることを人間が選ぶのは
  方針だが、**何が失われているかは日報とクローンの自己認識に必ず出る**
- **取れない消費を 0 として積まない。** コストや使用状況を報告しない provider の区間は、
  台帳で「取れなかった」として出す。0 を積むとその層が安いと読める
```

### 7-B. `docs/architecture.md`「全体像」の注記へ足す案

```markdown
- **マネージャーと作業者の実体は Claude Code そのもの**という記述は、既定の構成についてのもの
  である。provider を差し替えた場合、その層の実体はその provider の harness になり、
  alteroid が書く配線（起こす・話しかける・クローンへ回す・日誌に落とす）は変わらない。
  配線が変わらないのは、境界を `AgentAdapter`（1ターンぶんのストリーム）に引いてあるからである。
  **SDK の `query()` の署名を共通 IF にしないこと** — 全 provider に Claude の制御モデルの
  模倣を強いることになる
```

### 7-C. `AGENTS.md` の地雷表へ足す案

```markdown
| provider の境界を `queryFn`（＝ SDK の `query()` 署名）で作る | 全 provider に Claude の制御モデルの模倣を強いる | 境界は `AgentAdapter`（1ターンぶんのストリーム）に引く。`queryFn` はテスト用の口として残す |
| 能力を持たない provider で「それらしい確認ダイアログ」を出す | 人間が承認したのに実際は拒否される（嘘の観測） | capability を false と申告し、出さない。安全弁は provider 側の仕組みへ寄せる |
| 枠に当たったら自動で別 provider へ切り替える | 層とモデル帯の対応を実装が勝手に変える（PRD の「人間の承認が要る」の迂回） | 枠に当たった事実をクローンへ知らせ、判断はクローンがする |
| 消費を報告しない provider の区間に 0 の行を積む | 「その層は安い」と読める（観測の欠落） | 「取れなかった」として出す |
```

---

## 8. この文書の限界（確認していないこと）

- **提案者は他 provider を1度も動かしていない。** §1-E の表は codiva のコードとその
  コメントに書かれた実測を写したものであり、提案者自身の観測ではない
- **外部の一次情報（公式 docs / npm / GitHub）に当たれていない。** そのための調査を1本
  走らせたが、組織の月間支出上限（`You've hit your org's monthly spend limit`）で途中で落ちた。
  したがって次は**確認していない**: ① `codex` に公式の programmatic SDK / TypeScript SDK が
  あるか（あれば §1-E の `permissions: false` が変わりうる。codiva が使っているのは
  `codex exec --json` であり、それ以外の口の有無は未確認） ② Claude Agent SDK 自身で
  非 Anthropic モデルへ向ける公式経路があるか（Bedrock / Vertex 以外） ③ 他 provider の
  harness（gemini CLI 等）の programmatic 対応 ④ 「複数のエージェント CLI を1つの抽象で
  束ねている」OSS の他の実例。**④が取れていないので、この提案の抽象の形は codiva 1件だけを
  参考にしている**（他の設計と比べていない）
- **P0（マネージャーが `Bash` で `codex exec` を叩く）を試していない。** 根拠は
  「`tools` を渡していないので Bash は在る」という静的な事実だけである
- **`pnpm build` / `typecheck` / `test` を1度も走らせていない**（実装が無いので走らせる対象が無い）
- **§3-F の行数見積りと「触るファイル」は提案者の判定であって、依存の全走査ではない。**
  `packages/core/src/store.ts:423` の `Stores.sessionStore?: SessionStore` により
  `@alteroid/core` の公開型に SDK 型が露出しているので、`apps/web` まで型の上では到達しうる。
  実際に到達しているかは確認していない
- **§1-B の表の「1対1で対応している」は提案者の判定である。** 材料は各行の実コードと
  同じファイル内のコメントの主張だけで、SDK の `.d.ts` は読んでいない
