import type { DeployAction, DeployReport } from './types';

const SENDING = new Set(['create', 'update', 'delete']);

export interface PreviewSummary {
    creates: number;
    updates: number;
    deletes: number;
    /**
    Blocked, skipped and target errors: shown, never sent.
     */
    problems: string[];
    /**
    One line per WABA and sent template, for the confirmation dialog.
     */
    lines: string[];
}

function label(action: DeployAction): string {
    return `${action.name} (${action.language})`;
}

/**
 * Summarize a preview for the confirmation dialog.
 * @param report a `deploy --dry-run` report
 * @returns {PreviewSummary} counts, problems and per-template lines
 */
export function summarizePreview(report: DeployReport): PreviewSummary {
    const summary: PreviewSummary = { creates: 0, updates: 0, deletes: 0, problems: [], lines: [] };
    const rows = report.rowErrors ?? [];
    for (const row of rows) {
        summary.problems.push(`CSV row ${row.row ?? '?'}: ${row.message}`);
    }
    for (const target of report.targets) {
        const where = `WABA ${target.wabaId}${target.stage ? ` (${target.stage})` : ''}`;
        if (target.error) {
            summary.problems.push(`${where}: ${target.error}`);
            continue;
        }
        const sending = target.actions.filter((action) => SENDING.has(action.action));
        summary.lines.push(sending.length > 0 ? `${where}:` : `${where}: nothing to send`);
        for (const action of sending) {
            summary.lines.push(`  ${action.action} ${label(action)}`);
            if (action.action === 'create') {
                summary.creates++;
            } else if (action.action === 'update') {
                summary.updates++;
            } else {
                summary.deletes++;
            }
        }
        for (const action of target.actions) {
            if (action.action === 'blocked' || action.action === 'skipped') {
                summary.problems.push(
                    `${where}: ${action.action} ${label(action)}${action.note ? ` — ${action.note}` : ''}`,
                );
            }
        }
    }
    return summary;
}
