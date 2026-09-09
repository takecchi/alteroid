# Architecture Decision Records

mnemora の設計判断のうち、**後から見て「なぜそうしたか」を追える形で残す必要があるもの**を
ADR (Architecture Decision Record) として記録する。`docs/architecture.md` や
`docs/memory-model.md` 等の他の docs が「何がどう決まっているか」を記述するのに対し、
ここでは各決定について、検討した選択肢・却下した理由・引き受ける負債・覆る条件までを
1ファイルにまとめる。**決定そのものをやり直す場ではなく、決定を記録する場である。**

alteroid (github.com/takecchi/alteroid) を根拠として引く箇所は、確認済み/未確認を分けた
一次調査の記録である [docs/alteroid-findings.md](../alteroid-findings.md) を参照する。

## 一覧

| 番号                                                      | 題                                                               | 状態           |
| --------------------------------------------------------- | ---------------------------------------------------------------- | -------------- |
| [0001](./0001-orm-drizzle.md)                             | ORM は Drizzle                                                   | 採用 (2026-09) |
| [0002](./0002-embedding-space-tables.md)                  | pgvector の抽象と埋め込み空間ごとのテーブル分割                  | 採用 (2026-09) |
| [0003](./0003-memorystore-vs-vectorstore.md)              | MemoryStore と VectorStore を分けるか                            | 採用 (2026-09) |
| [0004](./0004-decay-at-query-time.md)                     | 忘却をクエリ時に算出しつつ ANN 索引を殺さない                    | 採用 (2026-09) |
| [0005](./0005-job-queue-abstraction.md)                   | Job Queue の抽象                                                 | 採用 (2026-09) |
| [0006](./0006-memory-schema.md)                           | Memory schema の設計判断                                         | 採用 (2026-09) |
| [0007](./0007-tenant-scoping.md)                          | Tenant scoping                                                   | 採用 (2026-09) |
| [0008](./0008-absence-taxonomy.md)                        | 「無い」を分類して返す                                           | 採用 (2026-09) |
| [0009](./0009-usage-feedback-via-observe.md)              | 使用フィードバックを observe() で受ける                          | 採用 (2026-09) |
| [0010](./0010-decay-parameters.md)                        | 減衰の式とパラメータを固定する                                   | 採用 (2026-09) |
| [0011](./0011-no-window-count-in-ann-stage.md)            | 段1の ANN クエリに `count(*) OVER ()` を入れない                 | 採用 (2026-09) |
| [0012](./0012-ingest-pipeline-design.md)                  | 取り込みパイプライン（`observe()` / `runtime.tick()`）の実装方針 | 採用 (2026-09) |
| [0013](./0013-extraction-outcome-taxonomy.md)             | 抽出の失敗を、成功と同じ顔で記録しない                           | 採用 (2026-09) |
| [0014](./0014-package-name-mnemora.md)                    | 名前を `mnemora` / `@mnemora/*` に確定する                       | 採用 (2026-09) |
| [0015](./0015-root-test-gate-reports-skipped-db-tests.md) | ルートの `test` 門は、DB テストを「走らせなかった」と明示する    | 採用 (2026-09) |
| [0016](./0016-db-test-gate-explicit-exclusion.md)         | DB テストの排他は依存グラフに頼らず、門のコード自身に載せる      | 採用 (2026-09) |
| [0017](./0017-runmigrations-advisory-lock.md)             | `runMigrations()` を advisory lock でプロセス間排他する          | 採用 (2026-09) |
| [0018](./0018-register-embedding-space-advisory-lock.md)  | `registerEmbeddingSpace()` を advisory lock でプロセス間排他する | 採用 (2026-09) |
| [0019](./0019-real-openai-measurement-cost.md)             | 本物の OpenAI で北極星の物差しを測る — 費用・実測値・分かったこと | 採用 (2026-09) |
| [0020](./0020-temp-database-drain-before-drop.md)          | 使い捨てテスト DB は「接続0本」を実測してから `DROP DATABASE`（`WITH (FORCE)` を使わない） | 採用 (2026-09) |
| [0021](./0021-drain-embed-ticks-in-ingest.md)              | `examples/chat` の `ingestConversation` は `tick()` を干上がるまで回す | 採用 (2026-09) |
| [0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) | 北極星の「削っても目的の記憶が落ちない」を、擬似 provider の `compare` では主張しない | 採用 (2026-09) |
| [0023](./0023-subject-filter-in-ann-stage.md) | 段1の ANN クエリで `subject` を等値で絞る（`period` は降ろさない） | 採用 (2026-09) |
| [0024](./0024-remove-exact-counts-option.md) | 実装の無い `exactCounts` を、「予約」と書き残さずに削除する | 採用 (2026-09) |
| [0025](./0025-ann-underfill-is-not-reported-in-omitted.md) | 段1の ANN が窓を埋められなかったことが `omitted` に出ていない（実測のみ） | **未決** (2026-09) |
| [0026](./0026-ann-unreached-omission.md) | 近似索引が scope に届かなかったことを `Omission { kind: 'ann_unreached' }` として出す | 採用 (2026-09) |
| [0027](./0027-split-superseded-forgotten-omission.md) | `filtered` omission の `condition: 'status'` を `'superseded'` と `'forgotten'` に分ける | 採用 (2026-09) |
| [0028](./0028-reextract-superseded-cleanup.md) | `runtime.reextract` は古い抽出結果を `superseded` にする（`forgotten` にしない） | 採用 (2026-09) |
| [0029](./0029-reextract-skip-visibility.md) | `reextract` が既存 Memory を supersede しなかった理由を `ReextractResult.skipped` に出す | 採用 (2026-09) |
| [0030](./0030-update-status-compare-and-swap.md) | `MemoryStore.updateStatus` を compare-and-swap にし、`reextract` の安全弁の TOCTOU を塞ぐ | 採用 (2026-09) |
| [0031](./0031-supersede-status-and-event-in-one-transaction.md) | `reextract` の supersede の status 更新とイベント追記を、別々の2コミットから1トランザクションにまとめる | 採用 (2026-09) |
| [0032](./0032-outbox-claim-lease.md) | `OutboxStore.claimBatch` に claim のリースを足し、「見えない停止」と「先頭詰まり」を塞ぐ | 採用 (2026-09) |
| [0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) | `retrieval` ベンチが順位の理由を捨てていたのをやめる — 実際に順位を決めていた項の実測 | 採用 (2026-09) |
| [0034](./0034-vector-store-filter-conformance.md) | `VectorFilter` を「adapter が実際に適用しなければならない」契約にし、その契約を適合テストの歯として置く | 採用 (2026-09) |
| [0035](./0035-recalled-memory-provenance-kind.md) | `recall()` の返り値に `provenanceKind` を載せる — 「区別して返す」を返り値の側で満たす | 採用 (2026-09) |
| [0036](./0036-clamp-freshness-at-one.md) | `freshness` を 1 で頭打ちにする — 「まだ起きていない出来事は、最も古びていない」 | 採用 (2026-09) |
| [0037](./0037-callers-pass-occurred-at.md) | `observe()` の `occurredAt` を実際に通す — 「いつの出来事か」を絞れるようにする | 採用 (2026-09) |
| [0038](./0038-vector-hit-distance-is-cosine.md) | `VectorHit.distance` はコサイン距離だと契約に明記し、適合テストの歯で adapter 非依存に検査する | 採用 (2026-09) |
| [0039](./0039-period-boundary-conformance.md) | `period` の判定規則が4箇所に在ることを、境界の歯で固定する | 採用 (2026-09) |
| [0040](./0040-zero-vector-never-returned.md) | ゼロベクトルが絡む候補は `recall()` の結果に出ない — 契約は振る舞いで揃える | 採用 (2026-09) |
| [0041](./0041-reinforce-does-not-change-strength.md) | `reinforce` は `strength` を動かさない — 「強化」の意味を確定させる | 採用 (2026-09) |
| [0042](./0042-event-store-list-order-and-limit.md) | `EventStore.list` の並び順・`limit`・`since`/`until` を契約に明記し、適合テストの歯で固定する | 採用 (2026-09) |
| [0043](./0043-unit-assembly-dropped-omission.md) | 一対一の対向関係が破れて候補が単位から漏れたら、`omitted` に出す（黙らない） | 採用 (2026-09) |
| [0044](./0044-score-not-comparable-omission.md) | 段2の閾値比較を網羅的な三分割にし、`score_not_comparable` を `omitted` に出す | 採用 (2026-09) |
| [0045](./0045-budget-dropped-count-kind.md) | `budget_dropped` の `countKind` を、単位の網羅性から引き継ぐ | 採用 (2026-09) |
| [0046](./0046-contested-pair-invariant-tooth.md) | `contested` の一対一を「測れる形」にする——振る舞いは決めない | 採用 (2026-09) |
| [0047](./0047-fake-referential-integrity-existence-only.md) | 擬似物（in-memory 実装・core の Fake）にも外部キー相当の「存在」検査を適用する（「整合」までは広げない） | 採用 (2026-09) |
| [0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) | `reinforce` は減衰の起点を巻き戻さない——比較を DB の1文へ入れる | 採用 (2026-09) |
| [0049](./0049-reinforce-monotonicity-in-pseudo-implementations.md) | `reinforce` の単調性を擬似物にも揃える——新しい決定ではなく、ADR 0048 の追随 | 採用 (2026-09) |
| [0050](./0050-tenant-event-retention.md) | `TenantSettingsStore` に event retention の読み書きを足す | 採用 (2026-09) |
| [0051](./0051-recorded-provider-cassette.md) | 記録した実 API の応答を再生する provider を、物差しの経路にだけ入れる（二層にする） | 採用 (2026-09) |
| [0052](./0052-compare-cassette-and-provenance-survival.md) | `compare` を実 API で測ったら「答えが落ちる」は消えた — 擬似物の産物だったことの確認と、その代償 | 採用 (2026-09) |
| [0053](./0053-set-embedding-status-does-not-roll-back-ready.md) | `setEmbeddingStatus` は `ready` を `failed` へ巻き戻さない（no-op。例外にしない） | 採用 (2026-09) |
| [0054](./0054-idempotent-create-from-the-insert-decision.md) | 擬似実装の `created` は挿入の決定そのものから出す——判定と挿入の間に `await` を挟まない | 採用 (2026-09) |
| [0055](./0055-extraction-prompt-subject-and-inference-not-added.md) | 抽出プロンプトに「主語を復元する1文」も「推論を生成する1文」も足さない——実 API 18 run で測った結果と、その代償 | 採用 (2026-09) |
| [0056](./0056-exclude-provenance-kinds-in-ann-stage.md) | 段1の ANN クエリで `excludeProvenanceKinds` を絞る（`period` は今回も降ろさない） | 採用 (2026-09) |
| [0057](./0057-dedicated-schema-namespace.md) | mnemora のオブジェクトを置くスキーマを、使う側が指定できるようにする — DML は `search_path`、DDL と存在検査は明示修飾 | 採用 (2026-09) |
| [0058](./0058-measure-the-time-term-in-a-separate-arm.md) | 時間項（`freshness` / `decay`）は、既存の probe set を書き換えずに別 arm で分離して測る — `probe-set.ts` に `occurredAt` を書き込まない | 採用 (2026-09) |
| [0059](./0059-period-in-ann-stage.md) | 段1の ANN クエリで `period` を絞る（`COALESCE(occurred_at, recorded_at)` の式索引を1本足す） | 採用 (2026-09) |
| [0060](./0060-publish-with-pnpm-four-packages-at-0-1-0.md) | npm へ出すのは4パッケージだけ・初回は `0.1.0`・梱包の道具は pnpm に統一する（ライセンスと `private` 解除は対象外） | 採用 (2026-09) |
| [0061](./0061-license-mit.md) | ライセンスを MIT にする — オーナーの決定、6パッケージの `license` と LICENSE の配布、tarball の側から検査する門（`private` 解除は対象外） | 採用 (2026-09) |
| [0062](./0062-contested-with-id-fk-index.md) | `memories.contested_with_id` の自己参照 FK に索引を足す — `tenant_id` 先頭の複合索引は RI チェックを効率良く供給できないこと・索引名は中身を保証しないこと | 採用 (2026-09) |
| [0063](./0063-hnsw-iterative-scan-not-adopted.md) | `hnsw.iterative_scan` は採らない — 件数は直るが正しさは直らない（`strict_order` は正しさを一切買わない）ことを3腕×4窓で測った記録 | 採用 (2026-09) |
| [0064](./0064-exact-path-cost-vs-scale.md) | 厳密経路の費用倍率を規模で振って測った — ADR 0063 の「約2.5倍」の訂正と、`relaxed_order` の recall が規模とともに悪化するという発見 | 採用 (2026-09) |
| [0065](./0065-vector-store-space-separation-conformance.md) | `VectorStore` の space 分離を適合テストの歯にする — `FakeVectorStore` に丸ごと空いていた一段と、監査の漏れの記録 | 採用 (2026-09) |
| [0066](./0066-start-publishing-with-oidc.md) | **publish を始める**（対象4つの `private` を外す）— 梱包は pnpm・アップロードは npm（Trusted Publishing / OIDC）、引き金は GitHub Release。梱包の欠陥4件（`@types/pg` / `workspace:^` / `exports` / `vitest` の peer 化）を初版の前に直した。**`0.1.0` は publish 済み**（初版は OIDC で出せないため token 経路。provenance 無し） | 採用 (2026-09) |
| [0067](./0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md) | 予行フラグ (`dry_run`) の fail-open を安全側へ反転する — `--dry-run` は信頼発行元 (Trusted Publisher) の未設定を検出できないと実測した記録 | 採用 (2026-09) |
| [0068](./0068-the-bench-must-not-lie-about-what-it-measured.md) | `retrieval` ベンチが「測っていないこと」を測ったかのように印字するのをやめる — 2回目の実行で `ingest` が逆の結論を出すこと・出力から arm を跨いで数字を拾えること・`OPENAI_API_KEY` が在るだけでカセット再生が実 API へ倒れること | 採用 (2026-09) |
