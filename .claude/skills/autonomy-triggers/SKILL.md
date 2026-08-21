---
name: autonomy-triggers
description: 自律の起点4つ（日報・発意 tick・スケジュール・外部イベント POST /events）と受信箱を触るときに読む。既定で動くこと、schedule_create と cron 式、claimRun と completeRun を1つに戻さない理由、受信箱の3つの約束（未読を書く時点・消す時点・例外で終わった合図）。
---

# 自律まわりの動かし方（起点4つ）

<!-- AGENTS.md から移設。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **既定で動く。** 日報（既定 22:00）と発意 tick（既定 55 分。理由は `apps/daemon/src/schedule.ts` の `DEFAULT_INITIATIVE_EVERY_MINUTES` の JSDoc）は何も設定しなくても回る。常駐と自律は後から足す機能ではないので、既定を「止まっている」にしないこと
  - `ALTEROID_DAILY_REPORT_AT`（`HH:MM` / `off`）、`ALTEROID_INITIATIVE_EVERY`（分 / `off`）、`ALTEROID_REPORT_LOOKBACK_DAYS`（起動時に遡って日報を作る日数、既定 3）
  - これらは**方針**の設定であって、暴走を止めるための回数制限ではない。抑止は実行環境の境界で行う（north_star 禁止2）
- 待たずに確かめるなら `POST /schedule/:kind/run`（chat では `/run daily_report` / `/run self_initiative`）。`GET /schedule` で次の発火が見える
- **「定期的に〜しておいて」は記憶だけに書かせない。** 記憶は根拠を置く場所で時計を持たないので、そこにだけ書いた依頼は「発意 tick のときに思い出せるかどうか」の賭けになる。継続する依頼はクローンが `schedule_create`（`kind` ＋ `dailyAt` / `everyMinutes` / `cron` のどれか1つ ＋ 依頼の本文）で仕込み、時刻が来れば必ず受信箱へ届く形にする（`schedule_list` / `schedule_remove` で読む・外す）
  - 周期は3つ。曜日や月の指定が要るものは **cron 式**（`croner`。ローカル時刻。例 `0 10 * * 1`）で書く。**「毎日起きて曜日を見て何もしない」で代用しないこと** — 7回に6回は Fable のターンを空焼きする。読めない式は保存の時点で弾く（`scheduleSpecSchema`）ので、経路ごとに検査を足さない
  - 器は `ScheduleStore`（`packages/core/src/store.ts`）。fs では `~/.alteroid/jobs/schedules.json`、pg では `schedules` テーブル。**真実はストア側だけに置く** — スケジューラへ直接足す口を作ると、デーモン再起動で仕込みが消える
  - スケジューラは `refresh()` でストアを読み直す。内部タイマーが刻むたびに通るので、足した依頼は最大1分で効く。人間が API から足した時とデーモン起動時は明示的に呼んで待たせない
  - 発火イベントに載るのは `kind` だけである。**依頼の本文をイベントに載せないこと** — 載せた瞬間に発火時点の写しになり、人間が本文を直しても古い依頼で走る
  - **引き受け（`claimRun`）と完了（`completeRun`）を1つに戻さないこと。** 引き受けた印（`pendingRun`）だけを残して定期の基準（`lastScheduledRunAt`）は完了時に進める。片方に寄せると必ずどちらかが壊れる — 先に基準を進めれば claim 直後に落ちた回が「もう動いた」ことになって日次なら翌日まで消え、印だけにすると動いた後に落ちた回を止められない。印が残っていれば次の起動で配り直し、走りかけていた可能性をプロンプトに添える（`prompt.ts` の `unfinishedAt`）
  - **手で起こした1回（`POST /schedule/:kind/run`）で定期の予定をずらさない。** 発火の合図の `cause` で区別し、`manual` では観測用の `lastRunAt` だけを動かす。ここを混ぜると、手動実行のたびに位相が動く（再起動後に露呈する）
  - 依頼を直す経路（`schedule_create` / `POST /schedule`）では `lastScheduledRunAt` と `pendingRun` を**引き継ぐ**こと。落とすと、直した瞬間に位相が `createdAt` から引き直され、引き受けたまま終わっていない回も消える
  - 発火のたびに `lastRunAt` が付き、依頼の一覧と前回時刻は digest（`digest.ts`）にも常に載る。同じ issue に何本もマネージャーが立つのを止めるのはこの材料と `manager_list` であって、**同時数の上限ではない**（north_star 禁止2）
  - 人間側の口は `GET /schedule`（`request` / `lastRunAt` 付き）・`POST /schedule`・`DELETE /schedule/:kind`、chat では `/schedule` と `/unschedule <kind>`。`daily_report` / `self_initiative` の名前は奪えない（`RESERVED_SCHEDULE_KINDS`）
- **外部イベントの入口は HTTP の `POST /events`**（`{source, payload}`）。送り元の形を変えられない webhook 用に `POST /events/:source`（本文まるごとが payload）もある。chat からは `/event <source> <本文>`
  - 開いているのは 127.0.0.1 だけ。外から叩かせるならトンネル・リバースプロキシ側に境界を置く（ここで認証を足す前に、それが方針か境界かを考える）
  - **127.0.0.1 で待つことはブラウザからの保護にならない。** 人間が開いた任意のページが単純リクエスト（`text/plain` や form の POST）を投げられ、応答が読めなくても送信は成立する。状態を変える POST を足すときは、`validator('json', ...)`（`hono-openapi` の validator。#22 で `@hono/zod-validator` の `zValidator` から差し替えた）を付けるか、本文の無い経路なら `deliberateClient`（`apps/daemon/src/app.ts`）を必ず通すこと — でないと他人がクローンのターンを起こせる。塞ぐのは能力側ではなく実行環境の境界である
  - MCP 経由のポーリングは**別機構にしない**。「Slack を見に行く」は定期ジョブ＋マネージャーへの委譲で足りる（マネージャーは人間と同じ `.mcp.json` を持つ）
- **4つの起点はどれも受信箱（`packages/core/src/inbox.ts` と `clone.ts` の `post()`）へ落ちる。合図の生死をまたぐ約束が3つあり、どれを動かしても #58 で塞いだ穴が開く**（守っているのは `packages/core/src/inbox-persistence.test.ts`。形は上の `claimRun` / `completeRun` と同じで、**印を残す時点と基準を進める時点を1つにまとめると必ず壊れる**）
  - **未読として書き出すのは「受理した時点」**（`post()` の `#remember`）。**「queue に入った時点」へ動かさないこと** — クローンが暇なときに届いた合図は `Inbox#push` の waiter 経路を通って queue を素通りするので、queue を吐き出す形の永続化はその経路を1件も救わない
  - **消すのは「終えた時点」**（`#settleInboxEvent` → `#forget`）。**「取り出した時点」へ動かさないこと** — 処理の途中でプロセスが死んだ合図が失われ、塞ぐ前の状態に戻る。拾い直しは起動時の `#restoreUnread` → `claimPending`（読みと配達回数の加算が1操作）で、**配り直しだと分かる形で届く** — 消えるより二重配達を採り、二度目だと分かることで吸収している
  - **例外で終わった合図は消す側が正しい。** そこへ来ているということは失敗が記録されたということで、残す側へ倒すと、決定的に失敗する合図（形が不正・参照先が消えている）が起動のたびに配り直されてクローンのターンを1本ずつ焼く。**残るのはプロセスが死んだときと、枠で保持したとき（`defer`）だけ**が線である
- 日報は `GET /reports` / `GET /reports/:date`、chat では `/report` `/reports`。**日報が無い日を作らないこと** — クローンが `daily_report_write` を呼び忘れたらその応答をそのまま日報にする実装になっている（`clone.ts` の `#dailyReport`）
- 溜まった承認待ちは chat の `/approvals`（番号付き）→ `/answer <番号> <回答>`、API では `POST /approvals/answer` にまとめて渡す
- 時間起点の確認を SDK 抜きでやるなら `createScheduler({ now, post })` に偽の時計を渡して `tick(日時)` を直接呼ぶ（`packages/core/src/schedule.test.ts`）。実 SDK での確認は `ALTEROID_INITIATIVE_EVERY=1`＋締め時刻を数分後にして放置するのが早い
