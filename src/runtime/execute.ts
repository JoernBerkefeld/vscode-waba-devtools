import { spawn } from 'node:child_process';
import type { ResolvedRuntime } from './resolve';

/**
Structural subset of `vscode.CancellationToken`, so this module runs without a VS Code host.
 */
export interface CancellationTokenLike {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => unknown): { dispose(): unknown };
}

export interface ExecuteOptions {
    cwd: string;
    /**
    Complete environment of the child process (tokens are passed only here, never as arguments).
     */
    env: NodeJS.ProcessEnv;
    token?: CancellationTokenLike;
    /**
    Called once per stderr line (without the line break).
     */
    onStderr?: (line: string) => void;
}

export interface CliResult {
    /**
    Process exit code; `-1` when the process ended without one (killed by a signal).
     */
    exitCode: number;
    /**
    stdout parsed as JSON when it parses, otherwise `undefined`.
     */
    json: unknown;
    stdout: string;
    stderr: string;
}

/**
Rejection reason when the cancellation token fired; the child process has been killed.
 */
export class CliCancelledError extends Error {
    constructor() {
        super('The waba run was cancelled.');
        this.name = 'CliCancelledError';
    }
}

function parseJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return undefined;
    }
}

/**
 * Run `node <waba.js> ...args` without a shell. Arguments are passed through unchanged.
 * @param runtime the resolved runtime
 * @param cliArguments CLI arguments, e.g. `['check', '--json']`
 * @param options working directory, environment, cancellation and stderr streaming
 * @returns {Promise<CliResult>} the collected result; rejects with {@link CliCancelledError} on cancellation
 */
export function executeCli(
    runtime: Pick<ResolvedRuntime, 'node' | 'cliJs'>,
    cliArguments: readonly string[],
    options: ExecuteOptions,
): Promise<CliResult> {
    if (options.token?.isCancellationRequested) {
        return Promise.reject(new CliCancelledError());
    }
    return new Promise((resolve, reject) => {
        const child = spawn(runtime.node, [runtime.cliJs, ...cliArguments], {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let pending = '';
        let isCancelled = false;
        const emitLine = (line: string): void => {
            options.onStderr?.(line.endsWith('\r') ? line.slice(0, -1) : line);
        };
        const subscription = options.token?.onCancellationRequested(() => {
            isCancelled = true;
            child.kill();
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
                emitLine(line);
            }
        });
        child.on('error', (error) => {
            subscription?.dispose();
            reject(error);
        });
        child.on('close', (code) => {
            subscription?.dispose();
            if (pending) {
                emitLine(pending);
                pending = '';
            }
            if (isCancelled) {
                reject(new CliCancelledError());
                return;
            }
            resolve({
                exitCode: code === null ? -1 : code,
                json: parseJson(stdout),
                stdout,
                stderr,
            });
        });
    });
}
