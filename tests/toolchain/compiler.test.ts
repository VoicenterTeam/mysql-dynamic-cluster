import ts from 'typescript';

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
