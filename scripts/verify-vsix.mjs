/**
 * Verify a packaged VSIX: it must contain dist/extension.js and the full staged waba-devtools
 * closure (hash-identical to bundle-metadata.json), no symlinks and no build node_modules. The
 * closure is extracted into a fresh OS-temp run root and `waba --version` must print the
 * bundled version from there. A bundle staged from a local checkout is refused unless
 * --allow-local is given (development VSIX only, never a release).
 * Prints the VSIX size; above SIZE_LIMIT it fails and lists the biggest packages.
 * Adapted from vscode-data360/scripts/verify-vsix.mjs.
 *
 * Usage: node scripts/verify-vsix.mjs [--allow-local] [path/to/extension.vsix]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_LIMIT = 25 * 1024 * 1024;
const BUNDLE_PREFIX = 'extension/dist/waba-devtools/';
// Use the ZIP reader that the pinned VSIX packaging tool already depends on.
const require = createRequire(import.meta.url);
const yauzl = createRequire(require.resolve('@vscode/vsce'))('yauzl');

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function openZip(file) {
    return new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: true }, (error, zip) =>
            error ? reject(error) : resolve(zip),
        ),
    );
}

function readStream(zip, entry) {
    return new Promise((resolve, reject) =>
        zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream))),
    );
}

/** Group compressed sizes by the closest package folder registered in the bundle metadata. */
function biggestPackages(compressed, metadata, limit = 15) {
    const roots = Object.keys(metadata.packages)
        .filter((key) => key !== '.')
        .sort((a, b) => b.length - a.length);
    const totals = new Map();
    for (const [file, size] of compressed) {
        const owner = roots.find((root) => file.startsWith(`${root}/`)) ?? '(waba-devtools)';
        totals.set(owner, (totals.get(owner) ?? 0) + size);
    }
    return [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export async function verifyVsix(vsix, { allowLocal = false } = {}) {
    const vsixSize = (await fs.stat(vsix)).size;
    const runRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'waba-vsix-')));
    const marker = randomUUID();
    const markerFile = path.join(runRoot, '.owner');
    await fs.writeFile(markerFile, marker);
    const extraction = path.join(runRoot, 'extension with spaces', 'waba-devtools');
    const created = { files: [markerFile], directories: new Set([runRoot]) };
    const register = async (directory) => {
        let current = directory;
        while (current !== runRoot && !created.directories.has(current)) {
            created.directories.add(current);
            current = path.dirname(current);
        }
        await fs.mkdir(directory, { recursive: true });
    };
    try {
        const compressed = new Map();
        const hashes = new Map();
        let hasExtensionJs = false;
        const zip = await openZip(vsix);
        await new Promise((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.on('entry', async (entry) => {
                try {
                    const name = entry.fileName;
                    assert(
                        !name.startsWith('extension/node_modules/'),
                        `Build dependencies must not ship: ${name}`,
                    );
                    assert.notEqual(
                        (entry.externalFileAttributes >>> 16) & 0o170000,
                        0o120000,
                        `Symlink: ${name}`,
                    );
                    if (name === 'extension/dist/extension.js') hasExtensionJs = true;
                    if (!name.startsWith(BUNDLE_PREFIX) || name.endsWith('/')) {
                        zip.readEntry();
                        return;
                    }
                    const relative = name.slice(BUNDLE_PREFIX.length);
                    assert(
                        !path.isAbsolute(relative) &&
                            !relative.split('/').some((part) => part === '..' || !part),
                    );
                    compressed.set(relative, entry.compressedSize);
                    const output = path.join(extraction, relative);
                    await register(path.dirname(output));
                    await pipeline(
                        await readStream(zip, entry),
                        createWriteStream(output, { flags: 'wx' }),
                    );
                    created.files.push(output);
                    hashes.set(
                        relative,
                        createHash('sha256')
                            .update(await fs.readFile(output))
                            .digest('hex'),
                    );
                    zip.readEntry();
                } catch (error) {
                    zip.close();
                    reject(error);
                }
            });
            zip.readEntry();
        });
        assert(hasExtensionJs, 'VSIX must contain dist/extension.js');
        const metadata = JSON.parse(
            await fs.readFile(path.join(extraction, 'bundle-metadata.json'), 'utf8'),
        );
        for (const [file, hash] of Object.entries(metadata.files)) {
            assert.equal(
                hashes.get(file),
                hash,
                `VSIX must contain the staged file unchanged: ${file}`,
            );
        }
        assert.equal(
            hashes.size,
            Object.keys(metadata.files).length + 1,
            'Only registered runtime files ship',
        );
        assert(
            allowLocal || metadata.source === 'npm-registry',
            `Release VSIX must bundle ${metadata.name} from the npm registry (found ${metadata.source}).`,
        );
        console.log(`VSIX size: ${megabytes(vsixSize)} (${vsix})`);
        console.log(
            `Bundled ${metadata.name} ${metadata.version} (${metadata.source}): ${hashes.size - 1} files, ${Object.keys(metadata.packages).length} packages`,
        );
        if (vsixSize > SIZE_LIMIT) {
            console.error(`VSIX exceeds ${megabytes(SIZE_LIMIT)}. Biggest packages (compressed):`);
            for (const [owner, size] of biggestPackages(compressed, metadata)) {
                console.error(`  ${megabytes(size).padStart(9)}  ${owner}`);
            }
            process.exitCode = 1;
        }
        // Run the extracted copy with no PATH: only this Node executable and the bundle itself.
        const cwd = path.join(runRoot, 'empty project');
        await register(cwd);
        const result = spawnSync(
            process.execPath,
            [path.join(extraction, metadata.cliJs), '--version'],
            {
                cwd,
                env: { ...process.env, PATH: '', Path: '', NODE_PATH: '' },
                encoding: 'utf8',
                timeout: 60_000,
                windowsHide: true,
            },
        );
        assert.equal(result.status, 0, `waba --version: ${result.error || result.stderr}`);
        assert.equal(result.stdout.trim(), metadata.version);
        console.log(`Extracted bundle: waba --version printed ${metadata.version}`);
    } finally {
        await cleanUp(runRoot, marker, created);
    }
}

/** Remove only what this run registered, file by file, deepest directories last; never recursive. */
async function cleanUp(runRoot, marker, created) {
    assert.equal(
        await fs.readFile(path.join(runRoot, '.owner'), 'utf8'),
        marker,
        'Run root ownership',
    );
    const inside = (target) => {
        const relative = path.relative(runRoot, target);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    for (const file of created.files) {
        assert(inside(file), `Refusing to delete outside the run root: ${file}`);
        const stat = await fs.lstat(file);
        assert(stat.isFile() && !stat.isSymbolicLink(), `Refusing to delete a non-file: ${file}`);
        await fs.unlink(file);
    }
    const directories = [...created.directories].sort((a, b) => b.length - a.length);
    for (const directory of directories) {
        assert(directory === runRoot || inside(directory), `Refusing to delete: ${directory}`);
        try {
            await fs.rmdir(directory);
        } catch (error) {
            console.warn(`Left in place (${error.code}): ${directory}`);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const allowLocal = process.argv.includes('--allow-local');
    const file = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
    const vsix = path.resolve(
        file ?? path.join(projectRoot, `${manifest.name}-${manifest.version}.vsix`),
    );
    await verifyVsix(vsix, { allowLocal });
}
