import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './fixture';

type Bundle = (options: {
    destination: string;
    localCheckout?: string;
    root?: string;
}) => Promise<{ source: string; version: string; files: Record<string, string> }>;

const runRoot = mkdtempSync(path.join(os.tmpdir(), 'waba-bundle-test-'));
const created: string[] = [];

after(() => {
    for (const item of created) {
        rmSync(item, { recursive: true, force: true });
    }
    rmdirSync(runRoot);
});

function write(file: string, content: string | object): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

/**
 * A minimal waba-devtools checkout with one registry-locked dependency.
 * @param name folder name below the run root
 * @param dependencyLock lock entry of the dependency
 * @returns {string} checkout folder
 */
function checkout(name: string, dependencyLock: object): string {
    const folder = path.join(runRoot, name);
    created.push(folder);
    write(path.join(folder, 'package.json'), {
        name: 'waba-devtools',
        version: '1.0.0',
        type: 'module',
        bin: { wabadev: './bin/wabadev.js' },
        engines: { node: '>=22.0.0' },
        dependencies: { dep: '^1.0.0' },
    });
    write(path.join(folder, 'bin', 'wabadev.js'), "import '../lib/cli.js';\n");
    write(path.join(folder, 'lib', 'cli.js'), 'export {};\n');
    write(path.join(folder, 'LICENSE'), 'MIT\n');
    write(path.join(folder, 'README.md'), '# not shipped\n');
    write(path.join(folder, 'test', 'x.test.js'), '// not shipped\n');
    write(path.join(folder, 'node_modules', 'dep', 'package.json'), {
        name: 'dep',
        version: '1.0.0',
    });
    write(path.join(folder, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    write(path.join(folder, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
            '': { name: 'waba-devtools', version: '1.0.0', dependencies: { dep: '^1.0.0' } },
            'node_modules/dep': dependencyLock,
        },
    });
    return folder;
}

const registryDependency = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz',
    integrity: 'sha512-AAAA',
};

async function load(): Promise<Bundle> {
    const url = pathToFileURL(path.join(repositoryRoot, 'scripts', 'bundle-waba-devtools.mjs'));
    return ((await import(url.href)) as { bundleWabaDevtools: Bundle }).bundleWabaDevtools;
}

test('bundle from a local checkout stages bin, lib, LICENSE and the dependency closure', async () => {
    const bundle = await load();
    const destination = path.join(runRoot, 'out-local');
    created.push(destination);
    const metadata = await bundle({
        destination,
        localCheckout: checkout('local', registryDependency),
    });
    assert.equal(metadata.source, 'local-checkout');
    assert.deepEqual(
        Object.keys(metadata.files).toSorted((a, b) => a.localeCompare(b)),
        [
            'bin/wabadev.js',
            'lib/cli.js',
            'LICENSE',
            'node_modules/dep/index.js',
            'node_modules/dep/package.json',
            'package.json',
        ],
    );
    assert.ok(!existsSync(path.join(destination, 'README.md')));
    const written = JSON.parse(
        readFileSync(path.join(destination, 'bundle-metadata.json'), 'utf8'),
    );
    assert.equal(written.cliJs, 'bin/wabadev.js');
    // A second run over its own output is fine; an unregistered file is refused.
    await bundle({ destination, localCheckout: path.join(runRoot, 'local') });
    write(path.join(destination, 'stray.txt'), 'x');
    await assert.rejects(
        bundle({ destination, localCheckout: path.join(runRoot, 'local') }),
        /Unregistered staged file: stray.txt/,
    );
});

test('a dependency that is not registry-locked is refused', async () => {
    const bundle = await load();
    const destination = path.join(runRoot, 'out-linked');
    created.push(destination);
    await assert.rejects(
        bundle({
            destination,
            localCheckout: checkout('unlocked', { version: '1.0.0', resolved: 'file:../dep' }),
        }),
        /must be registry-locked/,
    );
});

test('without the npm dependency or a local checkout the error explains what to do', async () => {
    const bundle = await load();
    const repository = path.join(runRoot, 'repository');
    created.push(repository);
    write(path.join(repository, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: { '': { name: 'x' } },
    });
    await assert.rejects(
        bundle({ destination: path.join(repository, 'dist'), root: repository, localCheckout: '' }),
        /WABADEV_BUNDLE_SOURCE/,
    );
});
