jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import ServiceNames from '../../src/utils/ServiceNames';

describe('ServiceNames.getID', () => {
    // the lookup goes through execute(); query() must not be asked
    const make = (rows: any[]) => {
        const query = jest.fn().mockResolvedValue(rows);
        const execute = jest.fn().mockResolvedValue(rows);
        const cluster = { query, execute } as any;
        const names = new ServiceNames(cluster, { database: 'db', table: 'Service' });
        return { names, query, execute };
    };

    it('sends the service name bound by the server, through execute()', async () => {
        const { names, query, execute } = make([{ Result: 7 }]);
        const name = "x' OR '1'='1";

        await expect(names.getID(name)).resolves.toBe(7);

        const [sql, values, options] = execute.mock.calls[0];
        expect(sql).toBe('SELECT ServiceID AS Result FROM Service WHERE ServiceName LIKE ?;');
        expect(values).toEqual([name]);
        expect(options).toEqual({ maxRetry: 1, database: 'db', redis: false });
        expect(query).not.toHaveBeenCalled();
    });

    // the lookup is a LIKE: a caller may rely on % and _ in the name
    it.each([
        ['%', 'billing%'],
        ['_', 'billing_v_']
    ])('passes a name with the LIKE wildcard %s through unchanged', async (_wildcard, name) => {
        const { names, execute } = make([{ Result: 7 }]);

        await expect(names.getID(name)).resolves.toBe(7);

        expect(execute.mock.calls[0][1]).toStrictEqual([name]);
    });

    it('asks once per name', async () => {
        const { names, execute } = make([{ Result: 7 }]);
        await names.getID('a');
        await names.getID('a');
        expect(execute).toHaveBeenCalledTimes(1);
    });
});
