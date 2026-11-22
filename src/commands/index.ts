import path from 'node:path';
import * as vscode from 'vscode';
import { checkWarnings, compareMarkdown } from '../cli/format';
import type { CompareReport } from '../cli/types';
import type { WabaHost } from '../host';
import { CONFIG_FILE, templateNamesFor, tokenNames, type ProjectConfig } from '../project/config';
import { isValidTokenName } from '../state/tokens';
import { statusFromPreview, type TemplatesTree } from '../tree/templatesTree';
import { runConfirmedDeploy, nameArguments, runPreview, type DeployRequest } from './deploy';
import {
    backupFolder,
    CANCELLED,
    pickBackupSets,
    pickSourceWaba,
    pickStage,
    pickTargetWabas,
    pickTokenName,
    pickWaba,
    readBackupSet,
    stageFor,
    type BackupSet,
} from './pick';

/**
 * File system paths of a command's arguments: explorer (uri, uris[]), editor (uri) or a tree node.
 * @param first first handler argument
 * @param second second handler argument
 * @returns {string[]} selected paths; empty from the Command Palette
 */
export function selectedPaths(first: unknown, second: unknown): string[] {
    if (Array.isArray(second) && second.length > 0) {
        return second
            .map((item) => (item as { fsPath?: unknown }).fsPath)
            .filter((item): item is string => typeof item === 'string');
    }
    const fsPath = (first as { fsPath?: unknown } | undefined)?.fsPath;
    return typeof fsPath === 'string' ? [fsPath] : [];
}

const relative = (config: ProjectConfig, fsPath: string): string =>
    path.relative(config.root, fsPath) || '.';

/**
 * Target of a deploy: the selected target stage and, for a multi-WABA stage, the chosen WABAs.
 * @param host extension services
 * @param config project config
 * @returns {Promise<{target: string[], targetLabel: string, stage: string} | undefined>} arguments and label
 */
async function targetOf(
    host: WabaHost,
    config: ProjectConfig,
): Promise<{ target: string[]; targetLabel: string; stage: string } | undefined> {
    const stage = await stageFor(host, config, 'target');
    if (!stage) {
        return undefined;
    }
    const wabas = await pickTargetWabas(config, stage);
    if (wabas === CANCELLED) {
        return undefined;
    }
    return {
        stage,
        target: ['--to', stage, ...wabas.flatMap((id) => ['--to-waba', id])],
        targetLabel: wabas.length > 0 ? `${stage} (${wabas.join(', ')})` : stage,
    };
}

/**
 * Source arguments of the selected source stage.
 * @param host extension services
 * @param config project config
 * @returns {Promise<string[] | undefined>} `--from` (and `--from-waba`) arguments
 */
async function sourceStageOf(host: WabaHost, config: ProjectConfig): Promise<string[] | undefined> {
    const stage = await stageFor(host, config, 'source');
    if (!stage) {
        return undefined;
    }
    const waba = await pickSourceWaba(config, stage);
    if (waba === CANCELLED) {
        return undefined;
    }
    return ['--from', stage, ...(waba ? ['--from-waba', waba] : [])];
}

/**
 * Template names of a selection, with an error for paths outside the templates folder.
 * @param config project config
 * @param paths selected paths
 * @returns {string[] | undefined} names (`[]` = all)
 */
function namesOf(config: ProjectConfig, paths: string[]): string[] | undefined {
    const names = templateNamesFor(config, paths);
    if (!names) {
        void vscode.window.showErrorMessage(
            `WABA DevTools: select template files or folders inside ${relative(config, config.templatesDir)}.`,
        );
    }
    return names;
}

async function pickCsv(paths: string[]): Promise<string | undefined> {
    const csv = paths.find((item) => item.toLowerCase().endsWith('.csv'));
    if (csv) {
        return csv;
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { CSV: ['csv'] },
        title: 'Select the CSV file',
    });
    return picked?.[0]?.fsPath;
}

async function showCompare(
    host: WabaHost,
    config: ProjectConfig,
    arguments_: string[],
): Promise<void> {
    const outcome = await host.run(config, arguments_, { title: 'Comparing', cancellable: true });
    if (!outcome) {
        return;
    }
    if (outcome.kind === 'error' || outcome.report.command !== 'compare') {
        host.show(outcome, '');
        return;
    }
    const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: compareMarkdown(outcome.report as CompareReport),
    });
    await vscode.window.showTextDocument(document, { preview: false });
}

/**
Discover failures after which the WABA IDs can still be found by hand, and the two of them that
the business portfolio ID can fix.
 */
const DISCOVER_CODES = new Set([
    'TOKEN_INVALID',
    'TOKEN_MISSING_PERMISSION',
    'TOKEN_INFO_REFUSED',
    'BUSINESS_ID_REQUIRED',
    'BUSINESS_HAS_NO_WABAS',
]);
const NEEDS_BUSINESS = new Set(['TOKEN_INFO_REFUSED', 'BUSINESS_ID_REQUIRED']);
const MANUAL = 'Enter WABA IDs Manually';
const RETRY = 'Retry with Portfolio ID';

/**
 * Run `discover` for a token. When Meta cannot list the WABAs, offer the two ways on: the
 * portfolio ID (`--business`), or typing the WABA IDs into `.wabadevrc.json` by hand.
 * @param host extension services
 * @param config project config
 * @param name token variable name
 * @param isBusinessRequired ask for the portfolio ID as required (retry) instead of optional
 * @returns {Promise<void>} resolves when done
 */
async function discover(
    host: WabaHost,
    config: ProjectConfig,
    name: string,
    isBusinessRequired: boolean,
): Promise<void> {
    // Meta does not name the WABAs of a system-user token, so the CLI may need the portfolio.
    const business = await vscode.window.showInputBox({
        title: isBusinessRequired ? 'Business portfolio ID' : 'Business portfolio ID (optional)',
        prompt: `Meta Business settings: the number after business_id= in the address bar.${isBusinessRequired ? '' : ' Leave empty to try without it.'}`,
        placeHolder: 'e.g. 123456789012345',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!/^\d*$/.test(value.trim())) {
                return 'Digits only.';
            }
            return isBusinessRequired && !value.trim() ? 'Enter the portfolio ID.' : undefined;
        },
    });
    if (business === undefined) {
        return;
    }
    const businessId = business.trim();
    const outcome = await host.run(
        config,
        ['discover', '--token-env', name, ...(businessId ? ['--business', businessId] : [])],
        { title: 'Discovering WABAs', cancellable: true, extraTokenNames: [name] },
    );
    if (!outcome) {
        return;
    }
    if (outcome.kind !== 'error' || !outcome.code || !DISCOVER_CODES.has(outcome.code)) {
        host.show(outcome, 'WABAs listed in the output.');
        host.output.show(true);
        return;
    }
    host.output.appendLine(`Error: ${outcome.message}`);
    const buttons = !businessId && NEEDS_BUSINESS.has(outcome.code) ? [RETRY, MANUAL] : [MANUAL];
    const answer = await vscode.window.showErrorMessage(
        `WABA DevTools: ${outcome.message}`,
        ...buttons,
    );
    if (answer === RETRY) {
        await discover(host, config, name, true);
    } else if (answer === MANUAL) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(config.root, CONFIG_FILE)));
        void vscode.window.showInformationMessage(
            'WABA DevTools: Business settings → Accounts → Messaging accounts shows each WABA as "ID: …" under its name. Put it into wabaId and the name of its token variable into tokenEnv (one token per business portfolio).',
        );
    }
}

/**
 * Register every command.
 * @param host extension services
 * @param tree templates tree (status refresh)
 * @returns {vscode.Disposable[]} registrations
 */
export function registerCommands(host: WabaHost, tree: TemplatesTree): vscode.Disposable[] {
    const register = (
        id: string,
        handler: (config: ProjectConfig, paths: string[]) => Promise<unknown>,
    ): vscode.Disposable =>
        vscode.commands.registerCommand(`waba-devtools.${id}`, async (first, second) => {
            const paths = selectedPaths(first, second);
            const config = await host.project(paths[0]);
            if (config) {
                await handler(config, paths);
            }
        });

    const refreshStatus = async (config: ProjectConfig): Promise<void> => {
        const target = await targetOf(host, config);
        if (!target) {
            return;
        }
        const report = await runPreview(host, { config, source: [], names: [], ...target });
        if (report) {
            tree.setStatus(statusFromPreview(target.targetLabel, report));
        }
    };

    return [
        register('check', async (config) => {
            host.output.appendLine('');
            host.output.appendLine('Token variables:');
            const sources = await host.tokens.sources(config.root, tokenNames(config));
            for (const [name, source] of sources) {
                host.output.appendLine(`  ${name}: ${source}`);
            }
            const outcome = await host.run(config, ['check'], {
                title: 'Checking access',
                cancellable: true,
            });
            if (!outcome) {
                return;
            }
            const warnings =
                outcome.kind === 'report' && outcome.report.command === 'check'
                    ? checkWarnings(outcome.report)
                    : [];
            host.show(outcome, 'every WABA is reachable.', warnings);
        }),
        register('discover', async (config) => {
            const name = await pickTokenName(config, 'Which token variable should discover use?');
            if (name) {
                await discover(host, config, name, false);
            }
        }),
        register('list', async (config) => {
            const stage = await pickStage(
                config,
                'List the templates of which stage?',
                host.selectedStage(config, 'target'),
            );
            if (!stage) {
                return;
            }
            const outcome = await host.run(config, ['list', '--to', stage], {
                title: `Listing ${stage}`,
                cancellable: true,
            });
            if (!outcome) {
                return;
            }

            host.show(outcome, 'templates listed in the output.');
            host.output.show(true);
        }),
        register('retrieve', async (config, paths) => {
            const names = namesOf(config, paths);
            const source = names && (await sourceStageOf(host, config));
            if (!names || !source) {
                return;
            }
            const outcome = await host.run(
                config,
                ['retrieve', ...source, ...nameArguments(names)],
                { title: `Retrieving from ${source[1]}`, cancellable: true },
            );
            host.notifyChanged();
            if (outcome) {
                host.show(outcome, `retrieved from ${source[1]}.`);
            }
        }),
        register('importCsv', async (config, paths) => {
            const csv = await pickCsv(paths);
            if (!csv) {
                return;
            }
            const outcome = await host.run(config, ['import', '--csv', relative(config, csv)], {
                title: 'Importing CSV',
                cancellable: true,
            });
            host.notifyChanged();
            if (outcome) {
                host.show(outcome, `imported ${path.basename(csv)}.`);
            }
        }),
        register('deployPreview', async (config, paths) => {
            const names = namesOf(config, paths);
            const target = names && (await targetOf(host, config));
            if (!names || !target) {
                return;
            }
            const report = await runPreview(host, { config, source: [], names, ...target });
            if (!report) {
                return;
            }

            if (names.length === 0) {
                tree.setStatus(statusFromPreview(target.targetLabel, report));
            }
            host.output.show(true);
        }),
        register('deploy', async (config, paths) => {
            const names = namesOf(config, paths);
            const target = names && (await targetOf(host, config));
            if (names && target) {
                await runConfirmedDeploy(host, { config, source: [], names, ...target });
            }
        }),
        register('deployFromStage', async (config) => {
            const source = await sourceStageOf(host, config);
            const target = source && (await targetOf(host, config));
            if (source && target) {
                await runConfirmedDeploy(host, { config, source, names: [], ...target });
            }
        }),
        register('deployCsv', async (config, paths) => {
            const csv = await pickCsv(paths);
            const target = csv && (await targetOf(host, config));
            if (csv && target) {
                await runConfirmedDeploy(host, {
                    config,
                    source: ['--csv', relative(config, csv)],
                    names: [],
                    ...target,
                });
            }
        }),
        register('deployPrune', async (config) => {
            const files = `Template files (${relative(config, config.templatesDir)})`;
            const choice = await vscode.window.showQuickPick(
                [files, 'The WABA of the source stage'],
                {
                    title: 'Prune: the target will match this source exactly (extra templates are deleted)',
                },
            );
            if (!choice) {
                return;
            }
            const source = choice === files ? [] : await sourceStageOf(host, config);
            const target = source && (await targetOf(host, config));
            if (source && target) {
                await runConfirmedDeploy(host, {
                    config,
                    source,
                    names: [],
                    prune: true,
                    ...target,
                });
            }
        }),
        register('restore', async (config, paths) => {
            let set: BackupSet | undefined;
            if (paths[0]) {
                set = await readBackupSet(paths[0]);
                if (!set) {
                    void vscode.window.showErrorMessage(
                        'WABA DevTools: this folder is not a backup set (no manifest.json).',
                    );
                    return;
                }
            } else {
                set = (await pickBackupSets(config, 'Restore which backup set?', 1))?.[0];
            }
            if (!set) {
                return;
            }
            const wabaId = await pickWaba(config, 'Restore into which WABA?', set.wabaId);
            if (!wabaId) {
                return;
            }
            const request: DeployRequest = {
                config,
                source: ['--from-dir', relative(config, set.fsPath)],
                target: ['--to-waba', wabaId],
                targetLabel: `WABA ${wabaId}`,
                names: [],
            };
            await runConfirmedDeploy(host, request);
        }),
        register('backup', async (config) => {
            const stage = await pickStage(
                config,
                'Create a restore point of which stage?',
                host.selectedStage(config, 'target'),
            );
            const wabas = stage && (await pickTargetWabas(config, stage));
            if (!stage || !wabas || wabas === CANCELLED) {
                return;
            }
            const outcome = await host.run(
                config,
                [
                    'backup',
                    '--stage',
                    stage,
                    ...wabas.flatMap((id) => ['--waba', id]),
                    '--backup',
                    relative(config, backupFolder(config)),
                ],
                { title: `Saving a restore point of ${stage}`, cancellable: true },
            );
            if (outcome) {
                host.show(outcome, `restore point of ${stage} saved.`);
            }
        }),
        register('compareBackups', async (config, paths) => {
            const first = paths[0] ? await readBackupSet(paths[0]) : undefined;
            const sets = first
                ? [
                      first,
                      ...((await pickBackupSets(
                          config,
                          'Compare with which backup set?',
                          1,
                          first.fsPath,
                      )) ?? []),
                  ]
                : await pickBackupSets(config, 'Pick two backup sets to compare', 2);
            if (!sets || sets.length !== 2) {
                return;
            }
            await showCompare(host, config, [
                'compare',
                relative(config, sets[0].fsPath),
                relative(config, sets[1].fsPath),
            ]);
        }),
        register('compareLive', async (config, paths) => {
            const set = paths[0]
                ? await readBackupSet(paths[0])
                : (await pickBackupSets(config, 'Compare which backup set with live?', 1))?.[0];
            if (!set) {
                return;
            }
            const wabaId = await pickWaba(config, 'Compare with which WABA right now?', set.wabaId);
            if (!wabaId) {
                return;
            }
            await showCompare(host, config, [
                'compare',
                relative(config, set.fsPath),
                '--live',
                ...(wabaId === set.wabaId ? [] : ['--waba', wabaId]),
            ]);
        }),
        register('compareWabas', async (config) => {
            const before = await pickWaba(config, 'Compare two WABAs: which one is "before"?');
            const after =
                before && (await pickWaba(config, `"before" = ${before}. Which one is "after"?`));
            if (before && after) {
                await showCompare(host, config, [
                    'compare',
                    '--before-waba',
                    before,
                    '--after-waba',
                    after,
                ]);
            }
        }),
        register('selectSourceStage', async (config) => {
            const stage = await pickStage(
                config,
                'Select the source stage',
                host.selectedStage(config, 'source'),
            );
            if (stage) {
                await host.setStage(config, 'source', stage);
            }
        }),
        register('selectTargetStage', async (config) => {
            const stage = await pickStage(
                config,
                'Select the target stage',
                host.selectedStage(config, 'target'),
            );
            if (!stage) {
                return;
            }

            await host.setStage(config, 'target', stage);
            tree.setStatus(undefined);
        }),
        register('selectStages', async () => {
            const side = await vscode.window.showQuickPick(
                [
                    { label: 'Select source stage', id: 'waba-devtools.selectSourceStage' },
                    { label: 'Select target stage', id: 'waba-devtools.selectTargetStage' },
                ],
                { title: 'WABA DevTools stages' },
            );
            if (side) {
                await vscode.commands.executeCommand(side.id);
            }
        }),
        register('setToken', async (config) => {
            const name = await pickTokenName(config, 'Store the access token for which variable?');
            if (!name || !isValidTokenName(name)) {
                return;
            }
            const source = (await host.tokens.sources(config.root, [name])).get(name);
            if (source === 'environment' || source === '.env') {
                const answer = await vscode.window.showWarningMessage(
                    `${name} is already set in ${source === '.env' ? 'the project .env file' : 'the environment'}, which wins over a stored token. Store it anyway?`,
                    { modal: true },
                    'Store',
                );
                if (answer !== 'Store') {
                    return;
                }
            }
            const token = await vscode.window.showInputBox({
                title: `Access token for ${name}`,
                prompt: 'Stored in VS Code SecretStorage. Passed to wabadev only as this environment variable.',
                password: true,
                ignoreFocusOut: true,
            });
            if (!token?.trim()) {
                return;
            }

            await host.tokens.set(name, token.trim());
            void vscode.window.showInformationMessage(`WABA DevTools: token for ${name} stored.`);
        }),
        register('removeToken', async (config) => {
            const stored: string[] = [];
            for (const name of tokenNames(config)) {
                if (await host.tokens.has(name)) {
                    stored.push(name);
                }
            }
            const name = await pickTokenName(
                config,
                'Remove the stored token of which variable?',
                stored,
            );
            if (!name) {
                return;
            }

            await host.tokens.remove(name);
            void vscode.window.showInformationMessage(
                `WABA DevTools: stored token for ${name} removed.`,
            );
        }),
        register('refreshStatus', async (config) => {
            tree.refresh();
            await refreshStatus(config);
        }),
    ];
}
