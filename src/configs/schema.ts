import { z } from 'zod';
import { LOGLEVEL } from '../types/LoggerInterfaces';
import { IParsedSettings } from '../types/SettingsInterfaces';
import { IValidatorParams } from '../types/PoolInterfaces';

/**
 * Settings schema. Every object is strict: a key the schema doesn't know is an error, not ignored.
 * Defaults live here and nowhere else
 */

const validator = z.strictObject({
    key: z.string(),
    operator: z.enum(['>', '<', '=', 'Like']),
    // not z.union: without strict mode its inferred type turns the key optional
    value: z.custom<string | number>(
        value => typeof value === 'string' || typeof value === 'number',
        'expected string or number'
    )
});

const loadFactor = z.strictObject({
    key: z.string(),
    multiplier: z.number()
});

// Either half may be left out: the other one comes from the defaults
const timerCheckRange = z.strictObject({
    start: z.number(),
    end: z.number()
}).partial();

// Pool settings without defaults, shared by defaultPoolSettings and every host
const poolFields = {
    user: z.string(),
    password: z.string(),
    database: z.string(),
    port: z.number(),
    connectionLimit: z.number(),
    // minimum free connections kept alive per pool by the idle reaper
    minConnections: z.number(),
    // time in ms after which an idle connection is destroyed (keeping at least minConnections)
    idleTimeout: z.number(),
    // how often in ms the idle connection reaper runs its cleanup pass
    idleCheckInterval: z.number(),
    validators: z.array(validator),
    loadFactors: z.array(loadFactor),
    // time in ms
    timerCheckRange,
    timerCheckMultiplier: z.number(),
    // time in ms
    queryTimeout: z.number(),
    // time in seconds
    slowQueryTime: z.number(),
    redisFactor: z.number()
};

const defaultPoolSettings = z.strictObject({
    user: poolFields.user.default(''),
    password: poolFields.password.default(''),
    database: poolFields.database.default(''),
    port: poolFields.port.default(3306),
    connectionLimit: poolFields.connectionLimit.default(10),
    minConnections: poolFields.minConnections.default(1),
    idleTimeout: poolFields.idleTimeout.default(30000),
    idleCheckInterval: poolFields.idleCheckInterval.default(10000),
    // built per parse: two parses never share the default objects
    validators: poolFields.validators.default((): IValidatorParams[] => [
        { key: 'wsrep_ready', operator: '=', value: 'ON' },
        { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
        { key: 'Threads_running', operator: '<', value: 50 }
    ]),
    loadFactors: poolFields.loadFactors.default(() => [
        { key: 'Connections', multiplier: 2 },
        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
    ]),
    timerCheckRange: z.strictObject({
        start: z.number().default(5000),
        end: z.number().default(15000)
    }).prefault({}),
    timerCheckMultiplier: poolFields.timerCheckMultiplier.default(1.3),
    queryTimeout: poolFields.queryTimeout.default(2 * 60 * 1000),
    slowQueryTime: poolFields.slowQueryTime.default(1),
    redisFactor: poolFields.redisFactor.default(1)
});

// A host overrides any pool setting. What it leaves out comes from defaultPoolSettings
const host = z.strictObject({
    ...poolFields,
    id: z.number(),
    name: z.string(),
    redisExpire: z.number()
}).partial().extend({
    host: z.string().min(1)
});

export const settingsSchema = z.strictObject({
    clusterName: z.string().default('demo'),
    hosts: z.array(host).default([]),
    defaultPoolSettings: defaultPoolSettings.prefault({}),
    // retry count after a query error
    errorRetryCount: z.number().default(2),
    useClusterHashing: z.boolean().default(true),
    clusterHashing: z.strictObject({
        // time in ms
        nextCheckTime: z.number().default(5000),
        // name of the helper database on the cluster nodes
        dbName: z.string().default('mysql_dynamic_cluster')
    }).prefault({}),
    // table that maps a service name to its id
    serviceMetrics: z.strictObject({
        database: z.string().default('swagger_realtime'),
        table: z.string().default('Service')
    }).prefault({}),
    redis: z.strictObject({
        enabled: z.boolean().default(false),
        keyPrefix: z.string().default('mdc:'),
        // time in seconds
        expire: z.number().default(1000000),
        expiryMode: z.enum(['EX']).default('EX'),
        algorithm: z.enum(['md5', 'sha256']).default('md5'),
        encoding: z.enum(['base64', 'hex']).default('base64'),
        clearOnStart: z.boolean().default(false)
    }).prefault({}),
    logs: z.strictObject({
        level: z.enum(LOGLEVEL).default(LOGLEVEL.INFO)
    }).prefault({})
});

/**
 * Validate settings and fill in the defaults
 * @param settings settings of the app, without redisInstant and logger
 * @throws Error that lists every wrong or unknown key by its path
 */
export function parseSettings(settings: unknown): IParsedSettings {
    const result = settingsSchema.safeParse(settings);
    if (!result.success) {
        const problems = z.prettifyError(result.error);
        throw new Error("Invalid mysql-dynamic-cluster settings:\n" + problems);
    }

    // typed by the hand-written interface, so the shipped declarations never reference zod.
    // This assignment fails the build when the interface has a required key the schema lacks,
    // or types a key differently. It does not notice an optional key the schema lacks, nor a
    // key that only the schema has
    const parsed: IParsedSettings = result.data;
    return parsed;
}
