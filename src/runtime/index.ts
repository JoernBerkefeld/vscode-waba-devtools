import path from 'node:path';
import * as vscode from 'vscode';
import { executeCli, type CliResult } from './execute';
import { resolveCliRuntime, type ResolvedRuntime } from './resolve';

export { CliCancelledError, type CliResult } from './execute';
export { RuntimeError, type ResolvedRuntime } from './resolve';

const SECTION = 'waba-devtools';

interface CacheEntry {
    key: string;
    promise: Promise<ResolvedRuntime>;
}

const state: { cache?: CacheEntry } = {};

async function forgetOnFailure(entry: CacheEntry): Promise<void> {
    try {
        await entry.promise;
    } catch {
        if (state.cache === entry) {
            state.cache = undefined;
        }
    }
}

/**
 * Resolve the wabadev runtime from the current settings. Cached until `cliSource`,
 * `customCliPath` or the project root changes; a failed resolution is not cached.
 * @param projectRoot folder holding `.wabadevrc.json`
 * @returns {Promise<ResolvedRuntime>} the resolved runtime; rejects with `RuntimeError`
 */
export function resolveRuntime(projectRoot: string): Promise<ResolvedRuntime> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const source = config.get<string>('cliSource', 'auto');
    const customPath = config.get<string>('customCliPath', '');
    const key = JSON.stringify([source, customPath, projectRoot]);
    if (state.cache?.key === key) {
        return state.cache.promise;
    }
    // esbuild bundles this module into dist/extension.js, next to dist/waba-devtools.
    const entry: CacheEntry = {
        key,
        promise: resolveCliRuntime({
            source,
            customPath,
            projectRoot,
            bundleRoot: path.join(__dirname, 'waba-devtools'),
        }),
    };
    state.cache = entry;
    void forgetOnFailure(entry);
    return entry.promise;
}

/**
 * Forget the cached runtime (e.g. after `npm install` added a project-local CLI).
 */
export function clearRuntimeCache(): void {
    state.cache = undefined;
}

export interface RunCliOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    token?: vscode.CancellationToken;
    onStderr?: (line: string) => void;
}

/**
 * Run wabadev with exactly the given arguments (`node <wabadev.js> ...args`, no shell).
 * @param runtime the resolved runtime
 * @param cliArguments e.g. `['check', '--json']`
 * @param options working directory, environment, cancellation token and stderr callback
 * @returns {Promise<CliResult>} exit code, parsed JSON, stdout and stderr
 */
export function runCli(
    runtime: ResolvedRuntime,
    cliArguments: string[],
    options: RunCliOptions,
): Promise<CliResult> {
    return executeCli(runtime, cliArguments, options);
}
