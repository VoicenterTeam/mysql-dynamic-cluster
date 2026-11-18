import ts from 'typescript';
import path from 'path';

const root = path.resolve(__dirname, '../..');
// a folder that is never written: the declarations stay in memory, a real dist/ is not read
const outDir = path.join(root, '.declarations-under-test');

// The declarations `npm run build` writes to dist/, built from the same tsconfig
const buildDeclarations = (): Map<string, string> => {
    const configFile = ts.readConfigFile(path.join(root, 'tsconfig.build.json'), ts.sys.readFile);
    const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
    const program = ts.createProgram(config.fileNames, {
        ...config.options, outDir, emitDeclarationOnly: true, sourceMap: false
    });
    const files = new Map<string, string>();
    program.emit(undefined, (fileName, text) => files.set(path.resolve(fileName), text));
    return files;
};

// Compiles the code of an app that imports the built declarations, and returns the errors
// in the app and in the declarations of the package. An error in the declarations of
// another package is not one of this package, and is left out
const compileApp = (
    declarations: Map<string, string>, source: string, appOptions: ts.CompilerOptions = {}
): string[] => {
    const appFile = path.join(outDir, 'app.ts');
    const files = new Map(declarations).set(appFile, source);
    const options: ts.CompilerOptions = {
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        target: ts.ScriptTarget.ES2020,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
        ...appOptions
    };
    const host = ts.createCompilerHost(options);
    const onDisk = {
        fileExists: host.fileExists, readFile: host.readFile,
        directoryExists: host.directoryExists, getSourceFile: host.getSourceFile
    };
    host.fileExists = file => files.has(path.resolve(file)) || onDisk.fileExists(file);
    host.readFile = file => files.get(path.resolve(file)) ?? onDisk.readFile(file);
    host.directoryExists = dir => {
        return path.resolve(dir).startsWith(outDir) || onDisk.directoryExists(dir);
    };
    host.getSourceFile = (file, version, ...rest) => {
        const text = files.get(path.resolve(file));
        if (text === undefined) return onDisk.getSourceFile(file, version, ...rest);
        return ts.createSourceFile(file, text, version, true);
    };
    return ts.getPreEmitDiagnostics(ts.createProgram([appFile], options, host))
        .filter(error => !error.file || files.has(path.resolve(error.file.fileName)))
        .map(error => `${error.code} ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
};

// Same<A, B> is true only when the two types are the same type, not when one fits the other
const app = `
import { createPoolCluster } from './index';
import type {
    IGetConnectionOptions, IClusterConnection, INodeInfo, INodePoolStats, INodeReadyResult,
    INodeCheckError
} from './index';
import type { PoolConnection } from 'mysql2';

type Same<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Cluster = ReturnType<typeof createPoolCluster>;
declare const cluster: Cluster;

export const interfaces: [
    Same<IGetConnectionOptions, { exclude?: number[]; signal?: AbortSignal }>,
    Same<IClusterConnection, { connection: PoolConnection; nodeId: number }>,
    Same<INodeInfo, {
        id: number; name: string; host: string; port: number; isValid: boolean; loadScore: number;
        checkError?: INodeCheckError
    }>,
    Same<INodePoolStats, {
        nodeId: number; used: number; idle: number; pending: number; limit: number
    }>,
    Same<INodeReadyResult, {
        nodeId: number; ok: boolean; error?: Error; checkError?: INodeCheckError
    }>,
    Same<INodeCheckError, { code?: string; errno?: number; sqlState?: string }>
] = [true, true, true, true, true, true];

export const members: [
    Same<
        Cluster['getConnection'], (options?: IGetConnectionOptions) => Promise<IClusterConnection>
    >,
    Same<Cluster['ready'], Promise<INodeReadyResult[]>>,
    Same<Cluster['failWaiting'], (nodeId: number, error: Error) => number>,
    Same<Cluster['getPoolStats'], () => INodePoolStats[]>,
    Same<Cluster['nodes'], () => INodeInfo[]>,
    Same<Cluster['firstReady'], Promise<INodeReadyResult[]>>
] = [true, true, true, true, true, true];

export const calls = [cluster.getConnection(), cluster.getConnection({ exclude: [1] })];

// the signal of a controller, and one that is already aborted
const controller = new AbortController();
export const cancellable = [
    cluster.getConnection({ signal: controller.signal }),
    cluster.getConnection({ exclude: [1], signal: AbortSignal.abort() })
];

// what an app does with the new members, with strict on
export async function refusedLogins(): Promise<number[]> {
    const results = await cluster.firstReady;
    const refused = results.filter(result => result.checkError?.errno === 1045);
    const codes: (string | undefined)[] = cluster.nodes().map(info => info.checkError?.code);
    const states: (string | undefined)[] = results.map(result => result.checkError?.sqlState);
    return codes.length + states.length > 0 ? refused.map(result => result.nodeId) : [];
}
`;

describe('the declarations of the built package', () => {
    let declarations: Map<string, string>;
    beforeAll(() => { declarations = buildDeclarations(); });

    it('are built with an entry file', () => {
        expect(declarations.has(path.join(outDir, 'index.d.ts'))).toBe(true);
    });

    it('export the six node API types and type the six members as agreed', () => {
        expect(compileApp(declarations, app)).toEqual([]);
    });

    it('compile in an app that reads the optional fields exactly', () => {
        expect(compileApp(declarations, app, { exactOptionalPropertyTypes: true })).toEqual([]);
    });

    // such an app checks the declarations of every package it imports, and a default import
    // of a module that has no default export is an error there
    it('compile in an app that has esModuleInterop and skipLibCheck off', () => {
        // TypeScript 6 only takes the two options set to false with ignoreDeprecations
        const errors = compileApp(declarations, app, {
            esModuleInterop: false, allowSyntheticDefaultImports: false, skipLibCheck: false,
            ignoreDeprecations: '6.0'
        });
        expect(errors).toEqual([]);
    });

    // AbortSignal is then the type of @types/node alone, as in an app that never loads the
    // types of a browser
    it('compile in an app that has no dom lib', () => {
        const errors = compileApp(declarations, app, {
            lib: ['lib.es2020.d.ts'], skipLibCheck: false
        });
        expect(errors).toEqual([]);
    });

    // the control: with that lib option a type of the browser is not there
    it('have no dom type to lean on in that app', () => {
        const errors = compileApp(declarations, app + 'export declare const page: Document;\n', {
            lib: ['lib.es2020.d.ts']
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/Document/);
    });

    it.each([
        ['a string', "'abort'"],
        ['a controller', 'new AbortController()'],
        ['null', 'null']
    ])('refuse a signal that is %s', (_name, value) => {
        const call = 'export const wrong = cluster.getConnection({ signal: ' + value + ' });\n';
        const errors = compileApp(declarations, app + call);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^2\d\d\d .*AbortSignal/);
    });

    it('make ready read-only', () => {
        const errors = compileApp(declarations, app + 'cluster.ready = cluster.ready;\n');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^2540 /);
    });

    it('make firstReady read-only', () => {
        const errors = compileApp(declarations, app + 'cluster.firstReady = cluster.firstReady;\n');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^2540 .*firstReady/);
    });

    it.each([
        ['a message', 'message'],
        ['a fatal flag', 'fatal']
    ])('give checkError no field for %s', (_name, field) => {
        const read = 'export const leaked = cluster.nodes()[0].checkError?.' + field + ';\n';
        const errors = compileApp(declarations, app + read);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(new RegExp('^2339 .*' + field));
    });

    // the control: an app that asks for a type the package does not export does not compile
    it('do not export a type that does not exist', () => {
        const errors = compileApp(
            declarations, app + "import type { INodeMissing } from './index';\n"
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^2305 .*INodeMissing/);
    });
});
