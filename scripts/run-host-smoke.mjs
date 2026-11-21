/**
 * Smoke test in a real VS Code Extension Development Host: a fresh instance (own user-data and
 * extensions folders) opens a temporary project, activates the extension from this checkout and
 * runs test-fixtures/host-smoke/index.js. Local only (needs an installed VS Code and a staged
 * dist/waba-devtools); not part of CI.
 *
 * Usage: npm run compile && npm run bundle:cli && npm run test:host
 *   VSCODE_EXECUTABLE=<path to Code.exe / code binary> overrides the default lookup.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable =
    process.env.VSCODE_EXECUTABLE ??
    (process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')
        : 'code');
if (process.platform === 'win32' && !fs.existsSync(executable)) {
    throw new Error(`VS Code not found at ${executable}; set VSCODE_EXECUTABLE.`);
}
if (!fs.existsSync(path.join(projectRoot, 'dist', 'waba-devtools', 'bin', 'wabadev.js'))) {
    throw new Error('Stage the bundled CLI first: npm run bundle:cli');
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waba-host-smoke-'));
const marker = randomUUID();
fs.writeFileSync(path.join(runRoot, '.owner'), marker);
const created = [];
const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};
const project = path.join(runRoot, 'project');
const userData = path.join(runRoot, 'user-data');
const extensions = path.join(runRoot, 'extensions');
created.push(project, userData, extensions);
write(
    path.join(project, '.wabadevrc.json'),
    JSON.stringify({ stages: { dev: [{ wabaId: '111', tokenEnv: 'WABA_SMOKE_TOKEN' }] } }),
);
write(path.join(project, 'templates', 'order_shipped', 'en_US.json'), '{}');
write(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
        'waba-devtools.cliSource': 'custom',
        'waba-devtools.customCliPath': path.join(
            projectRoot,
            'test-fixtures',
            'fake-cli',
            'bin',
            'wabadev.js',
        ),
        'security.workspace.trust.enabled': false,
    }),
);
fs.mkdirSync(extensions, { recursive: true });
const log = path.join(runRoot, 'calls.jsonl');

// An inherited ELECTRON_RUN_AS_NODE (set when launched from another Electron app) would start
// VS Code as plain Node.js; the variable must be absent, not just empty.
const hostEnvironment = { ...process.env, FAKE_WABADEV_LOG: log };
delete hostEnvironment.ELECTRON_RUN_AS_NODE;

let status = 1;
try {
    const result = spawnSync(
        executable,
        [
            project,
            `--extensionDevelopmentPath=${projectRoot}`,
            `--extensionTestsPath=${path.join(projectRoot, 'test-fixtures', 'host-smoke', 'index.js')}`,
            `--user-data-dir=${userData}`,
            `--extensions-dir=${extensions}`,
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            '--new-window',
        ],
        {
            env: hostEnvironment,
            encoding: 'utf8',
            stdio: 'inherit',
            timeout: 180_000,
            windowsHide: false,
        },
    );
    status = result.status ?? 1;
    if (result.error) {
        console.error(result.error);
    }
} finally {
    // Remove only what this run created, inside its own marked run root.
    if (fs.readFileSync(path.join(runRoot, '.owner'), 'utf8') === marker) {
        for (const item of [...created, log, path.join(runRoot, '.owner')]) {
            const relative = path.relative(runRoot, item);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                fs.rmSync(item, { recursive: true, force: true });
            }
        }
        fs.rmdirSync(runRoot);
    }
}
console.log(status === 0 ? 'Host smoke test passed.' : `Host smoke test failed (exit ${status}).`);
process.exitCode = status;
