/**
 * Stage the wabadev CLI (package waba-devtools) and its production dependency closure into
 * dist/waba-devtools/ (bin/, lib/, package.json, LICENSE, node_modules/), so the extension can
 * run `node dist/waba-devtools/bin/wabadev.js ...` without a separate install.
 * Adapted from vscode-data360/scripts/bundle-sf-plugin-data.mjs.
 *
 * Two sources:
 * - npm registry (releases): waba-devtools pinned to an exact version in package.json and locked
 *   from https: in this repo's package-lock.json.
 * - local checkout (development, before the first npm release): WABADEV_BUNDLE_SOURCE=<folder of
 *   a waba-devtools checkout>. Its own registry-only lockfile and installed node_modules are used;
 *   nothing is added to this repo's package.json or lockfile. verify-vsix refuses such a bundle
 *   for release packaging.
 *
 * Every staged file is hashed into bundle-metadata.json. A re-run removes only files that the
 * previous metadata registered (single-file unlinks, no recursive deletion) and refuses to touch
 * unregistered files in the output folder.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = 'waba-devtools';
/** Only these top-level entries of the CLI package are needed at runtime. */
const ROOT_ENTRIES = new Set(['bin', 'lib', 'package.json', 'LICENSE']);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function filesBelow(root, relative = '') {
    const files = [];
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.bin') continue;
        const name = path.posix.join(relative, entry.name);
        const stat = await fs.lstat(path.join(root, name));
        if (stat.isSymbolicLink()) throw new Error(`Runtime cannot contain symlinks: ${name}`);
        if (stat.isDirectory()) files.push(...(await filesBelow(root, name)));
        else if (stat.isFile()) files.push(name);
        else throw new Error(`Unsupported runtime file: ${name}`);
    }
    return files.sort();
}

async function inventory(root, relative = '') {
    const files = [];
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name);
        const stat = await fs.lstat(path.join(root, name));
        if (stat.isSymbolicLink()) throw new Error(`Output cannot contain links: ${name}`);
        if (stat.isDirectory()) files.push(...(await inventory(root, name)));
        else if (stat.isFile()) files.push(name);
        else throw new Error(`Unsupported output file: ${name}`);
    }
    return files.sort();
}

function validatePath(file) {
    if (
        !file ||
        path.isAbsolute(file) ||
        file.includes('\\') ||
        file.split('/').some((part) => !part || part === '..' || part === '.')
    ) {
        throw new Error(`Invalid registered runtime path: ${file}`);
    }
}

/**
 * Where the CLI comes from. Registry: an exact-version dependency of this repo, locked from
 * https:. Local checkout: the checkout's own lockfile, whose root package must be waba-devtools.
 * Every other package must be registry-locked (checked while walking the closure).
 */
async function rootSource(base, isLocal) {
    const lockBytes = await fs.readFile(path.join(base, 'package-lock.json'));
    const lock = JSON.parse(lockBytes);
    if (isLocal) {
        if (lock.packages?.['']?.name !== CLI || !lock.packages['']?.version) {
            throw new Error(`${base} is not a ${CLI} checkout with a package-lock.json.`);
        }
        return { source: 'local-checkout', lock, lockBytes, rootKey: '' };
    }
    const rootKey = `node_modules/${CLI}`;
    const spec = lock.packages?.['']?.dependencies?.[CLI];
    const item = lock.packages?.[rootKey];
    if (!spec) {
        throw new Error(
            `${CLI} is not a dependency of this repo yet (it is not on npm). For a development ` +
                `bundle set WABADEV_BUNDLE_SOURCE to the folder of a ${CLI} checkout.`,
        );
    }
    if (
        /^\d+\.\d+\.\d+$/.test(spec) &&
        spec === item?.version &&
        item.integrity &&
        item.resolved?.startsWith('https:')
    ) {
        return { source: 'npm-registry', lock, lockBytes, rootKey };
    }
    throw new Error(`${CLI} must be pinned to an exact registry version (found ${spec}).`);
}

/**
 * @param {object} [options]
 * @param {string} [options.destination] output folder (default dist/waba-devtools)
 * @param {string} [options.localCheckout] a waba-devtools checkout (default $WABADEV_BUNDLE_SOURCE)
 * @param {string} [options.root] this repo (default: the folder above scripts/)
 * @returns {Promise<object>} the written bundle metadata
 */
export async function bundleWabaDevtools({
    destination = path.join(projectRoot, 'dist', CLI),
    localCheckout = process.env.WABADEV_BUNDLE_SOURCE || undefined,
    root = projectRoot,
} = {}) {
    const base = localCheckout ? path.resolve(localCheckout) : root;
    const { source, lock, lockBytes, rootKey } = await rootSource(base, Boolean(localCheckout));
    const files = new Map();
    const packages = {};
    const visited = new Set();
    const relocate = (key) =>
        key === rootKey
            ? ''
            : rootKey && key.startsWith(`${rootKey}/`)
              ? key.slice(rootKey.length + 1)
              : key;
    const resolutions = [];
    async function visit(key, targetOverride) {
        if (visited.has(key)) return;
        visited.add(key);
        const item = lock.packages[key];
        const registryLocked = item?.integrity && item.resolved?.startsWith('https:');
        if (!item || item.link || item.hasInstallScript || !(registryLocked || key === rootKey)) {
            throw new Error(`Runtime dependency must be registry-locked and script-free: ${key}`);
        }
        const sourceDir = path.join(base, key);
        if ((await fs.realpath(sourceDir)) !== path.resolve(sourceDir)) {
            throw new Error(`Linked package: ${key || CLI}`);
        }
        const manifest = JSON.parse(
            await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8'),
        );
        if (manifest.version !== item.version)
            throw new Error(`Installed package differs from lock: ${key || CLI}`);
        const target = targetOverride ?? relocate(key);
        if (packages[target || '.'] && packages[target || '.'].version !== item.version) {
            throw new Error(
                `Closure relocation collision at ${target}: ${packages[target].version} vs ${item.version}`,
            );
        }
        packages[target || '.'] = {
            name: manifest.name,
            version: item.version,
            resolved: item.resolved,
            integrity: item.integrity,
        };
        for (const file of await filesBelow(sourceDir)) {
            if (key === rootKey && !ROOT_ENTRIES.has(file.split('/')[0])) continue;
            const output = path.posix.join(target, file);
            validatePath(output);
            files.set(output, {
                source: path.join(sourceDir, file),
                hash: digest(await fs.readFile(path.join(sourceDir, file))),
            });
        }
        const optional = manifest.optionalDependencies || {};
        const dependencies = {
            ...manifest.dependencies,
            ...manifest.peerDependencies,
            ...optional,
        };
        const selections = [];
        for (const name of Object.keys(dependencies)) {
            // Node's upward node_modules lookup, as recorded in the lockfile.
            let parent = key;
            let selected;
            while (true) {
                const candidate = path.posix.join(parent, 'node_modules', name);
                if (lock.packages[candidate]) {
                    try {
                        await fs.access(path.join(base, candidate, 'package.json'));
                        selected = candidate;
                        break;
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                    }
                }
                if (!parent) break;
                const index = parent.lastIndexOf('/node_modules/');
                parent = index < 0 ? '' : parent.slice(0, index);
            }
            if (selected) selections.push({ name, selected });
            else if (!(name in optional) && !manifest.peerDependenciesMeta?.[name]?.optional) {
                throw new Error(`Missing installed runtime dependency: ${key || CLI} -> ${name}`);
            }
        }
        // A package nested below its dependent claims its relocated path first; a hoisted package
        // that would then collide with a different version is nested below its own dependent.
        const own = `${key}/node_modules/`;
        selections.sort(
            (a, b) => Number(b.selected.startsWith(own)) - Number(a.selected.startsWith(own)),
        );
        for (const { name, selected } of selections) {
            const wanted = lock.packages[selected].version;
            const preferred = relocate(selected);
            const childTarget =
                packages[preferred] && packages[preferred].version !== wanted
                    ? path.posix.join(target || '.', 'node_modules', name)
                    : preferred;
            resolutions.push({ from: target || '.', name, version: wanted });
            await visit(selected, childTarget);
        }
    }
    await visit(rootKey);
    // Prove the relocated layout resolves every dependency to the locked version.
    for (const { from, name, version } of resolutions) {
        let directory = from === '.' ? '' : from;
        let found;
        while (true) {
            found = packages[path.posix.join(directory, 'node_modules', name) || '.'];
            if (found || !directory) break;
            const index = directory.lastIndexOf('/node_modules/');
            directory = index < 0 ? '' : directory.slice(0, index);
        }
        if (found?.version !== version) {
            throw new Error(
                `Relocated runtime resolves ${from} -> ${name} to ${found?.version}, expected ${version}`,
            );
        }
    }
    const manifest = JSON.parse(
        await fs.readFile(path.join(base, rootKey, 'package.json'), 'utf8'),
    );
    if (manifest.name !== CLI || manifest.type !== 'module' || !manifest.bin?.wabadev) {
        throw new Error(`Expected the ${CLI} ESM package with the wabadev binary.`);
    }
    if (!files.has('bin/wabadev.js') || typeof manifest.engines?.node !== 'string') {
        throw new Error(`Expected ${CLI} with bin/wabadev.js and engines.node.`);
    }
    const hashes = Object.fromEntries(
        [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, item]) => [file, item.hash]),
    );
    const metadata = {
        schemaVersion: 1,
        source,
        lockSha256: digest(lockBytes),
        name: manifest.name,
        version: manifest.version,
        nodeEngine: manifest.engines.node,
        cliJs: 'bin/wabadev.js',
        packages,
        files: hashes,
    };
    destination = path.resolve(destination);
    for (
        let current = destination;
        current !== path.dirname(current);
        current = path.dirname(current)
    ) {
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) {
                throw new Error(`Output cannot traverse a link: ${current}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    const metadataPath = path.join(destination, 'bundle-metadata.json');
    let previous;
    try {
        previous = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    for (const file of Object.keys(previous?.files || {})) validatePath(file);
    try {
        for (const file of await inventory(destination)) {
            if (file !== 'bundle-metadata.json' && !previous?.files[file]) {
                throw new Error(`Unregistered staged file: ${file}`);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    for (const [file, item] of files) {
        const content = await fs.readFile(item.source);
        if (digest(content) !== item.hash)
            throw new Error(`Installed runtime changed during staging: ${file}`);
        await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
        await fs.writeFile(path.join(destination, file), content);
    }
    // Remove only single files the previous run registered and this run no longer stages.
    for (const file of Object.keys(previous?.files || {})) {
        if (!files.has(file)) await fs.unlink(path.join(destination, file));
    }
    if (digest(await fs.readFile(path.join(base, 'package-lock.json'))) !== metadata.lockSha256) {
        throw new Error('Dependency lock changed during staging.');
    }
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(
        `${CLI} ${metadata.version} (${source}) staged: ${files.size} files, ${visited.size} packages`,
    );
    return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await bundleWabaDevtools();
}
