import { readdir } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { DeployReport } from '../cli/types';
import { readProjectConfig } from '../project/config';

export interface TemplateNode {
    kind: 'template';
    name: string;
    fsPath: string;
}

export interface LanguageNode {
    kind: 'language';
    name: string;
    language: string;
    fsPath: string;
}

export interface ExtrasNode {
    kind: 'extras';
    stage: string;
}

export interface ExtraNode {
    kind: 'extra';
    name: string;
    language: string;
    wabaIds: string[];
}

export type TreeNode = TemplateNode | LanguageNode | ExtrasNode | ExtraNode;

interface WabaStatus {
    wabaId: string;
    action: string;
    status?: string;
}

/**
Last known state of one target stage, from a `deploy --dry-run` of the template files.
 */
export interface StageStatus {
    stage: string;
    byTemplate: Map<string, WabaStatus[]>;
    /**
    Templates that exist only in the target WABAs.
     */
    extras: Map<string, ExtraNode>;
}

const key = (name: string, language: string): string => `${name}::${language}`;

/**
 * Turn a preview of the full template set into per-template status.
 * @param stage target stage of the preview
 * @param report the `deploy --dry-run` report
 * @returns {StageStatus} status per template and the target-only templates
 */
export function statusFromPreview(stage: string, report: DeployReport): StageStatus {
    const byTemplate = new Map<string, WabaStatus[]>();
    const extras = new Map<string, ExtraNode>();
    for (const target of report.targets) {
        for (const action of target.actions) {
            const id = key(action.name, action.language);
            if (action.action === 'extra' || action.action === 'delete') {
                const node = extras.get(id) ?? {
                    kind: 'extra',
                    name: action.name,
                    language: action.language,
                    wabaIds: [],
                };
                node.wabaIds.push(target.wabaId);
                extras.set(id, node);
                continue;
            }
            const list = byTemplate.get(id) ?? [];
            list.push({ wabaId: target.wabaId, action: action.action, status: action.status });
            byTemplate.set(id, list);
        }
    }
    return { stage, byTemplate, extras };
}

/**
 * Short description of a template's state in the stage: identical across WABAs → one value,
 * otherwise "mixed".
 * @param stage stage name
 * @param list per-WABA status
 * @returns {string} e.g. `qa: APPROVED · unchanged`
 */
export function describeStatus(stage: string, list: WabaStatus[] | undefined): string {
    if (!list || list.length === 0) {
        return '';
    }
    const texts = list.map((item) =>
        [item.status ?? 'not in WABA', item.action].filter(Boolean).join(' · '),
    );
    const unique = [...new Set(texts)];
    return `${stage}: ${unique.length === 1 ? unique[0] : `mixed (${list.length} WABAs)`}`;
}

/**
 * Templates of the project's templates folder, grouped name → languages, with the last known
 * status of the target stage.
 */
export class TemplatesTree implements vscode.TreeDataProvider<TreeNode> {
    private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
    private status: StageStatus | undefined;
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly root: () => string | undefined) {}

    refresh(): void {
        this.changed.fire(undefined);
    }

    setStatus(status: StageStatus | undefined): void {
        this.status = status;
        this.refresh();
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        switch (node.kind) {
            case 'template': {
                const item = new vscode.TreeItem(
                    node.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                );
                item.contextValue = 'template';
                item.resourceUri = vscode.Uri.file(node.fsPath);
                item.iconPath = new vscode.ThemeIcon('comment-discussion');
                return item;
            }
            case 'language': {
                const item = new vscode.TreeItem(
                    node.language,
                    vscode.TreeItemCollapsibleState.None,
                );
                const list = this.status?.byTemplate.get(key(node.name, node.language));
                item.description = this.status ? describeStatus(this.status.stage, list) : '';
                item.tooltip = list
                    ?.map(
                        (entry) =>
                            `WABA ${entry.wabaId}: ${entry.status ?? 'not in WABA'} → ${entry.action}`,
                    )
                    .join('\n');
                item.contextValue = 'language';
                item.resourceUri = vscode.Uri.file(node.fsPath);
                item.command = {
                    command: 'vscode.open',
                    title: 'Open',
                    arguments: [vscode.Uri.file(node.fsPath)],
                };
                return item;
            }
            case 'extras': {
                const item = new vscode.TreeItem(
                    `Only in ${node.stage}`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                );
                item.iconPath = new vscode.ThemeIcon('cloud');
                item.contextValue = 'extras';
                return item;
            }
            default: {
                const item = new vscode.TreeItem(
                    `${node.name} (${node.language})`,
                    vscode.TreeItemCollapsibleState.None,
                );
                item.description = `${node.wabaIds.length} WABA(s)`;
                item.tooltip = node.wabaIds.map((id) => `WABA ${id}`).join('\n');
                item.contextValue = 'extra';
                return item;
            }
        }
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        const root = this.root();
        if (!root) {
            return [];
        }
        if (!node) {
            const config = await readProjectConfig(root);
            const templates: TreeNode[] = [];
            try {
                const entries = await readdir(config.templatesDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        templates.push({
                            kind: 'template',
                            name: entry.name,
                            fsPath: path.join(config.templatesDir, entry.name),
                        });
                    }
                }
            } catch {
                // No templates folder yet: only the extras (if any) are shown.
            }
            templates.sort((a, b) =>
                (a as TemplateNode).name.localeCompare((b as TemplateNode).name),
            );
            if (this.status && this.status.extras.size > 0) {
                templates.push({ kind: 'extras', stage: this.status.stage });
            }
            return templates;
        }
        if (node.kind === 'template') {
            let names: string[];
            try {
                names = (await readdir(node.fsPath, { withFileTypes: true }))
                    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
                    .map((entry) => entry.name)
                    .toSorted((a, b) => a.localeCompare(b));
            } catch {
                names = [];
            }
            return names.map((file) => ({
                kind: 'language',
                name: node.name,
                language: file.slice(0, -'.json'.length),
                fsPath: path.join(node.fsPath, file),
            }));
        }
        return node.kind === 'extras'
            ? [...(this.status?.extras.values() ?? [])].toSorted((a, b) =>
                  key(a.name, a.language).localeCompare(key(b.name, b.language)),
              )
            : [];
    }
}
