# @alteroid/web — 公式の画面

CLI（`alteroid chat`）と同じことを画面からできるようにするもの。**API の上の実装**であって、
デーモンに独自の経路を持たない（要件は [docs/PRD.md](../../docs/PRD.md)「インターフェース」、
設計判断は [docs/architecture.md](../../docs/architecture.md)「Web UI」）。

React Router v7 の **SPA**（`ssr: false`）。成果物は静的ファイルだけなので、置き場所を選ばない。

## 動かす

```sh
pnpm build                      # 先に一式ビルドする（api-client の型が要る）
alteroid daemon start           # デーモン（既定 127.0.0.1:4517）
pnpm --filter @alteroid/web dev # http://localhost:5173
```

開発サーバは `/api` をデーモンへ proxy する（`vite.config.ts`）。**同一オリジンに見えるので、
開発のためだけにデーモンへ CORS を開ける必要はない。** デーモンが別のポートに居るなら
`ALTEROID_API_URL=http://127.0.0.1:9999 pnpm --filter @alteroid/web dev`。

動作確認は捨ててよい `ALTEROID_HOME` を指すこと（自分の記憶を壊さない）。

## 接続先の決まり方

上が勝つ。

1. **画面の「設定」で入れた値**（`localStorage`）
2. ビルド時の `VITE_ALTEROID_API_URL`
3. 同一オリジンの `/api`（既定）

1 があるので、**配る成果物1つのまま人によって違うデーモンへ向けられる**。配置ごとにビルドし
直す必要はない。

## 配置

**どこに置くにせよ、経路の解決を `index.html` へ倒すこと。** SPA なので実体は `index.html`
1枚だけで、`/approvals` のような経路に対応するファイルは存在しない。倒し忘れると
**直リンクとリロードだけが 404 になる** — 画面の中のナビゲーションからは動くので、
気づかないまま「動いている」と思いやすい。リポジトリ先頭の `vercel.json` がそれで、
他のホスティングに置くなら同じことをそれぞれの作法で書く（`try_files` / SPA fallback）。

### 画面とデーモンが同じオリジン

手前のリバースプロキシで `/api` をデーモンへ、それ以外を `build/client` へ流す。デーモン側の
設定は要らない（CORS ヘッダを返さないまま動く）。

### 画面とデーモンのオリジンが違う

`www.example.com` と `api.example.com`、`www.hoge.vercel.app` と `api.example.com` のどちらも同じ。

```sh
# デーモン側。**明示列挙だけ**。ワイルドカードは受け付けない
ALTEROID_ALLOWED_ORIGINS=https://www.example.com,https://www.hoge.vercel.app
```

画面側は「設定」で `https://api.example.com` を入れるか、`VITE_ALTEROID_API_URL` を与えてビルドする。

**Cookie は使わない。** 別ドメイン間の Cookie は成立しない（サードパーティ Cookie の廃止と
ITP、そして登録可能ドメインが違えば `Domain` 属性でも共有できない）。資格情報は
`Authorization: Bearer` ヘッダで運ぶので、どの配置でも同じように動く。

> **CORS はブラウザにしか効かない。** `curl` は素通りする。外から届く場所に置くなら、
> 下のログインを有効にするか、手前に境界（リバースプロキシ・トンネル）を置くこと。

## ログイン

デーモンに認証が設定されていれば（`ALTEROID_GOOGLE_CLIENT_ID` / `ALTEROID_GOOGLE_CLIENT_SECRET`）、
画面は `/login` を出す。**CLI（`alteroid login`）とまったく同じ経路を通る** — 画面のために
デーモンへ足した経路は1本も無い。

```
POST /auth/login              → {requestId, authorizationUrl, claimSecret, expiresAt}
  ↓ authorizationUrl を別ウィンドウで開く（Google へ）
GET  /auth/:provider/callback → 「端末に戻れ」と書いた HTML だけを返す
  ↓ **鍵は URL にも Cookie にも載らない**
POST /auth/login/:id/claim    → {token, account, granted}
```

コールバックの画面からはこちらへ何も返ってこない（`postMessage` もリダイレクトも無い）ので、
**始めたタブが生きている必要がある**。ポップアップで開き、塞がれた場合に備えて引き換え券を
`sessionStorage` にも預ける（同じタブごと遷移させられても引き取りを続けられる）。

### ログインしただけでは使えない

alteroid は単一の持ち主のものなので、使う許可は人間が CLI から与える。

```sh
alteroid access list
alteroid access grant <アカウント id>
```

許可が無い状態は **403** で返る。画面はこれを「未ログイン」と混ぜず、専用の画面で
アカウント id と上のコマンドを出す — ログインし直しても解決しないため。

### 状態の見分け方

| 状態        | 何が起きているか                  | 画面                                 |
| ----------- | --------------------------------- | ------------------------------------ |
| `open`      | デーモンが認証を要求していない    | ログイン画面を出さない（従来どおり） |
| `anonymous` | 未ログイン / 鍵が無効（401）      | ログイン                             |
| `ungranted` | ログイン済みだが許可が無い（403） | `access grant` の案内                |
| `ready`     | 通る                              | 本体                                 |

トークンは**接続先ごと**に `localStorage` へ持つ（発行したデーモンでしか通らないため）。
寿命は既定 30 日で更新の仕組みは無いので、401 を受けたら捨ててログインし直す。
403 では捨てない（鍵は有効なので、捨てると解決しない導線に落ちる）。

## 作り

```
app/
  root.tsx            html の外枠と ApiProvider
  routes.ts           経路の割り当て（CLI のスラッシュコマンドと対応させる）
  routes/shell.tsx    通っていれば中身を出す門 ＋ 左のナビと日誌 SSE の購読1本
  routes/login.tsx    ログイン / 「まだ許可が無い」
  routes/*.tsx        画面
  hooks/queries.ts    取得（SWR。キーはオブジェクト）
  hooks/mutations.ts  書き込み
  hooks/use-auth.ts   open / anonymous / ungranted / ready の判定
  hooks/use-journal-live.ts  日誌 SSE →  SWR キャッシュの無効化
  lib/api.tsx         @alteroid/api-client の生成と、資格情報を足す唯一の場所
  lib/auth.ts         トークンと引き換え券の置き場（接続先ごと）
  lib/login.ts        ログインの段取り（開始と引き取り。UI を持たないので試験できる）
  lib/config.ts       接続先の決め方
  lib/types.ts        生成 spec から導出した型（手書きしない）
```

**通るまで取得も購読も始めない。** `shell.tsx` は門と中身を別の部品に分けてある。同じ部品に
混ぜると、未ログインのまま全経路が 401 を叩き、日誌のストリームが再接続を繰り返す。

**画面ごとにポーリングを足さない。** デーモンはあらゆる日誌の追記を `GET /journal/stream` に
流すので、購読は `shell.tsx` の1本だけでよく、届いた種別に応じて SWR のキャッシュを落とせば
画面全体が生きたままになる。
