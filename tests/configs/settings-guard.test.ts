import { createPoolCluster } from '../../index';
import { Settings } from '../../src/utils/Settings';

const messageOf = (run: () => unknown): string => {
    try {
        run();
    } catch (e) {
        return e.message;
    }
    return 'did not throw';
};

describe('createPoolCluster with settings that are not an object', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['a string', 'settings'],
        ['a number', 0],
        ['an array', []]
    ])('throws the error of the settings validation for %s', (_name, settings: any) => {
        const expected = messageOf(() => Settings.mixSettings(settings));
        expect(expected).toContain('Invalid mysql-dynamic-cluster settings:\n');
        expect(messageOf(() => createPoolCluster(settings))).toBe(expected);
    });

    it('throws an Error', () => {
        expect(() => createPoolCluster(null as any)).toThrow(Error);
        // a plain Error, not a subclass such as TypeError
        let thrown: any;
        try { createPoolCluster(null as any); } catch (e) { thrown = e; }
        expect(thrown.constructor).toBe(Error);
    });

    it('throws with no argument', () => {
        const noArgument = createPoolCluster as () => unknown;
        expect(messageOf(noArgument)).toContain('Invalid mysql-dynamic-cluster settings:\n');
    });
});
