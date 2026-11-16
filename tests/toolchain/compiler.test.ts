import ts from 'typescript';
import path from 'path';

// zod 4, which the settings schema uses, ships declarations with syntax an old compiler cannot
// parse: variance annotations need TypeScript 4.7 and `const` type parameters need 5.0.
// The package cannot build on a compiler below 5.0
const parseErrors = (source: string): string[] => {
    const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2015, false);
    // syntax errors of the parse, an array the public typings do not declare
    const errors: ts.Diagnostic[] = (file as any).parseDiagnostics;
    return errors.map(error => `${error.code} ${error.messageText}`);
};

describe('the TypeScript compiler of this repo', () => {
    it('parses a declaration with an `out` type parameter', () => {
        expect(parseErrors('export interface Output<out T> { readonly value: T }')).toEqual([]);
    });

    it('parses a declaration with a `const` type parameter', () => {
        expect(parseErrors('export declare function literal<const T>(value: T): T;')).toEqual([]);
    });
});

// An app on `node16` or `bundler` resolution reads the `exports` map of a package. A deep import
// such as `mysql2/typings/mysql` is not in the map of mysql2, and it would land in the shipped
// declarations, where such an app cannot resolve it
describe('the source of this package', () => {
    it('resolves every import under node16 module resolution', () => {
        const root = path.resolve(__dirname, '../..');
        const program = ts.createProgram([path.join(root, 'index.ts')], {
            module: ts.ModuleKind.Node16,
            moduleResolution: ts.ModuleResolutionKind.Node16,
            target: ts.ScriptTarget.ES2015,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
            types: ['node']
        });
        const unresolved = ts.getPreEmitDiagnostics(program)
            .filter(diagnostic => diagnostic.code === 2307)
            .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));

        expect(unresolved).toEqual([]);
    });
});
