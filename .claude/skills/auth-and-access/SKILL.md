---
name: auth-and-access
description: ログイン・アクセス許可（alteroid login / access grant、Google OAuth、認証トークン）を触るときに読む。通る資格3種類（3つ目は外のサービスに渡す連携の鍵）、既定で認証を要求しない理由、許可は複数出せるが分けないのはデータの側、不変条件をストアの1操作に閉じる3つの関数、鍵を落とす2か所。PRD「権限境界」との違いも。
---

# ログインとアクセス許可（入口の認証）

<!-- AGENTS.md から移設。移設の時点では本文を1文字も変えていない（その後の更新は本文中に日付付きで残してある）。パスはリポジトリの根からの相対である。 -->

**PRD「権限境界」と混同しないこと。** あちらは「クローンが何を人間へ確認するか」を*記憶*で決める話で、行為の一覧を持ってはいけない。ここは「そもそも誰が HTTP API に触れるか」の話であり、north_star 禁止2 が制限の表現方法として**認めている実行環境の境界**（認証情報の配布範囲）そのものである。持っているのは**許可されているか否かの2値だけ**で、クローン・マネージャー・作業者の道具は1つも減らない。

- マルチユーザーではない（PRD 非ゴール）。**持ち主が複数の端末・複数のログイン手段から入れるようにするための層**であって、利用者ごとにデータを分けない
  - **⚠️ 非ゴールが禁じているのは「データを分けること」であって「入口の数」ではない。** 許可は複数のアカウントへ出せる（下の項目）。**境界はデータの側に在る** — 「アカウントごとの記憶」「アカウントごとの日誌」を作りたくなったら、そこが越えてはいけない線である（逐語は `grep -Fn -- '境界はデータの側に在る' docs/PRD.md`）
- **通る資格は3種類**（③連携の鍵 `altk_` は外のサービスに渡すもので、この下の連携の鍵の項）。①`Authorization: Bearer <アクセストークン>`（`alteroid login` で発行。許可されたアカウントのものだけ通る）②`Authorization: Bearer <state/daemon.json の token>`（＝**実行環境の持ち主**。CLI が使う）。**`/access/*` と `/tokens` は①②のどちらでも叩ける**（2026-09-06 のオーナー決定で同格にした）。**②でなければ叩けない経路の一覧を持つのは歯である** —— 数え上げの持ち主は `scripts/require-operator-routes.test.ts` の `EXPECTED_OPERATOR_ROUTES` で、配線と一覧の一致を測っている（逐語は `grep -Fn -- 'const EXPECTED_OPERATOR_ROUTES' scripts/require-operator-routes.test.ts`）
  - ②が「最初の1人を誰が通すか」の出口である。守っているのは**ファイルの許可**であって新しい秘密ではない。これが無いと誰も `access grant` を実行できない
- **第3の資格として「連携の鍵（integration key）」がある**（`altk_` ＋ 32 バイトの乱数。#3113 段1。発行・一覧・失効は `POST /integration-keys`・`GET /integration-keys`・`POST /integration-keys/:id/revoke`。コアは `packages/core/src/integration-key.ts`、門番は `apps/daemon/src/app.ts` の `authenticateIntegrationKey`）。外のサービス（人間でない相手）へ渡す鍵で、**種類そのものが「固定の1つの `source` で外部イベントを送る」という1つの能力だけを表す**。
  - **これは行為ごとのスコープではない。「人間でない相手に渡す認証情報の配布範囲」の境界である**（north_star 禁止2 が認める実行環境の境界）。**`scopes: [...]` のような選べる一覧を足さないこと** —— 足した瞬間に、上の「行為ごとのスコープを足さないこと」と地雷表の `permissions.yaml` に当たる。足したくなったら、鍵の種類を増やすのではなく、まず別の資格が要るのかを人間に確認する
  - **既定で拒否する。** 通すのは `POST /events`（本文の `source` が鍵の `source` と一致するときだけ）と `POST /events/:source`（パスが一致するときだけ）。不一致は 403、それ以外のすべての口（鍵の管理の口を含む）も 403。未知・失効・期限切れは 401。**新しい口を足しても、鍵はそこへ入れない**（許可表に足さない限り）。openapi の全ルートを回す歯（`apps/daemon/src/integration-keys.test.ts`）がそれを測る
  - **上限（本文のバイト数 → 413、1分あたりの回数 → 429 と `Retry-After`）はこの資格にだけ掛かる。** 人間・operator の経路には新しい制限を足していない（足すと「人間の使い方を絞る」ことになり、north_star 禁止2 に当たる）。**認証が無効の構成でも、`altk_` の bearer が付いていれば照合と制限を掛ける**（bearer が無ければ今までどおり素通し）
  - 値は発行の応答で1度だけ返し、保存は sha256 だけ。一覧は sha256 の先頭12桁で見分ける。**日誌には値を書かない**（名前・source・id・指紋だけ）。発行・失効は `access grant` と同じく**日誌を先に書き、書けなければ状態を変えずに 500**。使った記録は、届いた外部イベントの `external_event` 日誌項目の `via`（鍵の id と名前）に残る。断った試み（401/403/413/429）は日誌に書かず、デーモンのログへ（値は出さない）
- **既定では認証を要求しない。** `ALTEROID_GOOGLE_CLIENT_ID` と `ALTEROID_GOOGLE_CLIENT_SECRET` が揃うと自動で有効になり、`ALTEROID_AUTH=off` で明示的に切れる。設定していない人の `alteroid chat` が突然通らなくなるのは、境界の導入が実質のデグレードになる典型なので、**既定を「要求する」に倒さないこと**
- **ログインしただけでは使えない。** `alteroid access list` で見て `alteroid access grant <id>` で通す。取り消しは `revoke` で、**発行済みトークンを消さなくても即座に効く**（許可はリクエストごとに見ている）
- **許可できるアカウントの数に上限は無い**（2026-09-09 のオーナー決定）。同じ人間が私用と仕事用の Google アカウントの両方から入れる。使わせたくなくなったら `revoke` する（**発行済みトークンを消さなくても即座に効く**）
  - **⚠️ 2026-09-09 まではここが「高々1つ」で、2つ目の `grant` は 409 だった。** 強制は3層に入っていた —— `AuthStore.grantExclusive`（IF）/ fs の排他区間 / pg の部分一意索引 `auth_accounts_single_owner_idx`。**3層とも外してある**（索引は `migrate.ts` の末尾で drop。create を残すと次の起動で作りに行って落ちる）
  - **⚠️ 許可が伝播するようになった。** `/access/*` は 2026-09-06 から許可を持つアカウントも叩けるが、それまでは2人目が必ず 409 で弾かれていたので**伝播は起こりようがなかった。** いまは A が B を、B が C を通せる。**追える場所は日誌だけである**（`grantedBy` と `decision: アクセス許可を付与`）。`grantedBy` に固定値を書かないこと
- **不変条件はストアの1操作に閉じること。** ここは同じ失敗を4度踏んでいる場所である。ログインの経路は「読む → 外の世界と話す → 書く」の形をしていて、その真ん中が遅いので**必ず割り込まれる**と考えること
  - `beginLoginExchange` — `pending → processing`。**外部プロバイダとの交換へ進む権利**を1本に絞る。ブラウザの再送やプロキシのリトライで同じ callback が並行に届くのは普通に起きて、両方が交換すると認可コードは一度きりなので片方が必ず失敗し、その失敗が古い写しから `failed` を書いて成功側の `authenticated` を上書きしうる
    - **テストは「交換が1回だけ起きたか」を見ること。** 上書きが起きるかは処理順に依るので、最終状態だけを見るテストは通ってしまう（実際に通った）
  - `claimLoginRequest` — 消費とトークン保存を**1操作で**行う。「読む→検査→書く」に割ると同じ claim の並行送信で二重発行になり、「先に consumed→後で保存」に割ると保存失敗でログインを回収できなくなる（トークンは返らないのに要求は消費済み）
  - `grantAccess` — 許可の書き込みを1操作で。**⚠️ 2026-09-09 まではこれが `grantExclusive` で、守っていたのは「持ち主は高々1つ」だった。上限は外れたが1操作は残す** — 同じ account への同時 grant を「読む→検査→書く」に割ると `grantedBy` が後から来た側で上書きされ、**日誌に残した「誰が通したか」と食い違う**（伝播を追える唯一の場所がそこなので、ここが崩れると追跡ごと崩れる）
  - `createAccountWithIdentity` — 「初めて見る identity」の account 作成を**1操作で**行う（issue #1714）。`completeLogin` の当該分岐は `findIdentity` → `putAccount` → `putIdentity` の読んでから書く形をしていて、同じ `(provider, subject)` の2つのログインが同時に着くと両方が `null` を見て別々の account を作ってしまう——`putIdentity` は上書きなので後に書いた側が勝ち、**負けた側の account は identity から参照されない孤児として残る**（`listAccounts()` には残るが二度とログインできない）。在れば作らず既存の identity を返し、呼び手はそれを既存 identity のログインと同じ扱いに落とす
    - fs は1回の書き込み、pg はトランザクション内で**先に** identity を `(provider, subject)` への `on conflict do nothing` で insert し、入ったときだけ account を insert する。⚠️ **account を先にしてはいけない** — `auth_accounts_email_lower_idx`（#1702）が本番に在るため、同じ identity の2つのログインは外側の衝突検査を同時に通り抜けて同じメールを候補 account に載せうる。account を先に insert すると、負けた側は identity の一意制約へ辿り着く前に**メールの一意制約違反という別の例外**で落ちる（`(provider, subject)` の一意制約より先に `lower(email)` の一意制約に当たるため）。identity を先にすれば、負けた側は identity 側の一意制約だけで do nothing になり、メールの索引には当たらない（`auth_identities.account_id` に外部キーは無いので、account が存在する前に identity を insert しても問題ない）
  - fs は1回の書き込み、pg は条件付き UPDATE（`granted_at is null`）で強制する（`createAccountWithIdentity` を除く3つ）
  - **drizzle は例外を包むので、一意制約違反は `cause` を辿って判定すること**（最前面だけ見ると制約違反が予期しない例外として漏れる）。**⚠️ これを実装していた `isUniqueViolation` は 2026-09-09 に消えた**（唯一の呼び手だった単一持ち主の索引ごと落としたため）。この表にはまだ一意索引が在る（`auth_accounts_email_lower_idx`。#1702 で `auth_accounts_email_idx` から `lower(email)` へ移した）ので、翻訳が要る日が来たらここから書き戻す
- **`/access/*` に行為ごとのスコープを足さないこと。** 「chat は可・記憶の編集は不可」を入れた瞬間、それは地雷表3行目の `permissions.yaml` と同じ形になる
- **`/health` にトークンを載せ直さないこと。** かつては返していたが、いまその値は `access grant` を通せる資格そのものである。CLI は「提示して `operator` が返るか」で本人確認する（PID 再利用の検知としては同じ強さ）
- 認証の鍵は**上（記憶）へ到達する鍵**である（握られれば誰でもトークンを発行でき、API 経由で記憶に届く）。`GH_TOKEN` のような**下（外の世界）へ手を伸ばす鍵**とは扱いが逆で、落とす場所が2つある
  - **走っている runner**: `docker/alteroid-runner` が `exec` の前に `unset` する。人間は共有の1か所（`x-shared-env`）に置くだけでよく、runner はそれを持たない — 合鍵を sha256 へ畳むのとまったく同じ形である。CI の `image` ジョブが `/proc/1/environ` で見ている（**同時に `GH_TOKEN` が残ることも見る** — 「危なそうな名前を全部消す」方向へ倒れるとデグレードになる）
  - **マネージャー子プロセス**: デーモンが env から落とす（`AUTH_WITHHELD_ENV_KEYS`）。runner を立てないローカル構成でも塞がるようにするため
  - 環境変数名に `ALTEROID_` を付けてあるのは、人間が MCP で使う素の `GOOGLE_CLIENT_ID` を巻き添えで伏せないため
- ログイン手段を足すのは `packages/core/src/auth-providers.ts` に1つ書いて登録するだけ。**メール+パスワードは `oauth2` の枠に押し込まない**（`kind: 'password'` の枠を型として用意してある — パスワードは「外部の identity」ではなく「本人が持つ資格情報」で、概念が違う）
- **メールが一致しても既存アカウントへ相乗りさせない。** 別プロバイダで他人のメールを名乗れる以上、自動結合は乗っ取り経路になる。必ず別アカウントを作り、許可は人間が明示的に与える
- **ログアウトはサーバ側のトークンも失効させる（issue #1757）。** `alteroid logout` / Web の画面のログアウトは、まず `POST /auth/logout`（**認証が要る**——`/auth/me` と同じ `isPublicPath` の例外）を呼び、**いま提示している1本のアクセストークンだけ**を失効させる（`AuthStore.revokeAccessToken`。同じアカウントの他のトークンは触らない——アカウントごと締め出すのは `access revoke` の役目で別の操作）。**冪等**——`revokedAt` は空のときだけ立て、先に立った時刻は動かさない
  - **CLI**: 成功または 401（既に無効）なら手元の資格を消す。**サーバへ届かない・5xx・その他の失敗では手元の資格を消さない**（消すと、失効させる手段が `access revoke` しか残らない）。`--local-only` を付ければ、警告付きで手元だけを消せる（トークンは期限か `access revoke` まで有効なまま）
  - **operator の資格（状態ファイルの token）では呼べない。** operator はアクセストークンを1本も持たない別種の資格なので、`POST /auth/logout` は 4xx で断る（`alteroid access revoke` へ誘導する）
  - **Web**: 成功／401 なら鍵を捨てる。失敗したら鍵は残したままエラーを出し、「この画面から鍵だけを捨てる」を別に出す（`useAuth()` の `logout()` / `discardCredential()`）。ただし `Ungranted`（許可待ち）画面の「別のアカウントでログイン」は `discardCredential()` を使う——未許可のアカウントは `authenticate` 門番自体が 403 を返すので `logout()` では鍵を捨てられない
- 動作確認: `alteroid login` / `alteroid logout` / `alteroid whoami` / `alteroid access list|grant|revoke`。別のデーモンへ繋ぐなら `ALTEROID_URL=https://…`（手元のデーモンには**ログイン不要**で、状態ファイルを読めることで通る）
- コンテナでは `docker compose exec app alteroid access grant <id>`。Redirect URI は `<ALTEROID_PUBLIC_URL>/auth/google/callback` の1本だけ登録すればよい
