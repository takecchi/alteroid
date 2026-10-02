/**
 * マネージャー層の provider の表示（#486 S9）。正本は core の
 * `manager-provider-format.ts`（クローンの道具・CLI・Web UI の3面が同じ字面を読む。
 * `mask-url.ts` と同じ形）。
 */
export {
  describeManagerProvider,
  MANAGER_PROVIDER_UNKNOWN_LABEL,
} from '@alteroid/core/manager-provider-format';
