jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import ServiceNames from '../../src/utils/ServiceNames';

describe('ServiceNames.getID', () => {
    const make = (rows: any[]) => {
        const query = jest.fn().mockResolvedValue(rows);
        const names = new ServiceNames({ query } as any, { database: 'db', table: 'Service' });
        return { names, query };
    };

    it('passes the service name as a value, not inside the sql', async () => {
        const { names, query } = make([{ Result: 7 }]);
        const name = "x' OR '1'='1";

        await expect(names.getID(name)).resolves.toBe(7);

        const [sql, values, options] = query.mock.calls[0];
        expect(sql).toBe('SELECT ServiceID AS Result FROM Service WHERE ServiceName LIKE ?;');
        expect(values).toEqual([name]);
        expect(options).toEqual({ maxRetry: 1, database: 'db', redis: false });
    });

    it('asks once per name', async () => {
        const { names, query } = make([{ Result: 7 }]);
        await names.getID('a');
        await names.getID('a');
        expect(query).toHaveBeenCalledTimes(1);
    });
});
