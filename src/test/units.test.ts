import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { summarizePreview } from '../cli/deployPlan';
import { interpretResult } from '../cli/result';
import type { DeployReport } from '../cli/types';
import { templateNamesFor, type ProjectConfig } from '../project/config';
import { resolveCliRuntime, RuntimeError } from '../runtime/resolve';
import { describeStatus, statusFromPreview } from '../tree/templatesTree';
import { deployReport } from './fixture';

const posix = path.posix;
const cliPackage = JSON.stringify({
    name: 'waba-devtools',
    version: '1.2.3',
    engines: { node: '>=22.0.0' },
});

function dependencies(files: Record<string, string>, nodeVersion = 'v24.1.0') {
    const known = new Map(Object.entries(files));
    return {
        platform: 'linux' as const,
        env: { PATH: '/usr/bin' },
        isFile: (filename: string) => known.has(filename) || filename === '/usr/bin/node',
        readText: (filename: string) => {
            const text = known.get(filename);
            if (text === undefined) {
                throw new Error('ENOENT');
            }
            return text;
        },
        nodeVersion: async () => nodeVersion,
    };
}

test('runtime: auto prefers the project copy, else bundled', async () => {
    const files = {
        '/p/node_modules/waba-devtools/bin/wabadev.js': '',
        '/p/node_modules/waba-devtools/package.json': cliPackage,
        '/ext/dist/waba-devtools/bin/wabadev.js': '',
        '/ext/dist/waba-devtools/package.json': cliPackage,
    };
    const project = await resolveCliRuntime(
        { source: 'auto', projectRoot: '/p', bundleRoot: '/ext/dist/waba-devtools' },
        dependencies(files),
    );
    assert.equal(project.source, 'project');
    assert.equal(project.cliJs, posix.join('/p/node_modules/waba-devtools/bin/wabadev.js'));
    const bundled = await resolveCliRuntime(
        { source: 'auto', projectRoot: '/other', bundleRoot: '/ext/dist/waba-devtools' },
        dependencies(files),
    );
    assert.equal(bundled.source, 'bundled');
    assert.equal(bundled.cliVersion, '1.2.3');
});

test('runtime: bundled and custom never fall back', async () => {
    const files = {
        '/p/node_modules/waba-devtools/bin/wabadev.js': '',
        '/p/node_modules/waba-devtools/package.json': cliPackage,
    };
    await assert.rejects(
        resolveCliRuntime(
            { source: 'bundled', projectRoot: '/p', bundleRoot: '/missing' },
            dependencies(files),
        ),
        (error: RuntimeError) => error.code === 'bundle-missing',
    );
    await assert.rejects(
        resolveCliRuntime(
            { source: 'custom', customPath: 'relative/bin/wabadev.js', bundleRoot: '/x' },
            dependencies(files),
        ),
        (error: RuntimeError) => error.code === 'custom-invalid',
    );
    await assert.rejects(
        resolveCliRuntime(
            { source: 'custom', customPath: '', bundleRoot: '/x' },
            dependencies(files),
        ),
        (error: RuntimeError) => error.code === 'custom-invalid',
    );
    const custom = await resolveCliRuntime(
        {
            source: 'custom',
            customPath: '/p/node_modules/waba-devtools/bin/wabadev.js',
            bundleRoot: '/x',
        },
        dependencies(files),
    );
    assert.equal(custom.source, 'custom');
});

test('runtime: a package that is not waba-devtools is refused', async () => {
    const files = {
        '/c/bin/wabadev.js': '',
        '/c/package.json': JSON.stringify({
            name: 'other',
            version: '1.0.0',
            engines: { node: '>=22.0.0' },
        }),
    };
    await assert.rejects(
        resolveCliRuntime(
            { source: 'custom', customPath: '/c/bin/wabadev.js', bundleRoot: '/x' },
            dependencies(files),
        ),
        (error: RuntimeError) => error.code === 'custom-invalid',
    );
});

test('runtime: Node.js on PATH must satisfy the CLI engine', async () => {
    const files = { '/b/bin/wabadev.js': '', '/b/package.json': cliPackage };
    await assert.rejects(
        resolveCliRuntime({ source: 'bundled', bundleRoot: '/b' }, dependencies(files, 'v20.0.0')),
        (error: RuntimeError) => error.code === 'node-unsupported',
    );
    await assert.rejects(
        resolveCliRuntime(
            { source: 'bundled', bundleRoot: '/b' },
            { ...dependencies(files), env: { PATH: '' } },
        ),
        (error: RuntimeError) => error.code === 'node-unavailable',
    );
});

test('result: exit 1 with a report is a report; {error} and non-JSON are errors', () => {
    const report = interpretResult({
        exitCode: 1,
        json: { command: 'check', ok: false, entries: [] },
        stdout: '',
        stderr: '',
    });
    assert.equal(report.kind, 'report');
    const failed = interpretResult({
        exitCode: 2,
        json: { command: 'deploy', ok: false, error: 'bad' },
        stdout: '',
        stderr: '',
    });
    assert.deepEqual(failed.kind === 'error' && failed.message, 'bad');
    const usage = interpretResult({
        exitCode: 2,
        json: undefined,
        stdout: '',
        stderr: 'Unknown option\n\nHELP',
    });
    assert.deepEqual(usage.kind === 'error' && usage.message, 'Unknown option');
    const empty = interpretResult({ exitCode: -1, json: undefined, stdout: '', stderr: '' });
    assert.equal(empty.kind, 'error');
});

test('deploy plan: summary counts sends and lists problems', () => {
    const a = deployReport({
        1: [
            ['create', 'x', 'en'],
            ['unchanged', 'y', 'en'],
            ['blocked', 'z', 'en'],
        ],
    }) as DeployReport;
    const summary = summarizePreview(a);
    assert.equal(summary.creates, 1);
    assert.equal(summary.problems.length, 1);
    assert.match(summary.lines.join('\n'), /create x \(en\)/);
});

test('config: template names from a selection', () => {
    const config: ProjectConfig = {
        root: '/p',
        stages: {},
        templatesDir: path.resolve('/p/templates'),
    };
    assert.deepEqual(templateNamesFor(config, [path.resolve('/p/templates')]), []);
    assert.deepEqual(
        templateNamesFor(config, [
            path.resolve('/p/templates/a/en.json'),
            path.resolve('/p/templates/a'),
            path.resolve('/p/templates/b'),
        ]),
        ['a', 'b'],
    );
    assert.equal(templateNamesFor(config, [path.resolve('/p/other.json')]), undefined);
});

test('tree: status per template and target-only templates', () => {
    const report = deployReport({
        333: [
            ['unchanged', 'a', 'en_US'],
            ['extra', 'old', 'fr'],
        ],
        444: [
            ['update', 'a', 'en_US'],
            ['extra', 'old', 'fr'],
        ],
    }) as DeployReport;
    const status = statusFromPreview('prod', report);
    assert.equal(
        describeStatus('prod', status.byTemplate.get('a::en_US')),
        'prod: mixed (2 WABAs)',
    );
    assert.deepEqual(status.extras.get('old::fr')?.wabaIds, ['333', '444']);
    assert.equal(
        describeStatus('dev', [{ wabaId: '1', action: 'create' }]),
        'dev: not in WABA · create',
    );
});
