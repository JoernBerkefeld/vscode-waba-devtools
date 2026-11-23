#!/usr/bin/env node
// Fake waba for the extension tests. Records each call (arguments and the values of the
// variables named in FAKE_WABADEV_WATCH) to FAKE_WABADEV_LOG as one JSON line, and answers from
// FAKE_WABADEV_RESPONSES: {"<command>": [{exitCode, stdout, stderr}, …]}, the n-th call of a
// command getting the n-th answer (the last one repeats).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const command = argv[0] ?? '';
const log = process.env.FAKE_WABADEV_LOG;
const watched = (process.env.FAKE_WABADEV_WATCH ?? '').split(',').filter(Boolean);
let previous = 0;
if (log && existsSync(log)) {
    previous = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .filter((line) => JSON.parse(line).argv[0] === command).length;
}
if (log) {
    const environment = Object.fromEntries(
        watched.map((name) => [name, process.env[name] ?? null]),
    );
    const expectIndex = argv.indexOf('--expect');
    const expected =
        expectIndex === -1 ? undefined : JSON.parse(readFileSync(argv[expectIndex + 1], 'utf8'));
    appendFileSync(
        log,
        `${JSON.stringify({ argv, env: environment, cwd: process.cwd(), expected })}\n`,
    );
}
const responses = process.env.FAKE_WABADEV_RESPONSES
    ? JSON.parse(readFileSync(process.env.FAKE_WABADEV_RESPONSES, 'utf8'))
    : {};
const DEFAULTS = {
    deploy: { dryRun: argv.includes('--dry-run'), targets: [], rowErrors: [] },
    check: { entries: [] },
    retrieve: { wabaId: '0', files: [] },
    import: { csv: '', files: [], rowErrors: [] },
    list: { wabas: [] },
    discover: { wabas: [] },
    backup: { sets: [] },
};
const list = responses[command] ?? [
    { exitCode: 0, stdout: { command, ...DEFAULTS[command], ok: true } },
];
const answer = list[Math.min(previous, list.length - 1)];
if (answer.stderr) {
    process.stderr.write(`${answer.stderr}\n`);
}
if (answer.stdout !== undefined) {
    process.stdout.write(
        typeof answer.stdout === 'string' ? answer.stdout : JSON.stringify(answer.stdout),
    );
}
process.exitCode = answer.exitCode ?? 0;
