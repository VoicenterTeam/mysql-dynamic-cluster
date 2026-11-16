import { createHash } from 'crypto';
import Redis from '../../src/Redis/Redis';
import Logger from '../../src/utils/Logger';
import { LOGLEVEL } from '../../src/types/LoggerInterfaces';
import { parseSettings } from '../../src/configs/schema';
import { createPoolCluster } from '../../index';

// No Redis server: a client that records its calls and reports ready when asked
const fakeClient = () => {
    const handlers: { [event: string]: () => void } = {};
    return {
        on: jest.fn((event: string, handler: () => void) => { handlers[event] = handler; }),
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        ready: () => handlers.ready()
    };
};

const SQL = 'SELECT 1';
const HASH = createHash('md5').update(SQL).digest('base64');

const keyReadAfterInit = async (clusterName: string, settings: any): Promise<string> => {
    const client = fakeClient();
    Redis.init(client as any, clusterName, settings);
    client.ready();
    await Redis.get(SQL);
    return client.get.mock.calls[0][0];
};

describe('Redis.init', () => {
    beforeAll(() => {
        const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        Logger.init(LOGLEVEL.SILENT, logger);
    });

    it('reads keys under the cluster name and the key prefix', async () => {
        const settings = parseSettings({}).redis;
        expect(await keyReadAfterInit('one', settings)).toBe('one_mdc:' + HASH);
    });

    it('leaves the key prefix of the settings as it was', () => {
        const settings = parseSettings({ redis: { keyPrefix: 'app:' } }).redis;
        Redis.init(fakeClient() as any, 'one', settings);
        expect(settings.keyPrefix).toBe('app:');
    });

    it('prefixes the cluster name once when it runs twice on the same settings', async () => {
        const settings = parseSettings({}).redis;
        await keyReadAfterInit('one', settings);
        expect(await keyReadAfterInit('one', settings)).toBe('one_mdc:' + HASH);
    });

    it('writes keys under the same prefix it reads', async () => {
        const client = fakeClient();
        Redis.init(client as any, 'one', parseSettings({}).redis);
        client.ready();
        await Redis.set(SQL, 'value');
        expect(client.set.mock.calls[0][0]).toBe('one_mdc:' + HASH);
    });

    it('takes an empty key prefix', async () => {
        const settings = parseSettings({ redis: { keyPrefix: '' } }).redis;
        expect(await keyReadAfterInit('one', settings)).toBe('one_' + HASH);
    });
});

describe('createPoolCluster with a Redis client', () => {
    it('leaves redis.keyPrefix of the loaded settings as the app set it', () => {
        // the library takes a client by its class name
        class Redis { on = jest.fn(); }
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: [{ host: '127.0.0.1' }],
            defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
            useClusterHashing: false,
            redis: { enabled: true, keyPrefix: 'app:' },
            redisInstant: new Redis(),
            logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        } as any);
        expect(cluster).toBeDefined();
        expect(require('../../src/configs').default.current.redis.keyPrefix).toBe('app:');
    });
});
