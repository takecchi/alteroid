// 他の import を持たない: manager-activity.ts は apps/web からも import されるため、runner.ts（Node 専用）を巻き込むとブラウザのバンドルが壊れる
export function isDaemonAnsweredTool(name: string): boolean {
  return name === 'AskUserQuestion';
}
