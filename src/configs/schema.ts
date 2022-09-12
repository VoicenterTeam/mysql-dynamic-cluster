import path from 'path';
import {ExchangeType} from '../types/AmqpInterfaces'
import { LOGLEVEL, LOGTYPES } from '../types/LoggerInterfaces';
import { Redis, Cluster } from 'ioredis';
import { BinaryToTextEncoding, } from "crypto";

const binaryType:BinaryToTextEncoding = 'base64'


export const schema = {
    defaultPoolSettings : {
        user: {
            doc: 'default cluster username',
            format:  String,
            default: '',
            env: "MYSQL_DEFAULT_USER"
        },
        password: {
            doc: 'default cluster password',
            format:  String,
            default: '',
            env: "MYSQL_DEFAULT_PASSWORD"
        },
        database: {
            doc: 'default cluster database',
            format:  String,
            default: '',
            env: "MYSQL_DEFAULT_DATABASE"
        },
        port: {
            doc: 'default cluster port',
            format:  Number,
            default: 3306,
            env: "MYSQL_DEFAULT_PORT"
        },
        connectionLimit: {
            doc: 'default cluster connection limit',
            format:  Number,
            default: 100,
            env: "MYSQL_DEFAULT_CONNECTION_LIMIT"
        },
        validators: {
            doc: 'default cluster validators',
            format:  Array,
            default: [
                { key: 'wsrep_ready', operator: '=', value: 'ON' },
                { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                { key: 'Threads_running', operator: '<', value: 50 }
            ]
        },
        loadFactors: {
            doc: 'default cluster load factors',
            format: Array,
            default: [
                { key: 'Connections', multiplier: 2 },
                { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
            ]
        },
        timerCheckRange: {
            doc: 'default cluster check range',
            format:  Object,
            default: {
                start: 5000,
                end: 15000
            }
        },
        timerCheckMultiplier: {
            doc: 'default cluster check multiplier',
            format:  Number,
            default: 1.3
        },
        queryTimeout: {
            doc: 'default cluster query timeout',
            format:  Number,
            default: 2 * 60 * 1000,
            env: 'MYSQL_DEFAULT_QUERY_TIMEOUT',
        },
        slowQueryTime: {
            doc: 'default cluster slow query timeout',
            format:  Number,
            default: 1,
            env: 'MYSQL_DEFAULT_QUERY_SLOW',
        },
        redisFactor: {
            doc: 'default cluster redis factor',
            format:  Number,
            default: 1,
            env: 'MYSQL_DEFAULT_REDIS_FACTOR',
        }
    },
    showMetricKeys: {
        doc: 'show metric keys',
        format:  Boolean,
        default: false,
        env: "MYSQL_SHOW_METRIC_KEYS"
    },
    serviceMetrics: {
        database: {
            doc: 'database name',
            format:  String,
            default: 'swagger_realtime',
            env: "MYSQL_SERVICE_METRICS_DATABASE"
        },
        table: {
            doc: 'table name',
            format:  String,
            default: 'Service',
            env: "MYSQL_SERVICE_METRICS_TABLE"
        }
    },
    clusterHashing: {
        nextCheckTime: {
            doc: 'next check cluster time',
            format:  Number,
            default: 5000,
            env: "MYSQL_CLUSTER_CHECK_TIME"
        },
        dbName: {
            doc: 'name of database for cluster nodes',
            format:  String,
            default: 'mysql_dynamic_cluster',
            env: "MYSQL_CLUSTER_DB_NAME"
        }
    },
    redisInstant : {
        doc: 'redis connection instant',
        format:  '*',
        default: false,
        env: "MYSQL_REDIS_INSTANT"
    },
    hosts: {
        doc: 'use hashing cluster',
        format:  Array,
        default: [],
        env: "MYSQL_HOSTS"
    },
    useClusterHashing:{
        doc: 'use hashing cluster',
        format:  Boolean,
        default: true,
        env: "MYSQL_USE_CLUSTER_HASHING"
    },
    clusterName: {
        doc: 'name of cluster',
        format:  String,
        default: 'demo',
        env: "MYSQL_CLUSTER_NAME"
    },
    errorRetryCount: {
        doc: 'execute retry count',
        format:  Number,
        default: 2,
        env: "MYSQL_RETRY_COUNT"
    },
    redis: {
        enabled: {
            doc: 'enable Redis cache',
            format:  Boolean,
            default: false,
            env: "MYSQL_REDIS_ENABLE"
        },
        keyPrefix: {
            doc: 'prefix for redis keys',
            format: String,
            default: "mdc:",
            env: "MYSQL_REDIS_PREFIX"
        },
        expire: {
            doc: 'redis key expire time in seconds',
            format: Number,
            default: 1000000,
            env: "MYSQL_REDIS_EXPIRE"
        },
        expiryMode: {
            doc: 'redis key expire time in seconds',
            format: ['EX'] as const,
            default: "EX",
            env: "MYSQL_REDIS_EXPIRE_MODE",
        },
        algorithm: {
            doc: 'redis hash algorithm',
            format: ['md5','sha256'] as const,
            default: "md5",
            env: "MYSQL_REDIS_ALGORITHM",
        },
        encoding: {
            doc: 'redis hash encoding',
            format: ['base64', 'hex'] as const,
            default: binaryType,
            env: "MYSQL_REDIS_ENCODING"
        },
        clearOnStart: {
            doc: 'clear reids cache on start',
            format: Boolean,
            default: false,
            env: "MYSQL_REDIS_CLEAR_ON_START"
        }
    },
    logs: {
        level: {
            doc: 'Log output level',
            format:  [...Object.values(LOGLEVEL)] as const,
            default: LOGLEVEL.INFO,
            env: "LOGGER_LOG_LEVEL"
        },
        output: {
            doc: 'Where to output logs. Options are: console, file. Multiple can be separated by comma (",")',
            format:  String,
            default: 'console',
            env: "LOGGER_LOG_OUTPUT"
        },
    },
    amqp_logs: {
        topic: {
            doc: 'Amqp topic',
            format: String,
            default: 'MYSQL_CLUSTER_LOGS',
            env: 'LOG_AMQP_TOPIC',
        },
        connection_master: {
            host: {
                doc: 'Amqp host',
                format: String,
                default: '',
                env: 'LOG_AMQP_HOST_MASTER',
            },
            port: {
                doc: 'Amqp port',
                format: Number,
                default: 5672,
                env: 'LOG_AMQP_PORT_MASTER',
            },
            username: {
                doc: 'Amqp username',
                format: String,
                default: '',
                env: 'LOG_AMQP_USERNAME_MASTER',
            },
            password: {
                doc: 'Amqp password',
                format: String,
                default: '',
                env: 'LOG_AMQP_PASSWORD_MASTER',
            },
            vhost: {
                doc: 'Amqp vhost',
                format: String,
                default: '/',
                env: 'LOG_AMQP_VHOST_MASTER',
            },
            ssl: {
                doc: 'Amqp ssl',
                format: Boolean,
                default: false,
                env: 'LOG_AMQP_SSL_MASTER',
            },
            heartbeat: {
                doc: 'Amqp heartbeat',
                format: Number,
                default: 5,
                env: 'LOG_AMQP_HEARTBEAT_MASTER',
            }
        },
        exchage: {
            name: {
                doc: 'Amqp exchange name',
                format: String,
                default: 'Logs',
                env: 'LOG_AMQP_EXCHANGE_NAME',
            },
            type: {
                doc: 'Amqp exchange type',
                format: [...Object.values(ExchangeType)] as const,
                default: ExchangeType.TOPIC,
                env: 'LOG_AMQP_EXCHANGE_TYPE',
            }
        },
        queue:{
            name: {
                doc: 'Amqp queue name',
                format: String,
                default: 'MYSQL_CLUSTER_LOGS',
                env: 'LOG_AMQP_QUEUE_NAME',
            }
        },
        bindings: {
            enabled: {
                doc: 'binding queue to exchange',
                format: Boolean,
                default: true,
                env: 'LOG_AMQP_BINDINGS_ENABLED',
            },
            pattern: {
                doc: 'Amqp topic route',
                format: String,
                default: 'mysql_logs',
                env: 'LOG_AMQP_BINDINGS_PATTERN',
            }
        },
        prefetch: {
            doc: 'Amqp prefetch number',
            format: Number,
            default: 0,
            env: 'LOG_AMQP_prefetch',
        }
    }
}