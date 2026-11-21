// Runs inside a real VS Code Extension Development Host (see scripts/run-host-smoke.mjs).
// Checks activation, command registration, the templates tree, and that commands reach the
// configured CLI: the fake CLI (settings) and then the bundled real CLI.
'use strict';
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const vscode = require('vscode');

/**
 * Entry point called by VS Code with --extensionTestsPath.
 * @returns {Promise<void>} resolves when every check passed
 */
async function run() {
    const extension = vscode.extensions.getExtension('joernberkefeld.vscode-waba-devtools');
    assert.ok(extension, 'extension found');
    const api = await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['check', 'deploy', 'deployPrune', 'retrieve', 'compareWabas', 'setToken']) {
        assert.ok(commands.includes(`waba-devtools.${id}`), `command ${id}`);
    }
    const roots = await api.templates.getChildren();
    assert.deepEqual(
        roots.map((node) => node.name),
        ['order_shipped'],
    );
    const languages = await api.templates.getChildren(roots[0]);
    assert.deepEqual(
        languages.map((node) => node.language),
        ['en_US'],
    );
    await vscode.commands.executeCommand('workbench.view.extension.waba-devtools');

    // 1. Fake CLI (cliSource custom from the user settings of this instance).
    await vscode.commands.executeCommand('waba-devtools.check');
    const log = process.env.FAKE_WABADEV_LOG;
    assert.ok(log && existsSync(log), 'fake CLI was called');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls[0].argv, ['check', '--json']);

    // 2. Bundled real CLI: no tokens set, so check reports the missing variable without any
    //    network call.
    await vscode.workspace
        .getConfiguration('waba-devtools')
        .update('cliSource', 'bundled', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('waba-devtools.check');
    const after = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(after.length, 1, 'the second check ran the bundled CLI, not the fake one');
    process.stdout.write('[host-smoke] all checks passed\n');
}

module.exports = { run };
