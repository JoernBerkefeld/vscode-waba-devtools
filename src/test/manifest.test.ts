import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repositoryRoot } from './fixture';

interface MenuEntry {
    command?: string;
    submenu?: string;
    when?: string;
}

const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
    contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, MenuEntry[]>;
    };
};
const nls = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.nls.json'), 'utf8'),
) as Record<string, string>;

test('prune is never offered in a context menu', () => {
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
        if (menu === 'commandPalette') {
            continue;
        }
        assert.ok(
            entries.every((entry) => entry.command !== 'waba-devtools.deployPrune'),
            `deployPrune found in ${menu}`,
        );
    }
});

test('every command has a localized title and every menu entry a known command', () => {
    const ids = new Set(manifest.contributes.commands.map((command) => command.command));
    for (const command of manifest.contributes.commands) {
        const key = command.title.replaceAll('%', '');
        assert.ok(nls[key], `missing nls ${key}`);
    }
    for (const entries of Object.values(manifest.contributes.menus)) {
        for (const entry of entries) {
            if (entry.command) {
                assert.ok(ids.has(entry.command), entry.command);
            }
        }
    }
});

test('the backup-set menu clause matches the CLI folder names', () => {
    const clause = manifest.contributes.menus['waba-devtools.submenu'].find(
        (entry) => entry.command === 'waba-devtools.restore',
    )?.when;
    const pattern = /resourceFilename =~ \/(.+)\/\)?$/.exec(clause ?? '')?.[1];
    assert.ok(pattern);
    const regex = new RegExp(pattern);
    assert.ok(regex.test('444444444444444_2026-11-20T18-26-04-123Z_before'));
    assert.ok(regex.test('444444444444444_2026-11-20T18-26-04-123Z_manual'));
    assert.ok(!regex.test('templates'));
});
