# assets 枝

`main` の README が参照する画像だけを置く枝。**消さないこと。** 消すと README の画像がすべて切れる。

- `main` の履歴とは繋がっていない（orphan）。マージもしない
- `main` に画像を置かないのは、作業ツリーに NUL バイトを許さない歯（`scripts/check-tracked-nul-bytes.test.ts`、#260 / #1817）があるため。PNG は必ず NUL を含む
- 参照の形: `https://raw.githubusercontent.com/takecchi/alteroid/assets/<パス>`

| パス | 何か |
| --- | --- |
| `readme/dashboard.png` | Web UI のダッシュボード |
| `readme/chat.png` | Web UI の会話 |
| `readme/memory.png` | Web UI の記憶 |

画像はオーナーが本番で撮ったもの。サイドバー下端（メールアドレス・記憶ストアの所在と pid）はぼかしてある。
