jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { Validator } from '../../src/pool/Validator';
import { LoadFactor } from '../../src/pool/LoadFactor';
import Logger from '../../src/utils/Logger';

const status = [
    { Variable_name: 'Threads_running', Value: '3' },
    { Variable_name: 'Threads_connected', Value: '10' }
] as any;

describe('status key missing from SHOW GLOBAL STATUS', () => {
    beforeEach(() => jest.clearAllMocks());

    it('Validator fails the pool and names the key instead of throwing', () => {
        const validator = new Validator({} as any, [
            { key: 'Threads_running', operator: '<', value: 50 },
            { key: 'wsrep_ready', operator: '=', value: 'ON' }
        ] as any);
        expect(validator.check(status)).toBe(false);
        expect((Logger.error as jest.Mock).mock.calls[0][0]).toContain('wsrep_ready');
    });

    it('Validator still passes when every key is present and valid', () => {
        const validator = new Validator({} as any, [{ key: 'Threads_running', operator: '<', value: 50 }] as any);
        expect(validator.check(status)).toBe(true);
    });

    it('LoadFactor skips the missing key and scores the rest', () => {
        const loadFactor = new LoadFactor([
            { key: 'Threads_connected', multiplier: 2 },
            { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
        ] as any);
        expect(loadFactor.check(status)).toBe(20);
        expect((Logger.error as jest.Mock).mock.calls[0][0]).toContain('wsrep_local_recv_queue_avg');
    });
});
