// 値を1つだけ持つ: daemon の本体と CLI（`apps/cli/src/daemon.ts` の `CLEANUP_WAIT_MS`）の両方がここから引く。CLI は daemon 本体を import できない（本体ごと読み込むため）。
// 正本は `railway/daemon.json` の `drainingSeconds` と `compose.yaml`（`daemon`）の `stop_grace_period` で、実行中のプロセスからは読めない。
// runner の猶予（`lease.ts` の `LEASE_DRAIN_MS`）とは共有しない: Service ごとの設定で、片方だけ延ばす日があるため。
export const DAEMON_SHUTDOWN_GRACE_MS = 60_000;

// `DAEMON_SHUTDOWN_GRACE_MS` と同じ値にしない: 猶予が切れる時刻には器の SIGKILL が来るため、自分で `exit` する最後の口が負けて消える。
export const DAEMON_FORCED_EXIT_MS = DAEMON_SHUTDOWN_GRACE_MS - 5_000;
