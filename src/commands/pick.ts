import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { WabaHost } from '../host';
import { allWabas, stripBom, tokenNames, type ProjectConfig } from '../project/config';

/**
Returned by the WABA pickers when the user dismissed the pick.
 */
export const CANCELLED = Symbol('cancelled');

/**
 * Pick a stage of the config.
 * @param config project config
 * @param title quick pick title
 * @param preferred stage listed first
 * @returns {Promise<string | undefined>} the stage, `undefined` when dismissed or there is none
 */
export async function pickStage(
    config: ProjectConfig,
    title: string,
    preferred?: string,
): Promise<string | undefined> {
    const names = Object.keys(config.stages);
    if (names.length === 0) {
        void vscode.window.showErrorMessage('WABA DevTools: .wabadevrc.json has no stages.');
        return undefined;
    }
    const items = names
        .toSorted((a, b) => Number(b === preferred) - Number(a === preferred))
        .map((name) => ({
            label: name,
            description: config.stages[name].map((entry) => entry.wabaId).join(', '),
            detail: name === preferred ? 'selected' : undefined,
        }));
    return (await vscode.window.showQuickPick(items, { title }))?.label;
}

/**
 * The selected source or target stage; asks once (and remembers) when none is selected.
 * @param host extension services
 * @param config project config
 * @param side source or target
 * @returns {Promise<string | undefined>} the stage
 */
export async function stageFor(
    host: WabaHost,
    config: ProjectConfig,
    side: 'source' | 'target',
): Promise<string | undefined> {
    const selected = host.selectedStage(config, side);
    if (selected) {
        return selected;
    }
    const stage = await pickStage(config, `Select the ${side} stage`);
    if (stage) {
        await host.setStage(config, side, stage);
    }
    return stage;
}

/**
 * The source WABA of a stage: none needed for a one-WABA stage, otherwise one must be picked.
 * @param config project config
 * @param stage source stage
 * @returns {Promise<string | undefined | typeof CANCELLED>} WABA ID, `undefined` = not needed
 */
export async function pickSourceWaba(
    config: ProjectConfig,
    stage: string,
): Promise<string | undefined | typeof CANCELLED> {
    const entries = config.stages[stage] ?? [];
    if (entries.length <= 1) {
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({ label: entry.wabaId, description: entry.tokenEnv })),
        { title: `Stage ${stage} has several WABAs — which one is the source?` },
    );
    return picked ? picked.label : CANCELLED;
}

/**
 * Target WABAs of a stage: all of them by default; with several, the user may deselect some.
 * @param config project config
 * @param stage target stage
 * @returns {Promise<string[] | typeof CANCELLED>} WABA IDs to pass as `--to-waba`; `[]` = all
 */
export async function pickTargetWabas(
    config: ProjectConfig,
    stage: string,
): Promise<string[] | typeof CANCELLED> {
    const entries = config.stages[stage] ?? [];
    if (entries.length <= 1) {
        return [];
    }
    const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
            label: entry.wabaId,
            description: entry.tokenEnv,
            picked: true,
        })),
        { title: `Which WABAs of ${stage}?`, canPickMany: true },
    );
    if (!picked || picked.length === 0) {
        return CANCELLED;
    }
    return picked.length === entries.length ? [] : picked.map((item) => item.label);
}

/**
 * Pick any WABA of the config.
 * @param config project config
 * @param title quick pick title
 * @param first WABA ID listed first (e.g. a backup's own WABA)
 * @returns {Promise<string | undefined>} WABA ID
 */
export async function pickWaba(
    config: ProjectConfig,
    title: string,
    first?: string,
): Promise<string | undefined> {
    const items = allWabas(config)
        .toSorted((a, b) => Number(b.wabaId === first) - Number(a.wabaId === first))
        .map((waba) => ({ label: waba.wabaId, description: waba.stages.join(', ') }));
    if (items.length === 0) {
        void vscode.window.showErrorMessage('WABA DevTools: .wabadevrc.json lists no WABAs.');
        return undefined;
    }
    return (await vscode.window.showQuickPick(items, { title }))?.label;
}

/**
 * Pick a token variable name of the config, or type another one.
 * @param config project config
 * @param title quick pick title
 * @param names names to offer instead of the config's
 * @returns {Promise<string | undefined>} variable name
 */
export async function pickTokenName(
    config: ProjectConfig,
    title: string,
    names = tokenNames(config),
): Promise<string | undefined> {
    const other = 'Other variable name…';
    const picked = await vscode.window.showQuickPick([...names, other], { title });
    if (picked !== other) {
        return picked;
    }
    return vscode.window.showInputBox({
        title,
        prompt: 'Environment variable name, e.g. WABA_TOKEN_NONPROD',
        validateInput: (value) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : 'Letters, digits and _ only.',
    });
}

export interface BackupSet {
    fsPath: string;
    wabaId: string;
    stage?: string;
    createdAt?: string;
    phase?: string;
}

/**
 * Read a backup set's manifest.
 * @param fsPath backup set folder
 * @returns {Promise<BackupSet | undefined>} the set, `undefined` when it has no usable manifest
 */
export async function readBackupSet(fsPath: string): Promise<BackupSet | undefined> {
    try {
        const text = await readFile(path.join(fsPath, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(stripBom(text)) as {
            wabaId?: unknown;
            stage?: string;
            createdAt?: string;
            phase?: string;
        };
        return typeof manifest.wabaId === 'string'
            ? {
                  fsPath,
                  wabaId: manifest.wabaId,
                  stage: manifest.stage,
                  createdAt: manifest.createdAt,
                  phase: manifest.phase,
              }
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The backup folder of a project (setting `waba-devtools.backupFolder`).
 * @param config project config
 * @returns {string} absolute path
 */
export function backupFolder(config: ProjectConfig): string {
    const folder = vscode.workspace
        .getConfiguration('waba-devtools')
        .get<string>('backupFolder', 'backups');
    return path.resolve(config.root, folder || 'backups');
}

/**
 * Backup sets in the backup folder, newest first.
 * @param config project config
 * @returns {Promise<BackupSet[]>} sets with a readable manifest
 */
export async function listBackupSets(config: ProjectConfig): Promise<BackupSet[]> {
    const root = backupFolder(config);
    let names: string[];
    try {
        names = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
    const sets: BackupSet[] = [];
    for (const name of names) {
        const set = await readBackupSet(path.join(root, name));
        if (set) {
            sets.push(set);
        }
    }
    return sets.toSorted((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * Quick-pick item of a backup set.
 * @param set backup set
 * @returns {vscode.QuickPickItem & {set: BackupSet}} item
 */
function setItem(set: BackupSet): vscode.QuickPickItem & { set: BackupSet } {
    return {
        label: path.basename(set.fsPath),
        description: `WABA ${set.wabaId}${set.stage ? ` (${set.stage})` : ''}`,
        detail: `${set.createdAt ?? ''} ${set.phase ?? ''}`,
        set,
    };
}

/**
 * Pick backup sets from the backup folder.
 * @param config project config
 * @param title quick pick title
 * @param count how many sets must be picked (1 or 2)
 * @param exclude a set already chosen
 * @returns {Promise<BackupSet[] | undefined>} the sets, `undefined` when dismissed or too few
 */
export async function pickBackupSets(
    config: ProjectConfig,
    title: string,
    count: 1 | 2,
    exclude?: string,
): Promise<BackupSet[] | undefined> {
    const sets = (await listBackupSets(config)).filter((set) => set.fsPath !== exclude);
    if (sets.length < count) {
        void vscode.window.showErrorMessage(
            `WABA DevTools: not enough backup sets in ${backupFolder(config)}.`,
        );
        return undefined;
    }
    if (count === 1) {
        const picked = await vscode.window.showQuickPick(sets.map(setItem), { title });
        return picked ? [picked.set] : undefined;
    }
    const picked = await vscode.window.showQuickPick(sets.map(setItem), {
        title,
        canPickMany: true,
    });
    if (!picked) {
        return undefined;
    }
    if (picked.length !== 2) {
        void vscode.window.showErrorMessage('WABA DevTools: pick exactly two backup sets.');
        return undefined;
    }
    return picked.map((item) => item.set);
}
