import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createFixture, type Fixture } from './fixture';
import { host, Uri } from './vscodeStub';

const current: { fixture?: Fixture } = {};

/**
 * Create the fixture for one test; afterEach cleans it up.
 * @param options extra project files
 * @param options.files relative path → content
 * @returns {Promise<Fixture>} the fixture
 */
async function setup(options: { files?: Record<string, string> } = {}): Promise<Fixture> {
    current.fixture = await createFixture(options);
    return current.fixture;
}

afterEach(() => {
    current.fixture?.cleanup();
    current.fixture = undefined;
    delete process.env.WABA_TOKEN_PROD;
});

const pickLabel =
    (label: string) =>
    (items: unknown): unknown =>
        (items as Array<{ label: string }>).find((item) => item.label === label);

test('activation sets the project context key and registers the commands', async () => {
    await setup();
    assert.equal(host.contexts.get('waba-devtools.project'), true);
    for (const id of ['check', 'deploy', 'deployPrune', 'compareWabas', 'setToken']) {
        assert.ok(host.commands.has(`waba-devtools.${id}`), id);
    }
});

test('check runs in the project root with --json', async () => {
    const fixture = await setup();
    fixture.respond({ check: [{ stdout: { command: 'check', entries: [], ok: true } }] });
    await fixture.run('check');
    const [call] = fixture.calls();
    assert.deepEqual(call.argv, ['check', '--json']);
    assert.equal(path.resolve(call.cwd), path.resolve(fixture.project));
});

test('a stored token reaches the CLI only as its environment variable', async () => {
    const fixture = await setup();
    host.quickPicks.push('WABA_TOKEN_NONPROD');
    host.inputAnswers.push('secret-nonprod');
    await fixture.run('setToken');
    await fixture.run('check');
    const [call] = fixture.calls();
    assert.equal(call.env.WABA_TOKEN_NONPROD, 'secret-nonprod');
    assert.ok(!call.argv.join(' ').includes('secret-nonprod'));
    assert.ok(!host.output.join('\n').includes('secret-nonprod'));
});

test('an environment variable or .env entry wins over a stored token', async () => {
    const fixture = await setup({ files: { '.env': 'WABA_TOKEN_NONPROD=from-dotenv\n' } });
    process.env.WABA_TOKEN_PROD = 'from-env';
    fixture.secrets.set('waba-devtools.token.WABA_TOKEN_NONPROD', 'stored');
    fixture.secrets.set('waba-devtools.token.WABA_TOKEN_PROD', 'stored');
    await fixture.run('check');
    const [call] = fixture.calls();
    // .env is left to the CLI: the stored value is not injected.
    assert.equal(call.env.WABA_TOKEN_NONPROD, null);
    assert.equal(call.env.WABA_TOKEN_PROD, 'from-env');
});

test('a usage error (not JSON) is shown as an error with the stderr text', async () => {
    const fixture = await setup();
    fixture.respond({ check: [{ exitCode: 2, stderr: 'Unknown option --x\n\nwabadev — help' }] });
    await fixture.run('check');
    const error = host.messages.find((message) => message.level === 'error');
    assert.match(error?.text ?? '', /Unknown option --x/);
    assert.doesNotMatch(error?.text ?? '', /help/);
});

test('{ok:false, error} is shown as an error', async () => {
    const fixture = await setup();
    fixture.respond({
        list: [{ exitCode: 2, stdout: { command: 'list', ok: false, error: 'Unknown stage' } }],
    });
    host.quickPicks.push(pickLabel('dev'));
    await fixture.run('list');
    assert.deepEqual(fixture.calls()[0].argv, ['list', '--to', 'dev', '--json']);
    assert.ok(
        host.messages.some(
            (message) => message.level === 'error' && /Unknown stage/.test(message.text),
        ),
    );
});

test('retrieve uses the source stage and -m from a template file', async () => {
    const fixture = await setup();
    fixture.respond({
        retrieve: [{ stdout: { command: 'retrieve', wabaId: '111', files: [], ok: true } }],
    });
    host.quickPicks.push(pickLabel('dev'));
    await fixture.run(
        'retrieve',
        Uri.file(path.join(fixture.project, 'templates', 'order_shipped', 'en_US.json')),
    );
    assert.deepEqual(fixture.calls()[0].argv, [
        'retrieve',
        '--from',
        'dev',
        '-m',
        'order_shipped',
        '--json',
    ]);
});

test('retrieve from a multi-WABA stage asks for the source WABA', async () => {
    const fixture = await setup();
    host.quickPicks.push(pickLabel('prod'), pickLabel('444'));
    await fixture.run('retrieve');
    assert.deepEqual(fixture.calls()[0].argv, [
        'retrieve',
        '--from',
        'prod',
        '--from-waba',
        '444',
        '--json',
    ]);
});

test('import CSV passes the file relative to the project', async () => {
    const fixture = await setup();
    await fixture.run('importCsv', Uri.file(path.join(fixture.project, 'data', 'sheet.csv')));
    assert.deepEqual(fixture.calls()[0].argv, [
        'import',
        '--csv',
        path.join('data', 'sheet.csv'),
        '--json',
    ]);
});

test('discover passes --token-env and injects that stored token', async () => {
    const fixture = await setup();
    fixture.secrets.set('waba-devtools.token.OTHER_TOKEN', 'other');
    host.quickPicks.push('Other variable name…');
    host.inputAnswers.push('OTHER_TOKEN');
    await fixture.run('discover');
    const [call] = fixture.calls();
    assert.deepEqual(call.argv, ['discover', '--token-env', 'OTHER_TOKEN', '--json']);
    assert.equal(call.env.OTHER_TOKEN, 'other');
});

test('backup of a picked stage writes to the backup folder', async () => {
    const fixture = await setup();
    host.quickPicks.push(pickLabel('prod'), (items) => (items as unknown[]).slice(0, 1));
    await fixture.run('backup');
    assert.deepEqual(fixture.calls()[0].argv, [
        'backup',
        '--stage',
        'prod',
        '--waba',
        '333',
        '--backup',
        'backups',
        '--json',
    ]);
});

const manifest = (wabaId: string, createdAt: string): string =>
    JSON.stringify({ tool: 'waba-devtools', wabaId, stage: 'prod', createdAt, phase: 'before' });

test('compare: two backup sets, set vs live, two WABAs — each opens a Markdown report', async () => {
    const setA = 'backups/333_2026-11-20T10-00-00-000Z_before';
    const setB = 'backups/333_2026-11-20T11-00-00-000Z_after';
    const fixture = await setup({
        files: {
            [`${setA}/manifest.json`]: manifest('333', '2026-11-20T10:00:00.000Z'),
            [`${setB}/manifest.json`]: manifest('333', '2026-11-20T11:00:00.000Z'),
        },
    });
    const report = {
        command: 'compare',
        before: { wabaId: '333', stage: 'prod', phase: 'before' },
        after: { wabaId: '444', stage: 'prod', phase: 'live' },
        sameWaba: false,
        added: [{ name: 'n', language: 'fr' }],
        removed: [],
        changed: [
            {
                name: 'c',
                language: 'en_US',
                changes: [{ field: 'Body text', before: 'old', after: 'new' }],
            },
        ],
        unchanged: 3,
        ok: true,
    };
    fixture.respond({ compare: [{ stdout: report }] });

    host.quickPicks.push((items) => (items as unknown[])[0]);
    await fixture.run('compareBackups', Uri.file(path.join(fixture.project, setA)));
    host.quickPicks.push(pickLabel('444'));
    await fixture.run('compareLive', Uri.file(path.join(fixture.project, setB)));
    host.quickPicks.push(pickLabel('333'), pickLabel('444'));
    await fixture.run('compareWabas');

    const argvs = fixture.calls().map((call) => call.argv);
    assert.deepEqual(argvs, [
        ['compare', path.normalize(setA), path.normalize(setB), '--json'],
        ['compare', path.normalize(setB), '--live', '--waba', '444', '--json'],
        ['compare', '--before-waba', '333', '--after-waba', '444', '--json'],
    ]);
    assert.equal(host.documents.length, 3);
    assert.match(host.documents[0].content ?? '', /## Changed \(1\)[\s\S]*Body text/);
});

test('restore deploys a backup set into the picked WABA', async () => {
    const set = 'backups/444_2026-11-20T10-00-00-000Z_before';
    const fixture = await setup({ files: { [`${set}/manifest.json`]: manifest('444', 'x') } });
    host.quickPicks.push(pickLabel('444'));
    await fixture.run('restore', Uri.file(path.join(fixture.project, set)));
    assert.deepEqual(fixture.calls()[0].argv, [
        'deploy',
        '--from-dir',
        path.normalize(set),
        '--to-waba',
        '444',
        '--dry-run',
        '--json',
    ]);
});
