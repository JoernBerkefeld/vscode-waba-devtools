import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
Structural subset of `vscode.SecretStorage`.
 */
export interface SecretStoreLike {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}

export type TokenSource = 'environment' | '.env' | 'stored' | 'missing';

const SECRET_PREFIX = 'waba-devtools.token.';

/**
 * Valid environment variable name for a token (same rule as a shell would accept).
 * @param name candidate name
 * @returns {boolean} true when usable
 */
export function isValidTokenName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Keys defined in the project's `.env` file (values are not kept).
 * @param root project folder
 * @returns {Promise<Set<string>>} variable names; empty when there is no readable `.env`
 */
async function dotenvKeys(root: string): Promise<Set<string>> {
    try {
        const text = await readFile(path.join(root, '.env'), 'utf8');
        return new Set(Object.keys(parseEnv(text)));
    } catch {
        return new Set();
    }
}

function isSet(environment: NodeJS.ProcessEnv, name: string): boolean {
    const value = environment[name];
    return typeof value === 'string' && value.length > 0;
}

/**
 * Access tokens kept in VS Code SecretStorage, one per `tokenEnv` name. They reach the CLI only
 * as environment variables of its child process, and only when neither the environment nor the
 * project's `.env` already define the name (the CLI's own precedence: set variables win).
 */
export class TokenStore {
    constructor(
        private readonly secrets: SecretStoreLike,
        private readonly baseEnvironment: NodeJS.ProcessEnv = process.env,
    ) {}

    set(name: string, token: string): PromiseLike<void> {
        return this.secrets.store(SECRET_PREFIX + name, token);
    }

    remove(name: string): PromiseLike<void> {
        return this.secrets.delete(SECRET_PREFIX + name);
    }

    async has(name: string): Promise<boolean> {
        return Boolean(await this.secrets.get(SECRET_PREFIX + name));
    }

    /**
     * Where each name's token would come from for a run in `root`.
     * @param root project folder
     * @param names `tokenEnv` names
     * @returns {Promise<Map<string, TokenSource>>} source per name
     */
    async sources(root: string, names: string[]): Promise<Map<string, TokenSource>> {
        const fromFile = await dotenvKeys(root);
        const result = new Map<string, TokenSource>();
        for (const name of names) {
            if (isSet(this.baseEnvironment, name)) {
                result.set(name, 'environment');
            } else if (fromFile.has(name)) {
                result.set(name, '.env');
            } else if (await this.has(name)) {
                result.set(name, 'stored');
            } else {
                result.set(name, 'missing');
            }
        }
        return result;
    }

    /**
     * The child-process environment: the extension host's environment plus stored tokens for
     * names nothing else defines.
     * @param root project folder (for its `.env`)
     * @param names `tokenEnv` names the run may need
     * @returns {Promise<object>} a new environment object
     */
    async childEnvironment(root: string, names: string[]): Promise<NodeJS.ProcessEnv> {
        const environment: NodeJS.ProcessEnv = { ...this.baseEnvironment };
        const fromFile = await dotenvKeys(root);
        for (const name of names) {
            if (!isValidTokenName(name) || isSet(environment, name) || fromFile.has(name)) {
                continue;
            }
            const token = await this.secrets.get(SECRET_PREFIX + name);
            if (token) {
                environment[name] = token;
            }
        }
        return environment;
    }
}
