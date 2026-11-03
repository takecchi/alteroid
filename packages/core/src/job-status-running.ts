import type { JobStatus } from './schema.js';

// 委譲の「動いている」は2つの問いに分ける。インラインで `status === 'running' || status === 'waiting_human'` と書かず、意味に合う方を使う（#6298 が既知の値・未知の値の答えを固定している）:
//   - `isRunningJobStatus`: 厳密に走行中（running だけ）。件数の「実行中」など、止まっているだけの委譲を数えない問い
//   - `isManagerInFlight`: まだ続く（running か waiting_human）。人間の返事待ちも「動いている委譲」に含める問い
// 未知の値は、どちらも「動いている」側へ倒す: 別デプロイの版のずれで知らない値が来たとき、数え漏らさず、結び付いた task を判断待ちへ落とさない（クローンが二重に手を出さない）ため

// `waiting_human` を「実行中」に含めない: 止まっているだけの委譲まで「動いている」と数えて、字面と件数が食い違うため
// 未知の値は実行中として数える: 数えないと、新しい値が件数から静かに漏れるため
export function isRunningJobStatus(status: JobStatus): boolean {
  switch (status) {
    case 'running':
      return true;
    case 'waiting_human':
    case 'done':
    case 'failed':
    case 'lost':
    case 'stopped':
      return false;
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return true;
    }
  }
}

// `lost` をここへ足さない（`isManagerAwaitingJudgement` を使う）: 日報は第1キーで sort して `MAX_ITEMS` で slice するので、枠を食って最近終わった委譲が押し出されるため
// 未知の値は動いている側: 終わったと決めつけると、走っている委譲の task が判断待ちに落ちる
export function isManagerInFlight(status: JobStatus): boolean {
  switch (status) {
    case 'running':
    case 'waiting_human':
      return true;
    case 'done':
    case 'failed':
    case 'lost':
    case 'stopped':
      return false;
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return true;
    }
  }
}
