import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fillHealthCheck, parseSettings } from '../../src/configs/schema';
import { Settings } from '../../src/utils/Settings';
import { IUserSettings } from '../../src/types/SettingsInterfaces';
import { IUserPoolSettings } from '../../src/types/PoolSettingsInterfaces';

const root = path.resolve(__dirname, '../..');

// What the convict schema of 3.2.2 returned with a clean environment,
// without showMetricKeys and redisInstant, which 4.0.0 removed from the schema
const defaultsOf322 = {
    defaultPoolSettings: {
        user: '', password: '', database: '', port: 3306,
        connectionLimit: 10, minConnections: 1, idleTimeout: 30000, idleCheckInterval: 10000,
        validators: [
            { key: 'wsrep_ready', operator: '=', value: 'ON' },
            { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
            { key: 'Threads_running', operator: '<', value: 50 }
        ],
        loadFactors: [
            { key: 'Connections', multiplier: 2 },
            { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
        ],
        timerCheckRange: { start: 5000, end: 15000 },
        timerCheckMultiplier: 1.3, queryTimeout: 120000, slowQueryTime: 1, redisFactor: 1,
        // not in 3.2.2: added in 5.0.0, which resets a dirty connection instead of changing
        // the user before every query
        resetTimeout: 1000,
        // not in 3.2.2: added in 5.0.0 with execute()
        maxPreparedStatements: 100
    },
    serviceMetrics: { database: 'swagger_realtime', table: 'Service' },
    clusterHashing: { nextCheckTime: 5000, dbName: 'mysql_dynamic_cluster' },
    hosts: [],
    useClusterHashing: true,
    clusterName: 'demo',
    errorRetryCount: 2,
    redis: {
        enabled: false, keyPrefix: 'mdc:', expire: 1000000, expiryMode: 'EX',
        algorithm: 'md5', encoding: 'base64', clearOnStart: false
    },
    logs: { level: 'info' }
};

// Every environment variable the convict schema of 3.2.2 was bound to
const envNamesOf322 = [
    'LOG_AMQP_BINDINGS_ENABLED', 'LOG_AMQP_BINDINGS_PATTERN', 'LOG_AMQP_EXCHANGE_NAME',
    'LOG_AMQP_EXCHANGE_TYPE', 'LOG_AMQP_HEARTBEAT_MASTER', 'LOG_AMQP_HOST_MASTER',
    'LOG_AMQP_PASSWORD_MASTER', 'LOG_AMQP_PORT_MASTER', 'LOG_AMQP_prefetch', 'LOG_AMQP_QUEUE_NAME',
    'LOG_AMQP_SSL_MASTER', 'LOG_AMQP_TOPIC', 'LOG_AMQP_USERNAME_MASTER', 'LOG_AMQP_VHOST_MASTER',
    'LOGGER_LOG_LEVEL', 'LOGGER_LOG_OUTPUT', 'MYSQL_CLUSTER_CHECK_TIME', 'MYSQL_CLUSTER_DB_NAME',
    'MYSQL_CLUSTER_NAME', 'MYSQL_DEFAULT_CONNECTION_LIMIT', 'MYSQL_DEFAULT_DATABASE',
    'MYSQL_DEFAULT_IDLE_CHECK_INTERVAL', 'MYSQL_DEFAULT_IDLE_TIMEOUT',
    'MYSQL_DEFAULT_MIN_CONNECTIONS', 'MYSQL_DEFAULT_PASSWORD', 'MYSQL_DEFAULT_PORT',
    'MYSQL_DEFAULT_QUERY_SLOW', 'MYSQL_DEFAULT_QUERY_TIMEOUT', 'MYSQL_DEFAULT_REDIS_FACTOR',
    'MYSQL_DEFAULT_USER', 'MYSQL_HOSTS', 'MYSQL_REDIS_ALGORITHM', 'MYSQL_REDIS_CLEAR_ON_START',
    'MYSQL_REDIS_ENABLE', 'MYSQL_REDIS_ENCODING', 'MYSQL_REDIS_EXPIRE', 'MYSQL_REDIS_EXPIRE_MODE',
    'MYSQL_REDIS_INSTANT', 'MYSQL_REDIS_PREFIX', 'MYSQL_RETRY_COUNT',
    'MYSQL_SERVICE_METRICS_DATABASE', 'MYSQL_SERVICE_METRICS_TABLE', 'MYSQL_SHOW_METRIC_KEYS',
    'MYSQL_USE_CLUSTER_HASHING'
];

const base = (): IUserSettings => ({
    clusterName: 'test',
    hosts: [{ host: '127.0.0.1' }],
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd' }
});

const errorOf = (settings: unknown): string => {
    try {
        parseSettings(settings);
    } catch (e) {
        return e.message;
    }
    return '';
};

// The entry point and the config singleton, in a module registry of their own
const loadPackage = () => {
    let loaded: { createPoolCluster: (settings?: any) => any, config: any, Logger: any };
    jest.isolateModules(() => {
        loaded = {
            createPoolCluster: require('../../index').createPoolCluster,
            config: require('../../src/configs').default,
            Logger: require('../../src/utils/Logger').default
        };
    });
    return loaded;
};

const makeLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('settings defaults', () => {
    it('are the same as the convict schema of 3.2.2', () => {
        expect(parseSettings({})).toEqual(defaultsOf322);
    });

    it('are what the config holds before createPoolCluster runs', () => {
        expect(loadPackage().config.current).toEqual(defaultsOf322);
    });

    it('are built per parse, so one result never changes the next', () => {
        const first = parseSettings({});
        first.defaultPoolSettings.validators[0].key = 'changed';
        first.defaultPoolSettings.loadFactors[0].multiplier = 99;

        expect(parseSettings({})).toEqual(defaultsOf322);
    });

    it('fill in around what the app passes, nested objects too', () => {
        const settings = parseSettings({
            clusterName: 'c',
            defaultPoolSettings: { user: 'u', timerCheckRange: { start: 1, end: 2 } },
            redis: { enabled: true },
            logs: { level: 'debug' }
        });

        expect(settings.clusterName).toBe('c');
        expect(settings.defaultPoolSettings.user).toBe('u');
        expect(settings.defaultPoolSettings.port).toBe(3306);
        expect(settings.defaultPoolSettings.timerCheckRange).toEqual({ start: 1, end: 2 });
        expect(settings.redis).toEqual({ ...defaultsOf322.redis, enabled: true });
        expect(settings.logs.level).toBe('debug');
    });

    it('are replaced, not extended, by an array the app passes', () => {
        const validators = [{ key: 'wsrep_ready', operator: '=', value: 'ON' }];
        const parsed = parseSettings({ defaultPoolSettings: { validators } });
        expect(parsed.defaultPoolSettings.validators).toEqual(validators);
    });
});

describe('settings validation', () => {
    it('accepts a full valid settings object', () => {
        const host = {
            host: 'a', id: 1, name: 'n', port: 3307, redisExpire: 10,
            validators: [{ key: 'k', operator: 'Like', value: 5 }]
        };
        expect(() => parseSettings({
            ...base(),
            hosts: [host],
            errorRetryCount: 3,
            useClusterHashing: false,
            clusterHashing: { nextCheckTime: 1000, dbName: 'x' },
            serviceMetrics: { database: 'db', table: 't' },
            redis: { enabled: true, algorithm: 'sha256', encoding: 'hex' },
            logs: { level: 'silent' }
        })).not.toThrow();
    });

    // one row per strict object of the schema
    it.each([
        ['the top level', {}, ''],
        ['defaultPoolSettings', { defaultPoolSettings: { bogus: 1 } }, 'defaultPoolSettings'],
        ['defaultPoolSettings.timerCheckRange',
            { defaultPoolSettings: { timerCheckRange: { bogus: 1 } } },
            'defaultPoolSettings.timerCheckRange'],
        ['a default validator',
            { defaultPoolSettings: { validators: [{ key: 'k', operator: '=', value: 1, bogus: 1 }] } },
            'defaultPoolSettings.validators[0]'],
        ['a default load factor',
            { defaultPoolSettings: { loadFactors: [{ key: 'k', multiplier: 1, bogus: 1 }] } },
            'defaultPoolSettings.loadFactors[0]'],
        ['a host', { hosts: [{ host: 'a', bogus: 1 }] }, 'hosts[0]'],
        ['a host timerCheckRange',
            { hosts: [{ host: 'a', timerCheckRange: { bogus: 1 } }] },
            'hosts[0].timerCheckRange'],
        ['clusterHashing', { clusterHashing: { bogus: 1 } }, 'clusterHashing'],
        ['serviceMetrics', { serviceMetrics: { bogus: 1 } }, 'serviceMetrics'],
        ['redis', { redis: { bogus: 1 } }, 'redis'],
        ['logs', { logs: { bogus: 1 } }, 'logs']
    ])('rejects an unknown key in %s', (_where, extra, at) => {
        const settings = at ? { ...base(), ...extra } : { ...base(), bogus: 1 };
        const lines = errorOf(settings).split('\n');

        expect(lines[0]).toBe('Invalid mysql-dynamic-cluster settings:');
        expect(lines).toContain('✖ Unrecognized key: "bogus"');
        if (at) expect(lines).toContain(`  → at ${at}`);
    });

    it.each([
        ['showMetricKeys', { showMetricKeys: true }],
        ['amqp_logs', { amqp_logs: {} }],
        ['redisSettings', { redisSettings: { enabled: true } }],
        ['globalPoolSettings', { globalPoolSettings: {} }],
        // 4.x only: 5.0.0 always escapes named values
        ['escapeNamedValues', { escapeNamedValues: false }]
    ])('rejects the removed or misnamed key %s', (key, extra) => {
        expect(errorOf({ ...base(), ...extra })).toContain(`Unrecognized key: "${key}"`);
    });

    it('rejects logs.output, which 4.0.0 removed', () => {
        const message = errorOf({ ...base(), logs: { output: 'amqp' } });
        expect(message).toContain('Unrecognized key: "output"');
        expect(message).toContain('→ at logs');
    });

    it.each([
        ['errorRetryCount', { errorRetryCount: 'abc' }],
        ['defaultPoolSettings.port', { defaultPoolSettings: { port: '3306' } }],
        ['redis.enabled', { redis: { enabled: 'yes' } }],
        ['redis.algorithm', { redis: { algorithm: 'sha1' } }],
        ['logs.level', { logs: { level: 'DEBUG' } }],
        ['hosts[0].host', { hosts: [{ name: 'no host' }] }],
        ['hosts[0].validators[0].operator',
            { hosts: [{ host: 'a', validators: [{ key: 'k', operator: '>=', value: 1 }] }] }],
        ['defaultPoolSettings.validators[0].value',
            { defaultPoolSettings: { validators: [{ key: 'k', operator: '=', value: true }] } }]
    ])('rejects a wrong value at %s and names the whole path', (wrongPath, extra) => {
        const lines = errorOf({ ...base(), ...extra }).split('\n');

        expect(lines[0]).toBe('Invalid mysql-dynamic-cluster settings:');
        expect(lines).toContain(`  → at ${wrongPath}`);
    });

    it('lists every problem in one error', () => {
        const message = errorOf({ ...base(), errorRetryCount: 'abc', bogusKey: 1 });
        expect(message).toContain('→ at errorRetryCount');
        expect(message).toContain('Unrecognized key: "bogusKey"');
    });

    it('does not echo setting values, such as a password, in the error', () => {
        const defaultPoolSettings = { user: 'u', password: 12345678, database: 'd' };
        const message = errorOf({ ...base(), defaultPoolSettings });
        expect(message).toContain('→ at defaultPoolSettings.password');
        expect(message).not.toContain('12345678');
    });
});

describe('Settings.mixSettings', () => {
    it('gives every host the default pool settings it left out', () => {
        const mixed = Settings.mixSettings({ ...base(), hosts: [{ host: 'a', port: 3307 }] });
        expect(mixed.hosts[0]).toMatchObject({
            host: 'a', port: 3307, user: 'u', password: 'p', database: 'd', connectionLimit: 10
        });
    });

    it('fills in the half of timerCheckRange the app left out, for the defaults and a host', () => {
        const settings = Settings.mixSettings({
            ...base(),
            defaultPoolSettings: {
                user: 'u', password: 'p', database: 'd', timerCheckRange: { start: 1000 }
            },
            hosts: [{ host: 'a' }, { host: 'b', timerCheckRange: { end: 30000 } }]
        });

        expect(settings.defaultPoolSettings.timerCheckRange).toEqual({ start: 1000, end: 15000 });
        expect(settings.hosts[0].timerCheckRange).toEqual({ start: 1000, end: 15000 });
        expect(settings.hosts[1].timerCheckRange).toEqual({ start: 1000, end: 30000 });
    });

    it('treats a host key set to undefined as left out', () => {
        const hosts = [
            { host: 'a', port: undefined, timerCheckRange: undefined },
            { host: 'b', timerCheckRange: { start: undefined, end: 9 } }
        ];
        const mixed = Settings.mixSettings({ ...base(), hosts });

        expect(mixed.hosts[0].port).toBe(3306);
        expect(mixed.hosts[0].timerCheckRange).toEqual({ start: 5000, end: 15000 });
        expect(mixed.hosts[1].timerCheckRange).toEqual({ start: 5000, end: 9 });
    });

    it('adds the validators of a host to the default ones, as before', () => {
        const extra = { key: 'Threads_running', operator: '<' as const, value: 5 };
        const mixed = Settings.mixSettings({ ...base(), hosts: [{ host: 'a', validators: [extra] }] });
        expect(mixed.hosts[0].validators).toHaveLength(4);
        expect(mixed.hosts[0].validators[3]).toEqual(extra);
    });

    it('adds the loadFactors of a host after the default ones', () => {
        const extra = { key: 'Threads_running', multiplier: 3 };
        const mixed = Settings.mixSettings({ ...base(), hosts: [{ host: 'a', loadFactors: [extra] }] });
        expect(mixed.hosts[0].loadFactors).toEqual([
            { key: 'Connections', multiplier: 2 },
            { key: 'wsrep_local_recv_queue_avg', multiplier: 10 },
            extra
        ]);
    });

    it('builds a host with exactly the default keys plus its own', () => {
        const mixed = Settings.mixSettings({
            ...base(),
            hosts: [{ host: 'a', id: 7, name: 'first', redisExpire: 60, connectionLimit: 3 }]
        });
        expect(mixed.hosts[0]).toStrictEqual({
            ...defaultsOf322.defaultPoolSettings,
            user: 'u', password: 'p', database: 'd',
            host: 'a', id: 7, name: 'first', redisExpire: 60, connectionLimit: 3
        });
    });

    it('keeps a host value that is 0 or an empty string', () => {
        const mixed = Settings.mixSettings({
            ...base(),
            hosts: [{ host: 'a', port: 0, user: '', minConnections: 0 }]
        });
        expect(mixed.hosts[0]).toMatchObject({ port: 0, user: '', minConnections: 0 });
    });

    it('leaves the default pool settings as they were parsed', () => {
        const settings = Settings.mixSettings({
            ...base(),
            hosts: [
                { host: 'a', id: 7, name: 'first', redisExpire: 60, port: 3307 },
                { host: 'b', validators: [], timerCheckRange: { start: 1 }, flags: ['-FOO'] }
            ]
        });
        expect(settings.defaultPoolSettings).toStrictEqual({
            ...defaultsOf322.defaultPoolSettings, user: 'u', password: 'p', database: 'd'
        });
    });

    // The merge copies keys with a spread, which would take a prototype from a __proto__ key.
    // The strict schema must stop such a key before the merge sees it
    it.each([
        ['a host', '{"hosts":[{"host":"a","__proto__":{"x":1}}]}'],
        ['the timerCheckRange of a host', '{"hosts":[{"host":"a","timerCheckRange":{"__proto__":{"x":1}}}]}'],
        ['a validator of a host', '{"hosts":[{"host":"a","validators":[{"key":"k","operator":"=","value":1,"__proto__":{"x":1}}]}]}'],
        ['the healthCheck block of a host',
            '{"hosts":[{"host":"a","healthCheck":{"__proto__":{"x":1}}}]}'],
        ['the healthCheck block of defaultPoolSettings',
            '{"defaultPoolSettings":{"healthCheck":{"__proto__":{"x":1}}}}'],
        ['defaultPoolSettings', '{"defaultPoolSettings":{"__proto__":{"x":1}}}']
    ])('rejects a __proto__ key in %s', (_place, json) => {
        const settings = { ...base(), ...JSON.parse(json) };
        expect(() => Settings.mixSettings(settings)).toThrow('Unrecognized key: "__proto__"');
        expect(({} as any).x).toBeUndefined();
    });

    // One row per copy a host gets: the row changes that copy on the first host,
    // then reads the same field of the second host and of the defaults
    type Copied = 'validators' | 'loadFactors' | 'timerCheckRange' | 'flags';
    type Mixed = Pick<IUserPoolSettings, Copied>;
    const copyRows: [string, (first: Mixed) => void, (other: Mixed) => unknown, unknown][] = [
        ['the validators array',
            first => { first.validators.push({ key: 'x', operator: '=', value: 1 }); },
            other => other.validators.length, 3],
        ['each validator in it',
            first => { first.validators[0].value = 'changed'; },
            other => other.validators[0], defaultsOf322.defaultPoolSettings.validators[0]],
        ['the loadFactors array',
            first => { first.loadFactors.push({ key: 'x', multiplier: 1 }); },
            other => other.loadFactors.length, 2],
        ['each load factor in it',
            first => { first.loadFactors[0].multiplier = 99; },
            other => other.loadFactors[0], defaultsOf322.defaultPoolSettings.loadFactors[0]],
        ['timerCheckRange',
            first => { first.timerCheckRange.start = 1; },
            other => other.timerCheckRange, { start: 5000, end: 15000 }],
        ['the flags array',
            first => { (first.flags as string[]).push('BAR'); },
            other => other.flags, ['-FOO']]
    ];

    it.each(copyRows)('gives every host its own copy of %s', (_copy, change, read, untouched) => {
        const settings = Settings.mixSettings({
            ...base(),
            defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: ['-FOO'] },
            hosts: [{ host: 'a' }, { host: 'b' }]
        });
        const [first, second] = settings.hosts;

        change(first);

        // one object, so a failure names which of the two shares the copy
        expect({ secondHost: read(second), defaults: read(settings.defaultPoolSettings) })
            .toEqual({ secondHost: untouched, defaults: untouched });
    });

    it('does not keep the arrays and objects the app passed for a host', () => {
        const validators = [{ key: 'k', operator: '=' as const, value: 1 }];
        const timerCheckRange = { start: 10, end: 20 };
        const mixed = Settings.mixSettings({ ...base(), hosts: [{ host: 'a', validators, timerCheckRange }] });

        mixed.hosts[0].validators[3].value = 2;
        mixed.hosts[0].timerCheckRange.start = 11;

        expect(validators[0].value).toBe(1);
        expect(timerCheckRange.start).toBe(10);
    });

    it('throws on invalid settings', () => {
        const invalid = { ...base(), errorRetryCount: 'abc' } as any;
        expect(() => Settings.mixSettings(invalid)).toThrow('→ at errorRetryCount');
    });
});

describe('the healthCheck block', () => {
    const defaults = {
        interval: 5000, timeout: 5000, fall: 2, rise: 2, authRetryInterval: 60000, passive: true
    };
    const withBlock = (pool: object, host: object = {}): IUserSettings => ({
        ...base(),
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd', ...pool },
        hosts: [{ host: 'a', ...host }]
    });

    it('fillHealthCheck gives an empty block the six defaults', () => {
        expect(fillHealthCheck({})).toStrictEqual(defaults);
    });

    it('fillHealthCheck sets a timeout left out to the interval that was written', () => {
        expect(fillHealthCheck({ interval: 300 }))
            .toStrictEqual({ ...defaults, interval: 300, timeout: 300 });
    });

    it('fillHealthCheck gives a key set to undefined its default', () => {
        const block = { interval: undefined, timeout: undefined, fall: undefined, rise: 7 };
        expect(fillHealthCheck(block)).toStrictEqual({ ...defaults, rise: 7 });
    });

    it('is not added by the schema: the defaults and a host have none', () => {
        const settings = Settings.mixSettings(base());

        expect(Object.keys(settings.defaultPoolSettings)).not.toContain('healthCheck');
        expect(Object.keys(settings.hosts[0])).not.toContain('healthCheck');
    });

    it('is filled in on the host and kept as written in the default pool settings', () => {
        const settings = Settings.mixSettings(withBlock({ healthCheck: { fall: 3 } }));

        expect(settings.hosts[0].healthCheck).toStrictEqual({ ...defaults, fall: 3 });
        expect(settings.defaultPoolSettings.healthCheck).toStrictEqual({ fall: 3 });
    });

    it.each<[string, object, object, string[]]>([
        ['nothing for a host without the block', { timerCheckMultiplier: 2 }, {}, []],
        ['nothing when the app wrote neither key', { healthCheck: {} }, {}, []],
        ['the key of the default pool settings',
            { healthCheck: {}, timerCheckMultiplier: 2 }, {}, ['timerCheckMultiplier']],
        ['the key of the host',
            { healthCheck: {} }, { timerCheckRange: { start: 1 } }, ['timerCheckRange']],
        ['both keys, one from each place, in a fixed order',
            { timerCheckMultiplier: 2 }, { healthCheck: {}, timerCheckRange: {} },
            ['timerCheckRange', 'timerCheckMultiplier']],
        ['nothing for a key set to undefined',
            { healthCheck: {}, timerCheckMultiplier: undefined },
            { timerCheckRange: undefined }, []]
    ])('Settings.ignoredCheckKeys names %s', (_name, pool, host, keys) => {
        const settings = Settings.mixSettings(withBlock(pool, host));

        expect(Settings.ignoredCheckKeys(settings.hosts[0])).toEqual(keys);
    });

    it('Settings.ignoredCheckKeys names the keys of each host by itself', () => {
        const settings = Settings.mixSettings({
            ...base(),
            hosts: [
                { host: 'a', healthCheck: {} },
                { host: 'b', healthCheck: {}, timerCheckMultiplier: 2 },
                { host: 'c', timerCheckMultiplier: 2 }
            ]
        });

        expect(settings.hosts.map(host => Settings.ignoredCheckKeys(host)))
            .toEqual([[], ['timerCheckMultiplier'], []]);
    });

    it.each<[string, any]>([
        ['a copy of the host', (host: IUserPoolSettings) => ({ ...host })],
        ['undefined', (): undefined => undefined],
        ['a string', () => 'a']
    ])('Settings.ignoredCheckKeys names nothing for %s', (_name, other) => {
        const pool = { healthCheck: {}, timerCheckMultiplier: 2 };
        const settings = Settings.mixSettings(withBlock(pool));

        expect(Settings.ignoredCheckKeys(other(settings.hosts[0]))).toEqual([]);
    });

    it('Settings.ignoredCheckKeys hands out a new array on every call', () => {
        const pool = { healthCheck: {}, timerCheckMultiplier: 2 };
        const [host] = Settings.mixSettings(withBlock(pool)).hosts;

        Settings.ignoredCheckKeys(host).push('changed');

        expect(Settings.ignoredCheckKeys(host)).toEqual(['timerCheckMultiplier']);
    });
});

describe('createPoolCluster', () => {
    it('validates and loads the settings, without the live objects', () => {
        const { createPoolCluster, config } = loadPackage();
        const logger = makeLogger();

        const cluster = createPoolCluster({ ...base(), logs: { level: 'debug' }, logger });

        expect(cluster.pools).toHaveLength(1);
        expect(config.current.clusterName).toBe('test');
        expect(config.current.logger).toBeUndefined();
        expect(config.current.redisInstant).toBeUndefined();
        expect(logger.debug).toHaveBeenCalled();
    });

    it('leaves the object of the app as it was', () => {
        const { createPoolCluster } = loadPackage();
        const logger = makeLogger();
        const userSettings = { ...base(), logger, redisInstant: undefined };
        const before = JSON.stringify(userSettings);

        createPoolCluster(userSettings);

        expect(JSON.stringify(userSettings)).toBe(before);
        expect(userSettings.logger).toBe(logger);
    });

    it('keeps the settings loaded before when a later call fails', () => {
        const { createPoolCluster, config } = loadPackage();
        const logger = makeLogger();
        createPoolCluster({ ...base(), clusterName: 'first', logger });

        const invalid = { ...base(), clusterName: 'second', bogusKey: 1, logger };
        expect(() => createPoolCluster(invalid)).toThrow('Unrecognized key: "bogusKey"');
        expect(config.current.clusterName).toBe('first');
    });

    it('warns the logger of the first cluster when a second call replaces its settings', () => {
        const { createPoolCluster, config } = loadPackage();
        const first = makeLogger();
        const second = makeLogger();
        createPoolCluster({ ...base(), clusterName: 'first', logger: first });
        expect(first.warn).not.toHaveBeenCalled();

        createPoolCluster({ ...base(), clusterName: 'second', logger: second });

        expect(config.current.clusterName).toBe('second');
        expect(first.warn).toHaveBeenCalledWith(expect.stringContaining('called again'));
        expect(second.warn).not.toHaveBeenCalled();
    });

    it('rejects a host without a host name instead of starting without it', () => {
        const { createPoolCluster } = loadPackage();
        const hosts = [{ host: 'a' }, { name: 'no host' }];
        expect(() => createPoolCluster({ ...base(), hosts })).toThrow('→ at hosts[1].host');
    });

    it.each([[undefined], [null], ['settings'], [[]]])('rejects %p with the settings error', (settings) => {
        const { createPoolCluster } = loadPackage();
        expect(() => createPoolCluster(settings)).toThrow('Invalid mysql-dynamic-cluster settings');
    });
});

describe('the environment', () => {
    it('is not read: no variable of 3.2.2, no .env file, no MYSQL_CONFIG_FILES', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-env-'));
        try {
            const dotenvFile = 'MYSQL_CLUSTER_NAME=from_dotenv\nLEAKED_FROM_DOTENV=1\n';
            fs.writeFileSync(path.join(cwd, '.env'), dotenvFile);
            fs.writeFileSync(path.join(cwd, 'overrides.json'), JSON.stringify({ clusterName: 'file' }));

            // every variable 3.2.2 read, set to a value that would change its setting:
            // a number for the numbers and strings, the opposite of the default for the booleans
            const env: { [name: string]: string } = {
                PATH: process.env.PATH,
                MYSQL_CONFIG_FILES: path.join(cwd, 'overrides.json')
            };
            envNamesOf322.forEach(name => { env[name] = '7'; });
            env.MYSQL_USE_CLUSTER_HASHING = 'false';
            env.MYSQL_REDIS_ENABLE = 'true';
            env.MYSQL_REDIS_CLEAR_ON_START = 'true';

            const typescript = JSON.stringify(require.resolve('typescript'));
            const script = `
                // every read of the environment is noted, whatever the code does with the value
                const watched = new Set(${JSON.stringify(envNamesOf322.concat('MYSQL_CONFIG_FILES'))});
                const read = new Set();
                process.env = new Proxy(process.env, {
                    get(target, name) {
                        if (watched.has(name)) read.add(name);
                        return target[name];
                    }
                });
                const ts = require(${typescript});
                const fs = require('fs');
                require.extensions['.ts'] = (module, filename) => {
                    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
                        compilerOptions: {
                            module: ts.ModuleKind.CommonJS,
                            esModuleInterop: true,
                            target: ts.ScriptTarget.ES2015
                        },
                        fileName: filename
                    });
                    module._compile(out.outputText, filename);
                };
                require(${JSON.stringify(path.join(root, 'index.ts'))});
                const config = require(${JSON.stringify(path.join(root, 'src/configs/index.ts'))});
                const loaded = Object.keys(require.cache);
                console.log(JSON.stringify({
                    current: config.default.current,
                    read: Array.from(read),
                    leaked: process.env.LEAKED_FROM_DOTENV === undefined,
                    modules: loaded.filter(file => /node_modules[\\\\/](dotenv|convict)[\\\\/]/.test(file))
                }));
            `;
            const res = spawnSync(process.execPath, ['-e', script], {
                cwd,
                encoding: 'utf8',
                env,
                timeout: 30000
            });

            const out = JSON.parse(res.stdout);
            expect(out.current).toEqual(defaultsOf322);
            expect(out.read).toEqual([]);
            expect(out.leaked).toBe(true);
            expect(out.modules).toEqual([]);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
