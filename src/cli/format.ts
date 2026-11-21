import type {
    BackupReport,
    CheckReport,
    CompareReport,
    DeployReport,
    DiscoverReport,
    FileResult,
    ImportReport,
    ListReport,
    Report,
    RetrieveReport,
    RowError,
} from './types';

function where(wabaId: string, stage?: string): string {
    return `WABA ${wabaId}${stage ? ` (${stage})` : ''}`;
}

function files(list: FileResult[]): string[] {
    return (list ?? []).map((file) => `  ${file.result.padEnd(9)} ${file.path}`);
}

function rowErrors(list: RowError[] | undefined): string[] {
    return (list ?? []).map((row) => `  CSV row ${row.row ?? '?'}: ${row.message}`);
}

function deploy(report: DeployReport): string[] {
    const lines = [
        report.dryRun ? 'Deploy preview (nothing sent):' : 'Deploy:',
        ...rowErrors(report.rowErrors),
    ];
    const targets = report.targets ?? [];
    for (const target of targets) {
        lines.push(where(target.wabaId, target.stage));
        if (target.error) {
            lines.push(`  ERROR: ${target.error}`);
        }
        const actions = target.actions ?? [];
        for (const action of actions) {
            const parts = [
                `  ${action.action.padEnd(9)} ${action.name} (${action.language})`,
                action.status ? `status ${action.status}` : '',
                action.result ? `→ ${action.result}` : '',
                action.error ? `— ${action.error}` : action.note ? `— ${action.note}` : '',
            ];
            lines.push(parts.filter(Boolean).join('  '));
        }
        if (target.backup) {
            lines.push(`  backup: ${target.backup}`);
        }
        if (target.backupAfter) {
            lines.push(`  backup after: ${target.backupAfter}`);
        }
        if (target.backupAfterError) {
            lines.push(`  WARNING: ${target.backupAfterError}`);
        }
    }
    return lines;
}

function check(report: CheckReport): string[] {
    return [
        'Access check:',
        ...(report.entries ?? []).map(
            (entry) =>
                `  ${entry.ok ? 'OK    ' : 'FAILED'} ${where(entry.wabaId, entry.stage)} ${entry.wabaName ?? ''} [${entry.tokenEnv}]${entry.error ? ` — ${entry.error}` : ''}`,
        ),
    ];
}

function list(report: ListReport): string[] {
    const lines: string[] = [];
    const wabas = report.wabas ?? [];
    for (const waba of wabas) {
        lines.push(where(waba.wabaId, waba.stage));
        if (waba.error) {
            lines.push(`  ERROR: ${waba.error}`);
        }
        const templates = waba.templates ?? [];
        for (const template of templates) {
            lines.push(
                `  ${template.name} (${template.language})  ${template.category ?? ''}  ${template.status ?? ''}`,
            );
        }
    }
    return lines;
}

function discover(report: DiscoverReport): string[] {
    return (report.wabas ?? []).map((waba) => {
        const phones = (waba.phoneNumbers ?? [])
            .map((phone) => `${phone.displayPhoneNumber ?? ''} (${phone.verifiedName ?? ''})`)
            .join(', ');
        return `  WABA ${waba.wabaId}  ${waba.name ?? ''}  ${phones}${waba.error ? ` — ${waba.error}` : ''}`;
    });
}

function backup(report: BackupReport): string[] {
    return (report.sets ?? []).map((set) =>
        set.error
            ? `  ${where(set.wabaId, set.stage)}: ERROR ${set.error}`
            : `  ${where(set.wabaId, set.stage)}: ${set.templateCount ?? 0} templates → ${set.backup ?? ''}`,
    );
}

/**
 * Plain-text lines of any report, for the output channel.
 * @param report a parsed `--json` report
 * @returns {string[]} lines
 */
export function formatReport(report: Report): string[] {
    switch (report.command) {
        case 'deploy': {
            return deploy(report);
        }
        case 'retrieve': {
            const retrieve = report as RetrieveReport;
            return [
                `Retrieved from ${where(retrieve.wabaId, retrieve.stage)}:`,
                ...files(retrieve.files),
            ];
        }
        case 'import': {
            const imported = report as ImportReport;
            return [
                `Imported ${imported.csv}:`,
                ...files(imported.files),
                ...rowErrors(imported.rowErrors),
            ];
        }
        case 'check': {
            return check(report);
        }
        case 'list': {
            return list(report);
        }
        case 'discover': {
            return ['WABAs this token can reach:', ...discover(report)];
        }
        case 'backup': {
            return ['Restore points:', ...backup(report)];
        }
        case 'compare': {
            return compareMarkdown(report).split('\n');
        }
    }
}

function side(label: string, info: CompareReport['before']): string {
    const what =
        info.phase === 'live' ? 'live now' : `backup ${info.createdAt ?? ''} ${info.phase ?? ''}`;
    return `- **${label}:** ${where(info.wabaId, info.stage)} — ${what}`;
}

function value(text: unknown): string {
    if (text === undefined) {
        return '—';
    }
    const string = typeof text === 'string' ? text : JSON.stringify(text);
    return `\`${string.replaceAll('`', "'").replaceAll('\n', '⏎')}\``;
}

/**
 * Markdown document of a compare report.
 * @param report a `compare --json` report
 * @returns {string} Markdown
 */
export function compareMarkdown(report: CompareReport): string {
    const lines = [
        '# WABA template compare',
        '',
        side('Before', report.before),
        side('After', report.after),
        '',
    ];
    const section = (title: string, items: CompareReport['added']): void => {
        lines.push(`## ${title} (${items.length})`, '');
        for (const item of items) {
            lines.push(
                `- ${item.name} (${item.language})${item.status ? ` — ${item.status}` : ''}`,
            );
        }
        lines.push('');
    };
    section('Added', report.added);
    section('Removed', report.removed);
    lines.push(`## Changed (${report.changed.length})`, '');
    for (const item of report.changed) {
        lines.push(`### ${item.name} (${item.language})`, '');
        for (const change of item.changes) {
            lines.push(
                `- **${change.field}**`,
                `  - before: ${value(change.before)}`,
                `  - after: ${value(change.after)}`,
            );
        }
        lines.push('');
    }
    lines.push(`Unchanged: ${report.unchanged}`, '');
    return lines.join('\n');
}
