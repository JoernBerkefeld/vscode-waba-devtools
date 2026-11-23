/**
 * A temporary project plus the fake CLI, for command tests. Everything lives in a fresh
 * `mkdtemp` run root under the OS temp folder; cleanup removes only the paths this run created.
 */
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    writeFileSync,
    existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as extension from '../extension';
import { host, resetHost, Uri } from './vscodeStub';

export const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
export const fakeCli = path.join(repositoryRoot, 'test-fixtures', 'fake-cli', 'bin', 'waba.js');

export interface Call {
    argv: string[];
    env: Record<string, string | null>;
    cwd: string;
    /**
    Content of the `--expect` file, read by the fake CLI while it existed.
     */
    expected?: { targets?: unknown[]; dryRun?: boolean };
}

export interface Fixture {
    project: string;
    secrets: Map<string, string>;
    respond(responses: Record<string, unknown[]>): void;
    calls(): Call[];
    run(command: string, ...arguments_: unknown[]): Promise<unknown>;
    cleanup(): void;
}

export const CONFIG = {
    stages: {
        dev: [{ wabaId: '111', tokenEnv: 'WABA_TOKEN_NONPROD' }],
        prod: [
            { wabaId: '333', tokenEnv: 'WABA_TOKEN_PROD' },
            { wabaId: '444', tokenEnv: 'WABA_TOKEN_PROD' },
        ],
    },
};

/**
 * Create the project, point the extension at the fake CLI and activate it.
 * @param options extra files (relative path → content)
 * @param options.files extra files to write into the project
 * @returns {Promise<Fixture>} the fixture
 */
export async function createFixture(
    options: { files?: Record<string, string> } = {},
): Promise<Fixture> {
    const runRoot = mkdtempSync(path.join(os.tmpdir(), 'waba-vscode-test-'));
    const project = path.join(runRoot, 'project');
    const logFile = path.join(runRoot, 'calls.jsonl');
    const responsesFile = path.join(runRoot, 'responses.json');
    mkdirSync(path.join(project, 'templates', 'order_shipped'), { recursive: true });
    writeFileSync(path.join(project, '.wabadevrc.json'), JSON.stringify(CONFIG));
    writeFileSync(path.join(project, 'templates', 'order_shipped', 'en_US.json'), '{}');
    const extraFiles = Object.entries(options.files ?? {});
    for (const [file, content] of extraFiles) {
        mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
        writeFileSync(path.join(project, file), content);
    }
    writeFileSync(responsesFile, '{}');
    process.env.FAKE_WABADEV_LOG = logFile;
    process.env.FAKE_WABADEV_RESPONSES = responsesFile;
    process.env.FAKE_WABADEV_WATCH = 'WABA_TOKEN_NONPROD,WABA_TOKEN_PROD,OTHER_TOKEN';
    resetHost();
    host.settings.set('waba-devtools.cliSource', 'custom');
    host.settings.set('waba-devtools.customCliPath', fakeCli);
    host.workspaceFolders.length = 0;
    host.workspaceFolders.push({ uri: Uri.file(project), name: 'project', index: 0 });

    const secrets = new Map<string, string>();
    const state = new Map<string, unknown>();
    const context = {
        subscriptions: [] as Array<{ dispose(): unknown }>,
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            },
            delete: async (key: string) => {
                secrets.delete(key);
            },
        },
        workspaceState: {
            get: <T>(key: string, fallback: T): T =>
                (state.has(key) ? state.get(key) : fallback) as T,
            update: async (key: string, value: unknown) => {
                state.set(key, value);
            },
        },
    };
    await extension.activate(context as never);
    return {
        project,
        secrets,
        respond(responses) {
            writeFileSync(responsesFile, JSON.stringify(responses));
        },
        calls() {
            return existsSync(logFile)
                ? readFileSync(logFile, 'utf8')
                      .split('\n')
                      .filter(Boolean)
                      .map((line) => JSON.parse(line) as Call)
                : [];
        },
        async run(command, ...arguments_) {
            const handler = host.commands.get(`waba-devtools.${command}`);
            if (!handler) {
                throw new Error(`Command not registered: ${command}`);
            }
            return handler(...arguments_);
        },
        cleanup() {
            for (const item of context.subscriptions) {
                item.dispose();
            }
            // Only the paths this run created, then the (now empty) run root itself.
            rmSync(project, { recursive: true, force: true });
            rmSync(logFile, { force: true });
            rmSync(responsesFile, { force: true });
            rmdirSync(runRoot);
        },
    };
}

/**
 * A `deploy --dry-run` report for the fake CLI.
 * @param targets per WABA: actions as `[action, name, language]`
 * @param options flags
 * @param options.dryRun whether it is a preview (default true)
 * @param options.ok report ok flag
 * @returns {object} report
 */
export function deployReport(
    targets: Record<string, Array<[string, string, string]>>,
    options: { dryRun?: boolean; ok?: boolean } = {},
): object {
    return {
        command: 'deploy',
        dryRun: options.dryRun ?? true,
        source: { type: 'files', dir: 'templates' },
        rowErrors: [],
        targets: Object.entries(targets).map(([wabaId, actions]) => ({
            stage: 'prod',
            stages: ['prod'],
            wabaId,
            actions: actions.map(([action, name, language]) => ({
                action,
                name,
                language,
                status: action === 'create' ? undefined : 'APPROVED',
                fingerprint: ['create', 'update', 'delete'].includes(action)
                    ? `fp-${action}-${name}-${language}`
                    : undefined,
            })),
        })),
        ok: options.ok ?? true,
    };
}
