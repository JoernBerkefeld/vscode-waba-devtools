import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseEngineRange, parseVersion } from './nodeEngine';

export type CliSource = 'auto' | 'bundled' | 'custom';

/**
The single CLI runtime selected for a call. `project` = the project's own
node_modules/waba-devtools, picked by `auto`.
 */
export interface ResolvedRuntime {
    source: 'project' | 'bundled' | 'custom';
    /**
    Absolute path of the Node.js executable found on PATH.
     */
    node: string;
    /**
    Absolute path of waba-devtools' `bin/wabadev.js`.
     */
    cliJs: string;
    cliVersion: string;
}

export type RuntimeErrorCode =
    'node-unavailable' | 'node-unsupported' | 'bundle-missing' | 'custom-invalid';

/**
Resolution failure with a user-facing message.
 */
export class RuntimeError extends Error {
    constructor(
        readonly code: RuntimeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'RuntimeError';
    }
}

export interface ResolveOptions {
    /**
    Value of `waba-devtools.cliSource`; `undefined` means the default `auto`.
     */
    source?: string;
    /**
    Value of `waba-devtools.customCliPath`.
     */
    customPath?: string;
    /**
    Absolute path of the staged `dist/waba-devtools` folder.
     */
    bundleRoot: string;
    /**
    Folder holding `.wabadevrc.json`; `auto` looks for its node_modules/waba-devtools.
     */
    projectRoot?: string;
}

export interface ResolveDependencies {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    isFile?: (filename: string) => boolean;
    readText?: (filename: string) => string;
    nodeVersion?: (executable: string) => Promise<string>;
}

const PACKAGE_NAME = 'waba-devtools';
const SOURCE_SETTING = 'waba-devtools.cliSource';
const CUSTOM_SETTING = 'waba-devtools.customCliPath';

function isFile(filename: string): boolean {
    try {
        return statSync(filename).isFile();
    } catch {
        return false;
    }
}

function readText(filename: string): string {
    return readFileSync(filename, 'utf8');
}

function nodeVersion(executable: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            ['--version'],
            { encoding: 'utf8', timeout: 5000, windowsHide: true },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
    });
}

interface CliPackage {
    version: string;
    nodeEngine: string;
}

/**
 * Read the CLI's package.json next to `bin/`.
 * @param packageRoot folder holding `package.json` and `bin/`
 * @param read file reader
 * @param paths path functions of the target platform
 * @returns {CliPackage | undefined} the version and engine, or `undefined` if it is not a usable waba-devtools
 */
function readCliPackage(
    packageRoot: string,
    read: (filename: string) => string,
    paths: typeof path.posix,
): CliPackage | undefined {
    try {
        const manifest = JSON.parse(read(paths.join(packageRoot, 'package.json'))) as {
            name?: unknown;
            version?: unknown;
            engines?: { node?: unknown };
        };
        if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string') {
            return undefined;
        }
        const nodeEngine = manifest.engines?.node;
        return typeof nodeEngine === 'string' && parseEngineRange(nodeEngine)
            ? { version: manifest.version, nodeEngine }
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolve the CLI runtime once. `auto` prefers the project's own installed copy and otherwise uses
 * the bundled one; an explicit `bundled` or `custom` choice never falls back.
 * @param options settings, the bundled folder and the project root
 * @param dependencies injectable file system / PATH / version probes (tests)
 * @returns {Promise<ResolvedRuntime>} the resolved runtime
 */
export async function resolveCliRuntime(
    options: ResolveOptions,
    dependencies: ResolveDependencies = {},
): Promise<ResolvedRuntime> {
    const platform = dependencies.platform ?? process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const environment = dependencies.env ?? process.env;
    const file = dependencies.isFile ?? isFile;
    const read = dependencies.readText ?? readText;
    const source = options.source ?? 'auto';

    let selected: ResolvedRuntime['source'] | undefined;
    let cliJs = '';
    let cli: CliPackage | undefined;
    if (source === 'custom') {
        selected = 'custom';
        const custom = options.customPath?.trim() ?? '';
        if (!custom) {
            throw new RuntimeError(
                'custom-invalid',
                `Set ${CUSTOM_SETTING} to the bin/wabadev.js of a waba-devtools checkout when ${SOURCE_SETTING} is custom.`,
            );
        }
        cliJs = paths.normalize(custom);
        if (
            !paths.isAbsolute(cliJs) ||
            paths.basename(cliJs) !== 'wabadev.js' ||
            paths.basename(paths.dirname(cliJs)) !== 'bin' ||
            !file(cliJs)
        ) {
            throw new RuntimeError(
                'custom-invalid',
                `${CUSTOM_SETTING} must be the absolute path of an existing waba-devtools bin/wabadev.js: ${custom}`,
            );
        }
        cli = readCliPackage(paths.dirname(paths.dirname(cliJs)), read, paths);
        if (!cli) {
            throw new RuntimeError(
                'custom-invalid',
                `${custom} does not belong to a waba-devtools package with a valid package.json. Check ${CUSTOM_SETTING}.`,
            );
        }
    } else if (source === 'auto' || source === 'bundled') {
        if (source === 'auto' && options.projectRoot) {
            const projectPackage = paths.join(options.projectRoot, 'node_modules', PACKAGE_NAME);
            const projectCli = paths.join(projectPackage, 'bin', 'wabadev.js');
            const projectInfo = file(projectCli)
                ? readCliPackage(projectPackage, read, paths)
                : undefined;
            if (projectInfo) {
                selected = 'project';
                cliJs = projectCli;
                cli = projectInfo;
            }
        }
        if (!selected) {
            selected = 'bundled';
            cliJs = paths.join(options.bundleRoot, 'bin', 'wabadev.js');
            cli = file(cliJs) ? readCliPackage(options.bundleRoot, read, paths) : undefined;
            if (!cli) {
                throw new RuntimeError(
                    'bundle-missing',
                    `The bundled wabadev CLI is missing or damaged (${options.bundleRoot}). Reinstall the extension.`,
                );
            }
        }
    } else {
        throw new RuntimeError(
            'custom-invalid',
            `Invalid ${SOURCE_SETTING}: ${source}. Select auto, bundled or custom.`,
        );
    }
    if (!cli) {
        throw new RuntimeError('bundle-missing', 'No wabadev CLI found.');
    }

    const node = findOnPath(
        platform === 'win32' ? 'node.exe' : 'node',
        environment,
        platform,
        file,
    );
    if (!node) {
        throw new RuntimeError(
            'node-unavailable',
            `wabadev requires Node.js ${cli.nodeEngine} on PATH. Install a compatible Node.js and restart VS Code.`,
        );
    }
    let versionText: string;
    try {
        versionText = (await (dependencies.nodeVersion ?? nodeVersion)(node)).trim();
    } catch {
        throw new RuntimeError(
            'node-unavailable',
            `Cannot read the Node.js version from ${node}. Check your Node.js installation and restart VS Code.`,
        );
    }
    const version = parseVersion(versionText);
    const satisfies = parseEngineRange(cli.nodeEngine);
    if (!version || !satisfies?.(version)) {
        throw new RuntimeError(
            'node-unsupported',
            `Node.js ${versionText} at ${node} does not satisfy wabadev's requirement ${cli.nodeEngine}. Install a compatible Node.js on PATH and restart VS Code.`,
        );
    }
    return { source: selected, node, cliJs, cliVersion: cli.version };
}

function findOnPath(
    name: string,
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    isFileAt: (filename: string) => boolean,
): string | undefined {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const pathValue =
        Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const directories = pathValue.split(platform === 'win32' ? ';' : ':');
    for (const directory of directories) {
        // Skip empty and relative entries: they would mean the current directory.
        const clean = directory.replace(/^"(.*)"$/, '$1');
        if (!clean || !paths.isAbsolute(clean)) {
            continue;
        }
        const candidate = paths.join(clean, name);
        if (isFileAt(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
