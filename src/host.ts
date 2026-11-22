import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { interpretResult, type Outcome } from './cli/result';
import { formatReport } from './cli/format';
import { CONFIG_FILE, readProjectConfig, tokenNames, type ProjectConfig } from './project/config';
import { CliCancelledError, resolveRuntime, RuntimeError, runCli } from './runtime';
import { TokenStore } from './state/tokens';

export const PROJECT_CONTEXT_KEY = 'waba-devtools.project';
const STAGE_KEY = 'waba-devtools.stages';

export interface RunOptions {
    /**
    Progress notification title.
     */
    title: string;
    /**
    Whether the user may cancel (never for runs that send to Meta).
     */
    cancellable?: boolean;
    /**
    Token variable names beyond the config's (e.g. `discover --token-env`).
     */
    extraTokenNames?: string[];
}

interface StoredStages {
    source?: string;
    target?: string;
}

async function isFile(filename: string): Promise<boolean> {
    try {
        return (await stat(filename)).isFile();
    } catch {
        return false;
    }
}

/**
 * Shared services of the extension: the project, the output channel, tokens, the selected
 * stages with their status-bar item, and running the CLI.
 */
export class WabaHost implements vscode.Disposable {
    private readonly statusItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        50,
    );
    private readonly changed = new vscode.EventEmitter<void>();
    private roots: string[] = [];
    private chosenRoot: string | undefined;
    readonly output = vscode.window.createOutputChannel('WABA DevTools');
    readonly tokens: TokenStore;
    /**
    Fires after files or remote state may have changed (retrieve, import, deploy).
     */
    readonly onDidChange = this.changed.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.tokens = new TokenStore(context.secrets);
        this.statusItem.command = 'waba-devtools.selectStages';
        this.statusItem.tooltip = 'WABA DevTools: source → target stage (click to change)';
    }

    private storedStages(root: string): StoredStages {
        return (
            this.context.workspaceState.get<Record<string, StoredStages>>(STAGE_KEY, {})[root] ?? {}
        );
    }

    private async updateStatus(): Promise<void> {
        const root = this.chosenRoot ?? (this.roots.length === 1 ? this.roots[0] : undefined);
        if (!root) {
            if (this.roots.length > 0) {
                this.statusItem.text = '$(arrow-swap) WABA';
                this.statusItem.show();
            } else {
                this.statusItem.hide();
            }
            return;
        }
        const config = await readProjectConfig(root);
        const source = this.selectedStage(config, 'source') ?? '—';
        const target = this.selectedStage(config, 'target') ?? '—';
        this.statusItem.text = `$(arrow-swap) WABA: ${source} → ${target}`;
        this.statusItem.show();
    }

    private async notify(level: 'error' | 'warning', text: string): Promise<void> {
        const show =
            level === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
        if ((await show(`WABA DevTools: ${text}`, 'Show Output')) === 'Show Output') {
            this.output.show(true);
        }
    }

    dispose(): void {
        this.output.dispose();
        this.statusItem.dispose();
        this.changed.dispose();
    }

    notifyChanged(): void {
        this.changed.fire();
    }

    /**
     * Find the workspace folders holding `.wabadevrc.json` and update the context key and
     * status bar.
     * @returns {Promise<string[]>} the project roots
     */
    async refreshRoots(): Promise<string[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const roots: string[] = [];
        for (const folder of folders) {
            if (await isFile(path.join(folder.uri.fsPath, CONFIG_FILE))) {
                roots.push(folder.uri.fsPath);
            }
        }
        this.roots = roots;
        if (this.chosenRoot && !roots.includes(this.chosenRoot)) {
            this.chosenRoot = undefined;
        }
        await vscode.commands.executeCommand('setContext', PROJECT_CONTEXT_KEY, roots.length > 0);
        await this.updateStatus();
        return roots;
    }

    /**
     * The project shown without asking (tree view): the chosen one, else the first.
     * @returns {string | undefined} project root
     */
    defaultRoot(): string | undefined {
        return this.chosenRoot ?? this.roots[0];
    }

    /**
     * The project to work on: the only one, the one containing `hint`, or a pick.
     * @param hint a selected file or folder
     * @returns {Promise<ProjectConfig | undefined>} the config, or `undefined` when none/cancelled
     */
    async project(hint?: string): Promise<ProjectConfig | undefined> {
        if (this.roots.length === 0) {
            await this.refreshRoots();
        }
        let root = hint
            ? this.roots.find((candidate) => {
                  const relative = path.relative(candidate, hint);
                  return !relative.startsWith('..') && !path.isAbsolute(relative);
              })
            : undefined;
        if (!root && this.roots.length === 1) {
            root = this.roots[0];
        }
        if (!root && this.chosenRoot) {
            root = this.chosenRoot;
        }
        if (!root && this.roots.length > 1) {
            root = await vscode.window.showQuickPick(this.roots, {
                title: 'WABA DevTools: which project?',
            });
            this.chosenRoot = root;
        }
        if (!root) {
            if (this.roots.length === 0) {
                void vscode.window.showErrorMessage(
                    `WABA DevTools: no ${CONFIG_FILE} in the workspace folders.`,
                );
            }
            return undefined;
        }
        return readProjectConfig(root);
    }

    /**
     * The selected source or target stage of a project, if it still exists in the config.
     * @param config project config
     * @param side source or target
     * @returns {string | undefined} the stage name
     */
    selectedStage(config: ProjectConfig, side: 'source' | 'target'): string | undefined {
        const stage = this.storedStages(config.root)[side];
        return stage && Object.hasOwn(config.stages, stage) ? stage : undefined;
    }

    async setStage(config: ProjectConfig, side: 'source' | 'target', stage: string): Promise<void> {
        const all = this.context.workspaceState.get<Record<string, StoredStages>>(STAGE_KEY, {});
        all[config.root] = { ...all[config.root], [side]: stage };
        await this.context.workspaceState.update(STAGE_KEY, all);
        await this.updateStatus();
        this.changed.fire();
    }

    /**
     * Run wabadev with `--json` in the project root and interpret the result. Runtime problems and
     * cancellation are reported here and return `undefined`.
     * @param config project config
     * @param cliArguments arguments without `--json`
     * @param options progress title, cancellability, extra token names
     * @returns {Promise<Outcome | undefined>} report or error, `undefined` when it did not run
     */
    async run(
        config: ProjectConfig,
        cliArguments: string[],
        options: RunOptions,
    ): Promise<Outcome | undefined> {
        let runtime;
        try {
            runtime = await resolveRuntime(config.root);
        } catch (ex) {
            const message = ex instanceof RuntimeError ? ex.message : String(ex);
            const action = await vscode.window.showErrorMessage(message, 'Open Settings');
            if (action) {
                void vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'waba-devtools.cliSource',
                );
            }
            return undefined;
        }
        const environment = await this.tokens.childEnvironment(config.root, [
            ...tokenNames(config),
            ...(options.extraTokenNames ?? []),
        ]);
        const arguments_ = [...cliArguments, '--json'];
        this.output.appendLine('');
        this.output.appendLine(
            `> wabadev ${arguments_.join(' ')}   (${runtime.source} ${runtime.cliVersion})`,
        );
        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `WABA DevTools: ${options.title}`,
                    cancellable: options.cancellable ?? false,
                },
                (_progress, token) =>
                    runCli(runtime, arguments_, {
                        cwd: config.root,
                        env: environment,
                        token,
                        onStderr: (line) => this.output.appendLine(line),
                    }),
            );
            return interpretResult(result);
        } catch (ex) {
            if (ex instanceof CliCancelledError) {
                this.output.appendLine('Cancelled.');
                return undefined;
            }
            void vscode.window.showErrorMessage(`WABA DevTools: ${(ex as Error).message}`);
            return undefined;
        }
    }

    /**
     * Write a report to the output channel and show a short notification.
     * @param outcome the interpreted run
     * @param success notification text when the report is ok
     * @param warnings shown as a warning notification instead of `success` when the report is ok
     * @returns {boolean} true when it was a report with `ok: true`
     */
    show(outcome: Outcome, success: string, warnings: string[] = []): boolean {
        if (outcome.kind === 'error') {
            this.output.appendLine(`Error: ${outcome.message}`);
            void this.notify('error', outcome.message);
            return false;
        }
        for (const line of formatReport(outcome.report)) {
            this.output.appendLine(line);
        }
        if (outcome.report.ok && warnings.length > 0) {
            void this.notify('warning', warnings.join(' '));
            return true;
        }
        if (outcome.report.ok) {
            void vscode.window.showInformationMessage(`WABA DevTools: ${success}`);
            return true;
        }
        void this.notify('warning', 'finished with problems — see the output for details.');
        return false;
    }
}
