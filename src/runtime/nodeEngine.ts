/**
 * Minimal `engines.node` evaluation for the plugin's own requirement (for example
 * `^22.22.2 || ^24.15.0`). Supports `||` alternatives of space-separated comparators
 * (`^`, `~`, `>=`, `>`, `<=`, `<`, `=` or a bare version). Anything else is reported as
 * unparseable so the caller can treat the package as broken instead of guessing.
 */
export type Version = readonly [number, number, number];

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;
const comparatorPattern = /^(\^|~|>=|<=|>|<|=)?v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a plain `major.minor.patch` version, optionally prefixed with `v`.
 * @param text e.g. the output of `node --version`
 * @returns {Version | undefined} the parsed version or `undefined`
 */
export function parseVersion(text: string): Version | undefined {
    const match = versionPattern.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Version, b: Version): number {
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) {
            return a[index] - b[index];
        }
    }
    return 0;
}

type Check = (version: Version) => boolean;

function comparator(token: string): Check | undefined {
    const match = comparatorPattern.exec(token);
    if (!match) {
        return undefined;
    }
    const operator = match[1] ?? '=';
    const base: Version = [Number(match[2]), Number(match[3]), Number(match[4])];
    switch (operator) {
        case '^': {
            const upper: Version =
                base[0] > 0
                    ? [base[0] + 1, 0, 0]
                    : base[1] > 0
                      ? [0, base[1] + 1, 0]
                      : [0, 0, base[2] + 1];
            return (version) => compare(version, base) >= 0 && compare(version, upper) < 0;
        }
        case '~': {
            const upper: Version = [base[0], base[1] + 1, 0];
            return (version) => compare(version, base) >= 0 && compare(version, upper) < 0;
        }
        case '>=': {
            return (version) => compare(version, base) >= 0;
        }
        case '>': {
            return (version) => compare(version, base) > 0;
        }
        case '<=': {
            return (version) => compare(version, base) <= 0;
        }
        case '<': {
            return (version) => compare(version, base) < 0;
        }
        default: {
            return (version) => compare(version, base) === 0;
        }
    }
}

/**
 * Compile an `engines.node` range.
 * @param range the range string
 * @returns {Check | undefined} a predicate, or `undefined` when the range uses syntax this module does not support
 */
export function parseEngineRange(range: string): Check | undefined {
    const alternatives = range.split('||').map((part) => part.trim());
    if (alternatives.length === 0 || alternatives.some((part) => !part)) {
        return undefined;
    }
    const compiled: Check[][] = [];
    for (const alternative of alternatives) {
        const checks = alternative.split(/\s+/).map((token) => comparator(token));
        if (checks.some((check) => !check)) {
            return undefined;
        }
        compiled.push(checks as Check[]);
    }
    return (version) => compiled.some((checks) => checks.every((check) => check(version)));
}
