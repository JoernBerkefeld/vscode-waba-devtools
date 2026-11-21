/**
 * `--require` hook that redirects the bare `vscode` specifier to {@link vscodeStub}
 * so extension modules can load under `node --test` without a VS Code host.
 */
import Module from 'node:module';
import * as vscodeStub from './vscodeStub';

const loadable = Module as typeof Module & {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
};

const originalLoad = loadable._load.bind(Module);
loadable._load = function patchedLoad(request, parent, isMain) {
    return request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
};
