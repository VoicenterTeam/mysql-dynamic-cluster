import { createPoolCluster } from '../../index';

const settings = () => ({
    clusterName: 'test',
    hosts: [{ host: '127.0.0.1' }],
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
    logs: { level: 'debug' }
});

describe('a logger passed to createPoolCluster', () => {
    it('is the object the library logs to, not a copy of it', () => {
        // a plain object that keeps its state on itself, in a primitive: a deep copy of the
        // logger would count on the copy and leave this one at 0
        const logger = {
            calls: 0,
            first: '',
            note(message: any) { if (!this.calls++) this.first = String(message); },
            debug(message: any) { this.note(message); },
            info(message: any) { this.note(message); },
            warn(message: any) { this.note(message); },
            error(message: any) { this.note(message); }
        };

        createPoolCluster({ ...settings(), logger } as any);

        expect(logger.calls).toBeGreaterThan(0);
        expect(logger.first).toBe('Initialized app');
    });

    it('may refer to itself', () => {
        const logger: any = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        logger.self = logger;

        expect(() => createPoolCluster({ ...settings(), logger } as any)).not.toThrow();
        expect(logger.info).toHaveBeenCalledWith('Initialized app');
    });

    it('is rejected when it lacks a method', () => {
        const logger = { info: jest.fn() };
        expect(() => createPoolCluster({ ...settings(), logger } as any)).toThrow('Invalid logger');
    });
});
