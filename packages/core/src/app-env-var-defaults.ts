// 何も import しない: `env-vars-boot.ts` と `credential-service.ts` の両方が読み、片方へ置くと互いに import し合う形になるため（#4830）
// 「未設定＝空」が正しい既定の変数は播種しない: 空文字は袋の中で「外す」と同じ意味になるため
export const APP_ENV_VAR_DEFAULTS: readonly { name: string; value: string }[] = [
  { name: 'TZ', value: 'Asia/Tokyo' },
  { name: 'ALTEROID_DAILY_REPORT_AT', value: '22:00' },
  { name: 'ALTEROID_INITIATIVE_EVERY', value: '55' },
  { name: 'ALTEROID_ACCESS_TOKEN_TTL_DAYS', value: '30' },
  { name: 'ALTEROID_WITHHELD_REPORT_FLUSH_MS', value: '1800000' },
  { name: 'ALTEROID_INBOX_SETTLE_MS', value: '2500' },
  { name: 'ALTEROID_REPORT_SETTLE_MS', value: '30000' },
  { name: 'ALTEROID_MEMORY_TIDY_AT', value: '03:00' },
  { name: 'ALTEROID_REPORT_LOOKBACK_DAYS', value: '3' },
];

// 変えても再起動まで効かない名前（#4830）: デーモンが起動時に process.env へ写した値を読み、正本（stores.credentials）から読み直さないため。
// 起動時に1回だけ読むもの（日報・記憶の整理・自発の周期、日報の遡り日数、トークンの期限）と、
// 読むたびに process.env を引くもの（TZ、握り潰しの配り直しの期限）が混ざるが、後者も process.env が起動時にしか書き換わらないので同じ。
// クローンの子プロセスへ渡す env は呼ぶたびに正本から読み直すので、すぐ効く: その名前はここへ入れない。
export const DAEMON_RESTART_REQUIRED_ENV_NAMES: readonly string[] = APP_ENV_VAR_DEFAULTS.map(
  (entry) => entry.name,
);
