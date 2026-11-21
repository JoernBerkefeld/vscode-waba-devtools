import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CONFIG_FILE = '.wabadevrc.json';
const DEFAULT_TEMPLATES_DIR = 'templates';

export interface WabaEntry {
    wabaId: string;
    tokenEnv: string;
}

/**
The parts of `.wabadevrc.json` the extension needs for pick lists. The CLI stays the validator.
 */
export interface ProjectConfig {
    root: string;
    stages: Record<string, WabaEntry[]>;
    /**
    Absolute path of the templates folder.
     */
    templatesDir: string;
}

/**
 * Read `.wabadevrc.json` leniently: unusable entries are left out instead of failing, so the CLI
 * can report the real configuration error when a command runs.
 * @param root project folder
 * @returns {Promise<ProjectConfig>} stages, WABAs and the templates folder
 */
export async function readProjectConfig(root: string): Promise<ProjectConfig> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(path.join(root, CONFIG_FILE), 'utf8'));
    } catch {
        raw = {};
    }
    const object = (raw && typeof raw === 'object' ? raw : {}) as {
        stages?: unknown;
        templatesDir?: unknown;
    };
    const stages: Record<string, WabaEntry[]> = {};
    if (object.stages && typeof object.stages === 'object') {
        for (const [name, list] of Object.entries(object.stages as Record<string, unknown>)) {
            if (!Array.isArray(list)) {
                continue;
            }
            stages[name] = list.filter(
                (entry): entry is WabaEntry =>
                    Boolean(entry) &&
                    typeof (entry as WabaEntry).wabaId === 'string' &&
                    typeof (entry as WabaEntry).tokenEnv === 'string',
            );
        }
    }
    const templatesFolder =
        typeof object.templatesDir === 'string' && object.templatesDir.trim()
            ? object.templatesDir
            : DEFAULT_TEMPLATES_DIR;
    return { root, stages, templatesDir: path.resolve(root, templatesFolder) };
}

/**
 * Every `tokenEnv` name of the config, without duplicates, in config order.
 * @param config project config
 * @returns {string[]} variable names
 */
export function tokenNames(config: ProjectConfig): string[] {
    return [
        ...new Set(
            Object.values(config.stages).flatMap((list) => list.map((entry) => entry.tokenEnv)),
        ),
    ];
}

/**
 * Every WABA of the config with the stages it is listed in.
 * @param config project config
 * @returns {Array<{wabaId: string, stages: string[]}>} one row per distinct WABA ID
 */
export function allWabas(config: ProjectConfig): Array<{ wabaId: string; stages: string[] }> {
    const byId = new Map<string, string[]>();
    for (const [stage, list] of Object.entries(config.stages)) {
        for (const entry of list) {
            const stages = byId.get(entry.wabaId) ?? [];
            if (!stages.includes(stage)) {
                stages.push(stage);
            }
            byId.set(entry.wabaId, stages);
        }
    }
    return [...byId].map(([wabaId, stages]) => ({ wabaId, stages }));
}

/**
 * The template names a selection stands for: a template folder or a file inside it gives its
 * name; the templates folder itself gives `[]` (= the whole set).
 * @param config project config
 * @param fsPaths selected file system paths
 * @returns {string[] | undefined} distinct names, `[]` for the whole set, `undefined` when a path is outside the templates folder
 */
export function templateNamesFor(config: ProjectConfig, fsPaths: string[]): string[] | undefined {
    const names = new Set<string>();
    for (const fsPath of fsPaths) {
        const relative = path.relative(config.templatesDir, fsPath);
        if (relative === '') {
            return [];
        }
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return undefined;
        }
        names.add(relative.split(/[\\/]/, 1)[0]);
    }
    return [...names];
}
