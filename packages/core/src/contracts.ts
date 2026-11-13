// 契約の歯（`verify*Contract`）の入口 `@alteroid/core/contracts`。試験だけが呼ぶ: 本番の入口 `index.ts` から外して、起動で読む量を減らす。
// `index.ts` を import しない: 本番の入口を二重に読み込まず、循環も作らない。各 `*-contract.ts` を直接 export する。
/** 3実装（インメモリ / `storage-fs` / `storage-pg`）それぞれの歯が契約を呼ぶ: 1つで測って3つとも測ったことにしない。 */
export { verifyConversationReadStoreContract } from './conversation-read-contract.js';
export { verifyJournalStoreWithContract } from './journal-with-contract.js';
export { verifyJournalStoreDeletedConversationContract } from './journal-deleted-conversation-contract.js';
export { verifyJournalStoreWithdrawnContract } from './journal-withdrawn-contract.js';
export { verifyJournalStoreToolUseCountContract } from './journal-tool-use-count-contract.js';
export { verifyJournalStoreConversationIdsAfterContract } from './journal-conversation-ids-after-contract.js';
export { verifyJournalStoreConversationPrefixContract } from './journal-conversation-prefix-contract.js';
export { verifyJournalStoreOrderContract } from './journal-order-with-contract.js';
export { verifyConversationPageContract } from './conversation-page-contract.js';
export { verifyJournalStoreQueryEdgeContract } from './journal-query-edge-contract.js';
export { verifyJournalStoreUnreadableGetContract } from './journal-unreadable-get-contract.js';
export { verifyJournalStoreHumanActionContract } from './journal-human-action-contract.js';
export { verifyJournalStoreHorizonContract } from './journal-horizon-contract.js';
export { verifyJournalStorePageContract } from './journal-page-contract.js';
export { verifyJournalStoreSearchContract } from './journal-search-contract.js';
export { verifyJournalStoreConversationIdContract } from './journal-conversation-id-contract.js';
export { verifyTranscriptArchiveContract } from './archive-contract.js';
export { verifyTaskStoreContract } from './task-store-contract.js';
export { verifyTaskRemoveForConversationContract } from './task-remove-for-conversation-contract.js';
export { verifyMcpServerStoreContract } from './mcp-server-contract.js';
export { verifyPluginStoreContract } from './plugin-store-contract.js';
export { verifyProfileStoreContract } from './profile-store-contract.js';
export { verifyPermissionGrantStoreContract } from './permission-grant-contract.js';
export { verifyPracticeStoreContract } from './practice-contract.js';
export { verifyListOrderContract } from './list-order-contract.js';
export { verifyApprovalConversationFilterContract } from './approval-conversation-filter-contract.js';
export { verifyStoreIsolationContract } from './store-isolation-contract.js';
export { verifyCredentialVaultContract } from './credential-contract.js';
export { verifyTokenPoolContract } from './token-pool-contract.js';
export { verifyCodexChatgptAuthContract } from './codex-chatgpt-auth-contract.js';
export { verifyUsageNulContract } from './usage-nul-contract.js';
export { verifyUsageRunnerContract } from './usage-runner-contract.js';
export { verifyUsageResetsContract } from './usage-resets-contract.js';
export { verifyUsageQueryContract } from './usage-query-contract.js';
export { verifySessionRegistryNulContract } from './session-registry-nul-contract.js';
export { verifySessionRegistryGraveQueueContract } from './session-registry-grave-queue-contract.js';
export { verifyPersonaNulContract } from './persona-nul-contract.js';
export {
  verifyPersonaWriteContract,
  verifyPersonaIfMatchContract,
  verifyPersonaProtectionStatusContract,
  verifyPersonaCreatedAtContract,
  verifyPersonaDescribedAtContract,
  verifyPersonaDescribedBytesContract,
} from './persona-contract.js';
export type {
  PersonaProtectionStatusHooks,
  PersonaCreatedAtHooks,
  PersonaDescribedBytesHooks,
} from './persona-contract.js';
export { verifyScheduleNulContract } from './schedule-nul-contract.js';
export { verifyScheduleIfMatchContract } from './schedule-if-match-contract.js';
export { verifyScheduleRunContract } from './schedule-run-contract.js';
export { verifyMcpServersIfMatchContract } from './mcp-servers-if-match-contract.js';
export { verifyScheduleUnreadableContract } from './schedule-unreadable-contract.js';
export { verifyJobNulContract } from './job-nul-contract.js';
export { verifyJobStoreContract } from './job-store-contract.js';
export { verifyInboxStoreContract } from './inbox-store-contract.js';
export { verifyAuthNulContract } from './auth-nul-contract.js';
export {
  verifyAuthRecordsContract,
  verifyAuthListOrderContract,
  verifyAuthTieByteOrderContract,
  verifyAuthRevokeAccessTokenContract,
  verifyAuthAccountFieldsContract,
  verifyAuthLoginRequestContract,
  verifyAuthConcurrentWritesContract,
  verifyAuthVerifiedEmailContract,
  verifyAuthLogoutRaceContract,
  verifyAuthWriteValidationContract,
} from './auth-contract.js';
export type { MakeAuthStore } from './auth-contract.js';
export { verifyIntegrationKeyStoreContract } from './integration-key-contract.js';
export { verifyEventReceiptStoreContract } from './event-receipt-contract.js';
export { verifyAttachmentStoreContract } from './attachment-contract.js';
