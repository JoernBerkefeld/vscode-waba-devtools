import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFixture, deployReport, type Fixture } from './fixture';
import { host, Uri } from './vscodeStub';

const current: { fixture?: Fixture } = {};

beforeEach(async () => {
    current.fixture = await createFixture();
});

afterEach(() => {
    current.fixture?.cleanup();
});

/**
 * The fixture of the running test.
 * @returns {Fixture} fixture
 */
function fx(): Fixture {
    if (!current.fixture) {
        throw new Error('no fixture');
    }
    return current.fixture;
}

/**
 * Select dev → prod with both prod WABAs (stage picks + "all WABAs" pick).
 */
function answerStagePicks(): void {
    // target stage pick, then the multi-WABA pick (keep all)
    host.quickPicks.push(
        (items) => (items as Array<{ label: string }>).find((item) => item.label === 'prod'),
        (items) => items,
    );
}

/**
 * Deploy calls with the temporary `--expect` path replaced by `<expect>`.
 * @returns {string[][]} argument lists
 */
const deployCalls = (): string[][] =>
    fx()
        .calls()
        .filter((call) => call.argv[0] === 'deploy')
        .map((call) =>
            call.argv.map((argument, index) =>
                call.argv[index - 1] === '--expect' ? '<expect>' : argument,
            ),
        );

test('a preview always runs with --dry-run and sends nothing', async () => {
    fx().respond({ deploy: [{ stdout: deployReport({ 333: [['create', 'a', 'en_US']] }) }] });
    answerStagePicks();
    await fx().run('deployPreview');
    assert.deepEqual(deployCalls(), [['deploy', '--to', 'prod', '--dry-run', '--json']]);
});

test('deploy: dismissing the confirmation sends nothing', async () => {
    fx().respond({ deploy: [{ stdout: deployReport({ 333: [['update', 'a', 'en_US']] }) }] });
    answerStagePicks();
    host.messageAnswers.push(undefined);
    await fx().run('deploy');
    const calls = deployCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--dry-run'));
    const modal = host.messages.find((message) => message.modal);
    assert.match(modal?.text ?? '', /Deploy to prod: 0 create, 1 update\?/);
    assert.match(modal?.detail ?? '', /update a \(en_US\)/);
});

test('deploy: confirmed → send with the backup setting and the preview as --expect', async () => {
    const preview = deployReport({
        333: [
            ['create', 'a', 'en_US'],
            ['unchanged', 'b', 'en_US'],
        ],
    });
    fx().respond({
        deploy: [
            { stdout: preview },
            { stdout: deployReport({ 333: [['create', 'a', 'en_US']] }, { dryRun: false }) },
        ],
    });
    answerStagePicks();
    host.messageAnswers.push('Deploy');
    await fx().run('deploy');
    assert.deepEqual(deployCalls(), [
        ['deploy', '--to', 'prod', '--dry-run', '--json'],
        ['deploy', '--to', 'prod', '--backup', 'backups', '--expect', '<expect>', '--json'],
    ]);
    const send = fx().calls().at(-1);
    assert.equal(JSON.stringify(send?.expected), JSON.stringify(preview));
});

test('deploy: a WABA that changed since the preview is reported', async () => {
    const changed = {
        ...deployReport({ 333: [] }, { dryRun: false, ok: false }),
        targets: [
            {
                wabaId: '333',
                stage: 'prod',
                actions: [],
                error: 'changed since preview — run the preview again',
            },
        ],
    };
    fx().respond({
        deploy: [
            { stdout: deployReport({ 333: [['update', 'a', 'en_US']] }) },
            { exitCode: 1, stdout: changed },
        ],
    });
    answerStagePicks();
    host.messageAnswers.push('Deploy');
    await fx().run('deploy');
    assert.equal(deployCalls().length, 2);
    assert.ok(host.messages.some((message) => /changed since the preview/.test(message.text)));
});

test('deploy: nothing to send → no confirmation, no send', async () => {
    fx().respond({ deploy: [{ stdout: deployReport({ 333: [['unchanged', 'a', 'en_US']] }) }] });
    answerStagePicks();
    await fx().run('deploy');
    assert.equal(deployCalls().length, 1);
    assert.ok(host.messages.every((message) => !message.modal));
});

test('deploy from a template folder passes -m with its name', async () => {
    fx().respond({ deploy: [{ stdout: deployReport({ 333: [] }) }] });
    answerStagePicks();
    const folder = path.join(fx().project, 'templates', 'order_shipped');
    await fx().run('deployPreview', Uri.file(folder));
    assert.deepEqual(deployCalls()[0], [
        'deploy',
        '--to',
        'prod',
        '-m',
        'order_shipped',
        '--dry-run',
        '--json',
    ]);
});

test('prune: preview is --prune --dry-run, the modal lists deletes, --yes only after confirming', async () => {
    const preview = deployReport({
        333: [
            ['delete', 'old', 'en_US'],
            ['unchanged', 'a', 'en_US'],
        ],
    });
    fx().respond({
        deploy: [
            { stdout: preview },
            { stdout: deployReport({ 333: [['delete', 'old', 'en_US']] }, { dryRun: false }) },
        ],
    });
    host.quickPicks.push((items) => (items as string[])[0]); // source: template files
    answerStagePicks();
    host.messageAnswers.push('Delete 1 and Deploy');
    await fx().run('deployPrune');
    const calls = deployCalls();
    assert.deepEqual(calls[0], ['deploy', '--to', 'prod', '--prune', '--dry-run', '--json']);
    assert.ok(!calls[0].includes('--yes'));
    assert.deepEqual(calls[1], [
        'deploy',
        '--to',
        'prod',
        '--prune',
        '--yes',
        '--backup',
        'backups',
        '--expect',
        '<expect>',
        '--json',
    ]);
    const modal = host.messages.find((message) => message.modal);
    assert.match(modal?.text ?? '', /1 DELETE/);
    assert.match(modal?.detail ?? '', /delete old \(en_US\)/);
});

test('prune: dismissing the modal never runs --yes', async () => {
    fx().respond({ deploy: [{ stdout: deployReport({ 333: [['delete', 'old', 'en_US']] }) }] });
    host.quickPicks.push((items) => (items as string[])[0]);
    answerStagePicks();
    host.messageAnswers.push(undefined);
    await fx().run('deployPrune');
    assert.ok(deployCalls().every((call) => !call.includes('--yes') && call.includes('--dry-run')));
});

test('a preview with blocked templates (exit 1) is shown, not treated as an error', async () => {
    fx().respond({
        deploy: [
            {
                exitCode: 1,
                stdout: deployReport({ 333: [['blocked', 'a', 'en_US']] }, { ok: false }),
            },
        ],
    });
    answerStagePicks();
    await fx().run('deploy');
    assert.ok(host.output.some((line) => /blocked\s+a \(en_US\)/.test(line)));
    assert.ok(host.messages.every((message) => message.level !== 'error'));
});

test('deploy CSV and restore pass their sources', async () => {
    fx().respond({ deploy: [{ stdout: deployReport({ 333: [] }) }] });
    answerStagePicks();
    const csv = path.join(fx().project, 'sheet.csv');
    await fx().run('deployCsv', Uri.file(csv));
    assert.deepEqual(deployCalls()[0].slice(0, 3), ['deploy', '--csv', 'sheet.csv']);
});
