import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { summarizePreview } from '../cli/deployPlan';
import { formatReport } from '../cli/format';
import type { DeployReport } from '../cli/types';
import type { WabaHost } from '../host';
import type { ProjectConfig } from '../project/config';
import { backupFolder } from './pick';

export interface DeployRequest {
    config: ProjectConfig;
    /**
    Source arguments: `[]` (template files), `--from …`, `--csv …` or `--from-dir …`.
     */
    source: string[];
    /**
    Target arguments: `--to …` and/or `--to-waba …`.
     */
    target: string[];
    /**
    Human label of the target for the dialog, e.g. `qa` or `WABA 444…`.
     */
    targetLabel: string;
    /**
    `-m` template names; empty = all.
     */
    names: string[];
    prune?: boolean;
}

/**
 * The `-m` arguments for template names.
 * @param names template names
 * @returns {string[]} arguments
 */
export function nameArguments(names: string[]): string[] {
    return names.flatMap((name) => ['-m', name]);
}

/**
 * Preview arguments. Always `--dry-run`: `--prune` without `--yes` would still send creates and
 * updates live, so a preview never runs without it.
 * @param request deploy request
 * @returns {string[]} CLI arguments without `--json`
 */
export function previewArguments(request: DeployRequest): string[] {
    return [
        'deploy',
        ...request.source,
        ...request.target,
        ...nameArguments(request.names),
        ...(request.prune ? ['--prune'] : []),
        '--dry-run',
    ];
}

/**
 * Arguments of the confirmed run: the backup setting applied, and `--expect` with the confirmed
 * preview so the CLI sends exactly that or nothing for a WABA that changed since.
 * @param request deploy request
 * @param backup value of `waba-devtools.deployBackup`
 * @param folder backup folder relative to the project
 * @param expectFile file holding the confirmed preview's `--json` report
 * @returns {string[]} CLI arguments without `--json`
 */
export function sendArguments(
    request: DeployRequest,
    backup: string,
    folder: string,
    expectFile: string,
): string[] {
    const backupArguments =
        backup === 'none'
            ? []
            : ['--backup', folder, ...(backup === 'beforeAndAfter' ? ['--backup-after'] : [])];
    return [
        'deploy',
        ...request.source,
        ...request.target,
        ...nameArguments(request.names),
        ...(request.prune ? ['--prune', '--yes'] : []),
        ...backupArguments,
        '--expect',
        expectFile,
    ];
}

/**
 * Run `task` with the preview written to a fresh file in the OS temp folder; the file and its
 * folder are removed afterwards.
 * @param preview the confirmed preview report
 * @param task receives the file path
 * @returns {Promise<T>} the task's result
 */
async function withExpectFile<T>(
    preview: DeployReport,
    task: (file: string) => Promise<T>,
): Promise<T> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'waba-expect-'));
    const file = path.join(folder, 'preview.json');
    try {
        await writeFile(file, JSON.stringify(preview));
        return await task(file);
    } finally {
        await rm(file, { force: true });
        await rmdir(folder);
    }
}

/**
 * Run a preview and return its deploy report (also written to the output).
 * @param host extension services
 * @param request deploy request
 * @returns {Promise<DeployReport | undefined>} the report, `undefined` after an error (already shown)
 */
export async function runPreview(
    host: WabaHost,
    request: DeployRequest,
): Promise<DeployReport | undefined> {
    const outcome = await host.run(request.config, previewArguments(request), {
        title: `Preview deploy to ${request.targetLabel}`,
        cancellable: true,
    });
    if (!outcome) {
        return undefined;
    }
    if (outcome.kind === 'error' || outcome.report.command !== 'deploy') {
        host.show(outcome, '');
        return undefined;
    }
    for (const line of formatReport(outcome.report)) {
        host.output.appendLine(line);
    }
    return outcome.report;
}

/**
 * Preview, confirm in a modal dialog, then send exactly the confirmed preview (`--expect`).
 * Nothing is sent when the dialog is dismissed; a WABA that changed since the preview gets
 * nothing and reports "changed since preview".
 * @param host extension services
 * @param request deploy request
 * @returns {Promise<void>} resolves when done; results are shown to the user
 */
export async function runConfirmedDeploy(host: WabaHost, request: DeployRequest): Promise<void> {
    const preview = await runPreview(host, request);
    if (!preview) {
        return;
    }
    const summary = summarizePreview(preview);
    const total = summary.creates + summary.updates + summary.deletes;
    if (total === 0) {
        const extra =
            summary.problems.length > 0
                ? ` ${summary.problems.length} problem(s), see the output.`
                : '';
        void vscode.window.showInformationMessage(
            `WABA DevTools: nothing to send to ${request.targetLabel}.${extra}`,
        );
        return;
    }
    const counts = [
        `${summary.creates} create`,
        `${summary.updates} update`,
        ...(request.prune ? [`${summary.deletes} DELETE`] : []),
    ].join(', ');
    const setting = vscode.workspace
        .getConfiguration('waba-devtools')
        .get<string>('deployBackup', 'before');
    const folder = path.relative(request.config.root, backupFolder(request.config)) || '.';
    const detail = [
        ...summary.lines,
        ...(summary.problems.length > 0 ? ['', 'Not sent:', ...summary.problems] : []),
        '',
        setting === 'none'
            ? 'No backup is taken (waba-devtools.deployBackup = none).'
            : `A backup of each changed WABA is saved to ${folder} first.`,
        'Meta reviews created and updated templates again.',
    ].join('\n');
    const button =
        request.prune && summary.deletes > 0 ? `Delete ${summary.deletes} and Deploy` : 'Deploy';
    const answer = await vscode.window.showWarningMessage(
        `Deploy to ${request.targetLabel}: ${counts}?`,
        { modal: true, detail },
        button,
    );
    if (answer !== button) {
        host.output.appendLine('Cancelled — nothing was sent.');
        return;
    }
    const outcome = await withExpectFile(preview, (expectFile) =>
        host.run(request.config, sendArguments(request, setting, folder, expectFile), {
            title: `Deploying to ${request.targetLabel}`,
        }),
    );
    host.notifyChanged();
    if (!outcome) {
        return;
    }
    host.show(outcome, `deployed to ${request.targetLabel}.`);
    const isChanged =
        outcome.kind === 'report' &&
        outcome.report.command === 'deploy' &&
        outcome.report.targets.some((target) => target.error?.includes('changed since preview'));
    if (isChanged) {
        void vscode.window.showWarningMessage(
            `WABA DevTools: ${request.targetLabel} changed since the preview — nothing was sent to the changed WABA(s). Run the deploy again to see the new plan.`,
        );
    }
}
