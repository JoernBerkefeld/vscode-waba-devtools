import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { WabaHost } from './host';
import { clearRuntimeCache } from './runtime';
import { TemplatesTree } from './tree/templatesTree';

/**
 * Called by VS Code when the extension activates: finds the projects, registers the tree view
 * and every command.
 * @param context Extension context.
 * @returns {Promise<{templates: TemplatesTree}>} the extension API (used by the host smoke test)
 */
export async function activate(
    context: vscode.ExtensionContext,
): Promise<{ templates: TemplatesTree }> {
    const host = new WabaHost(context);
    const tree = new TemplatesTree(() => host.defaultRoot());
    const configWatcher = vscode.workspace.createFileSystemWatcher('**/.wabadevrc.json');
    const templateWatcher = vscode.workspace.createFileSystemWatcher('**/*.json');
    const runtimeWatcher = vscode.workspace.createFileSystemWatcher(
        '**/node_modules/waba-devtools/package.json',
    );
    const refreshRoots = async (): Promise<void> => {
        await host.refreshRoots();
        tree.refresh();
    };
    context.subscriptions.push(
        host,
        vscode.window.registerTreeDataProvider('waba-devtools.templates', tree),
        ...registerCommands(host, tree),
        configWatcher,
        templateWatcher,
        runtimeWatcher,
        configWatcher.onDidCreate(refreshRoots),
        configWatcher.onDidDelete(refreshRoots),
        configWatcher.onDidChange(refreshRoots),
        templateWatcher.onDidCreate(() => tree.refresh()),
        templateWatcher.onDidDelete(() => tree.refresh()),
        runtimeWatcher.onDidCreate(clearRuntimeCache),
        runtimeWatcher.onDidDelete(clearRuntimeCache),
        host.onDidChange(() => tree.refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(refreshRoots),
    );
    await refreshRoots();
    return { templates: tree };
}

/**
 * Called by VS Code when the extension deactivates; disposables are released via the context.
 */
export function deactivate(): void {
    // Everything is registered on context.subscriptions.
}
