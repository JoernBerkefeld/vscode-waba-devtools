/**
 * The `--json` report shapes of the wabadev CLI (waba-devtools lib/commands.js and
 * lib/compare.js). Only the fields the extension reads are typed; everything is optional where
 * the CLI may leave it out.
 */

export type DeployActionName =
    'create' | 'update' | 'unchanged' | 'blocked' | 'skipped' | 'extra' | 'delete';

export interface DeployAction {
    name: string;
    language: string;
    action: DeployActionName;
    status?: string;
    note?: string;
    result?: string;
    error?: string;
    statusAfter?: string;
    /**
    Hash of the body and the live template it replaces (create/update/delete); checked by `--expect`.
     */
    fingerprint?: string;
}

export interface DeployTarget {
    stage?: string;
    stages?: string[];
    wabaId: string;
    actions: DeployAction[];
    error?: string;
    backup?: string;
    backupAfter?: string;
    backupAfterError?: string;
}

export interface RowError {
    row?: number;
    message: string;
}

export interface DeployReport {
    command: 'deploy';
    dryRun: boolean;
    source?: { type: string; stage?: string; wabaId?: string; csv?: string; dir?: string };
    rowErrors?: RowError[];
    targets: DeployTarget[];
    ok: boolean;
}

export interface FileResult {
    name: string;
    language: string;
    result: string;
    path: string;
}

export interface RetrieveReport {
    command: 'retrieve';
    stage?: string;
    wabaId: string;
    files: FileResult[];
    ok: boolean;
}

export interface ImportReport {
    command: 'import';
    csv: string;
    files: FileResult[];
    rowErrors?: RowError[];
    csvCleanup?: unknown;
    ok: boolean;
}

export interface CheckReport {
    command: 'check';
    entries: Array<{
        stage: string;
        wabaId: string;
        tokenEnv: string;
        wabaName?: string;
        ok: boolean;
        error?: string;
    }>;
    ok: boolean;
}

export interface ListReport {
    command: 'list';
    wabas: Array<{
        stage?: string;
        wabaId: string;
        templates?: Array<{ name: string; language: string; category?: string; status?: string }>;
        error?: string;
    }>;
    ok: boolean;
}

export interface DiscoverReport {
    command: 'discover';
    /**
    What Meta says about the token; missing when Meta refused to describe it.
     */
    tokenInfo?: { type?: string; expiresAt?: string | null };
    wabas: Array<{
        wabaId: string;
        name?: string;
        phoneNumbers?: Array<{ displayPhoneNumber?: string; verifiedName?: string }>;
        error?: string;
    }>;
    ok: boolean;
}

export interface BackupReport {
    command: 'backup';
    sets: Array<{
        stage?: string;
        wabaId: string;
        backup?: string;
        templateCount?: number;
        error?: string;
    }>;
    ok: boolean;
}

export interface CompareSide {
    dir?: string;
    wabaId: string;
    stage?: string;
    createdAt?: string;
    phase?: string;
}

export interface CompareTemplate {
    name: string;
    language: string;
    category?: string;
    status?: string;
}

export interface CompareReport {
    command: 'compare';
    before: CompareSide;
    after: CompareSide;
    sameWaba: boolean;
    added: CompareTemplate[];
    removed: CompareTemplate[];
    changed: Array<
        CompareTemplate & {
            statusBefore?: string;
            changes: Array<{ field: string; before?: unknown; after?: unknown }>;
        }
    >;
    unchanged: number;
    ok: boolean;
}

export type Report =
    | DeployReport
    | RetrieveReport
    | ImportReport
    | CheckReport
    | ListReport
    | DiscoverReport
    | BackupReport
    | CompareReport;
