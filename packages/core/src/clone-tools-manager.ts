// マネージャーへの委譲（manager_start / manager_send / manager_stop / manager_list / manager_report）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { managerStartTool } from './clone-tools-manager-start.js';
import { managerSendTool } from './clone-tools-manager-send.js';
import { managerStopTool } from './clone-tools-manager-stop.js';
import { managerListTool } from './clone-tools-manager-list.js';
import { managerReportTool } from './clone-tools-manager-report.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

export function managerTools(context: ToolContext, shared: CloneToolsShared) {
  return [
    managerStartTool(context, shared),
    managerSendTool(context, shared.stores),
    managerStopTool(context),
    managerListTool(context),
    managerReportTool(context),
  ];
}
