/**
 * `vscode` surface for host-free `node --test` runs, with a recorder (`host`) the tests use to
 * answer dialogs and inspect what the extension showed. Only what the extension uses is faked.
 */
import path from 'node:path';

export const version = '1.101.0-mock';

type Answer<T> = T | ((items: unknown) => T);
type PickAnswer = string | ((items: unknown) => unknown);

interface Message {
    level: 'info' | 'warning' | 'error';
    text: string;
    modal: boolean;
    detail?: string;
    buttons: string[];
}

/**
Test recorder and answer queues.
 */
export const host = {
    commands: new Map<string, (...arguments_: unknown[]) => unknown>(),
    executed: [] as Array<{ id: string; args: unknown[] }>,
    contexts: new Map<string, unknown>(),
    messages: [] as Message[],
    output: [] as string[],
    documents: [] as Array<{ language?: string; content?: string }>,
    settings: new Map<string, unknown>(),
    workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
    /**
    Answers for quick picks, in order. A function receives the offered items.
     */
    quickPicks: [] as PickAnswer[],
    /**
    Answers for message dialogs with buttons, in order (undefined = dismissed).
     */
    messageAnswers: [] as Array<string | undefined>,
    inputAnswers: [] as Array<string | undefined>,
    openDialogAnswers: [] as Array<string | undefined>,
};

/**
 * Clear the recorder and every answer queue.
 */
export function resetHost(): void {
    for (const list of [
        host.executed,
        host.messages,
        host.output,
        host.documents,
        host.quickPicks,
        host.messageAnswers,
        host.inputAnswers,
        host.openDialogAnswers,
    ]) {
        list.length = 0;
    }
}

export class Uri {
    static file(fsPath: string): Uri {
        return new Uri(path.resolve(fsPath));
    }
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
}

export class EventEmitter<T> {
    private listeners: Array<(value: T) => unknown> = [];
    readonly event = (listener: (value: T) => unknown): { dispose(): void } => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((item) => item !== listener);
            },
        };
    };
    fire(value: T): void {
        for (const listener of this.listeners) {
            listener(value);
        }
    }
    dispose(): void {
        this.listeners = [];
    }
}

export class ThemeIcon {
    constructor(readonly id: string) {}
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export class TreeItem {
    description?: string;
    tooltip?: string;
    contextValue?: string;
    resourceUri?: Uri;
    iconPath?: ThemeIcon;
    command?: unknown;
    constructor(
        readonly label: string,
        readonly collapsibleState: TreeItemCollapsibleState,
    ) {}
}

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum ProgressLocation {
    Notification = 15,
}

const disposable = { dispose: (): void => {} };

function nextAnswer<T>(queue: Array<Answer<T>>, items: unknown): T | undefined {
    if (queue.length === 0) {
        return undefined;
    }
    const answer = queue.shift() as Answer<T>;
    return typeof answer === 'function' ? (answer as (items: unknown) => T)(items) : answer;
}

function message(level: Message['level']) {
    return async (text: string, ...rest: unknown[]): Promise<string | undefined> => {
        const options =
            rest[0] && typeof rest[0] === 'object'
                ? (rest.shift() as { modal?: boolean; detail?: string })
                : {};
        const buttons = rest as string[];
        host.messages.push({
            level,
            text,
            modal: Boolean(options.modal),
            detail: options.detail,
            buttons,
        });
        return buttons.length > 0 ? host.messageAnswers.shift() : undefined;
    };
}

export const window = {
    createOutputChannel: () => ({
        appendLine: (line: string): void => {
            host.output.push(line);
        },
        show: () => {},
        dispose: () => {},
    }),
    createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: '',
        show: () => {},
        hide: () => {},
        dispose: () => {},
    }),
    showInformationMessage: message('info'),
    showWarningMessage: message('warning'),
    showErrorMessage: message('error'),
    showQuickPick: async (items: unknown) =>
        nextAnswer(host.quickPicks as Array<Answer<unknown>>, await items),
    showInputBox: async () => host.inputAnswers.shift(),
    showOpenDialog: async () => {
        const answer = host.openDialogAnswers.shift();
        return answer ? [Uri.file(answer)] : undefined;
    },
    withProgress: async <T>(
        _options: unknown,
        task: (progress: unknown, token: unknown) => Promise<T>,
    ): Promise<T> =>
        task(
            { report: () => {} },
            { isCancellationRequested: false, onCancellationRequested: () => disposable },
        ),
    showTextDocument: async () => ({}),
    registerTreeDataProvider: () => disposable,
};

export const commands = {
    registerCommand: (id: string, handler: (...arguments_: unknown[]) => unknown) => {
        host.commands.set(id, handler);
        return disposable;
    },
    executeCommand: async (id: string, ...arguments_: unknown[]) => {
        host.executed.push({ id, args: arguments_ });
        if (id === 'setContext') {
            host.contexts.set(arguments_[0] as string, arguments_[1]);
            return;
        }
        return host.commands.get(id)?.(...arguments_);
    },
};

export const workspace = {
    get workspaceFolders() {
        return host.workspaceFolders;
    },
    getConfiguration: (section: string) => ({
        get: <T>(key: string, fallback: T): T =>
            (host.settings.has(`${section}.${key}`)
                ? host.settings.get(`${section}.${key}`)
                : fallback) as T,
    }),
    createFileSystemWatcher: () => ({
        onDidCreate: () => disposable,
        onDidDelete: () => disposable,
        onDidChange: () => disposable,
        dispose: () => {},
    }),
    onDidChangeWorkspaceFolders: () => disposable,
    openTextDocument: async (options: { language?: string; content?: string }) => {
        host.documents.push(options);
        return {};
    },
};
