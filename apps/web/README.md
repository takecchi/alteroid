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
ITP、そして登録可能ドメインが違えば `Domain` 属性でも共有できない）。資格情報はヘッダで運ぶ
ので、どの配置でも同じように動く。認証そのものは別途進行中で、入るときは
`app/lib/api.tsx` の `headers` 1か所に載る。

> **デーモンの API にはまだ認証が無い。** 外から届く場所に置くなら、手前に境界
> （リバースプロキシ・トンネル・認証）を必ず置くこと。CORS はブラウザにしか効かず、
> `curl` は素通りする。

## 作り

```
app/
  root.tsx            html の外枠と ApiProvider
  routes.ts           経路の割り当て（CLI のスラッシュコマンドと対応させる）
  routes/shell.tsx    左のナビと、日誌 SSE の購読1本
  routes/*.tsx        画面
  hooks/queries.ts    取得（SWR。キーはオブジェクト）
  hooks/mutations.ts  書き込み
  hooks/use-journal-live.ts  日誌 SSE →  SWR キャッシュの無効化
  lib/api.tsx         @alteroid/api-client の生成と、資格情報を足す唯一の場所
  lib/config.ts       接続先の決め方
  lib/types.ts        生成 spec から導出した型（手書きしない）
```

**画面ごとにポーリングを足さない。** デーモンはあらゆる日誌の追記を `GET /journal/stream` に
流すので、購読は `shell.tsx` の1本だけでよく、届いた種別に応じて SWR のキャッシュを落とせば
画面全体が生きたままになる。
