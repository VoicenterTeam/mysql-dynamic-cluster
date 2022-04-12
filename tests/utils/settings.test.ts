/**
 * Created by Bohdan on Sep, 2021
 */

import { Settings } from "../../src/utils/Settings";
import {LOGLEVEL, UserSettings} from "../../src/types/SettingsInterfaces";
import { AmqpLoggerConfig } from "../../src/configs/AmqpLoggerConfig";

describe("Mix settings", () => {
    it ("check merging global with user pool settings", () => {
        const userSettings: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1',
                    user: 'userTest',
                    password: 'userTest2',
                    errorRetryCount: 3
                },
                {
                    host: '192.168.0.2',
                    validators: [
                        { key: 'wsrep_ready', operator: '=', value: 'OFF' }
                    ]
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
            },
            logLevel: LOGLEVEL.FULL,
            redisSettings: {
                algorithm: "test",
                keyPrefix: "test_m_d_c:"
            }
        }

        const expectedResult: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1',
                    user: 'userTest',
                    password: 'userTest2',
                    database: 'db',
                    port: "3306",
                    connectionLimit: 100,
                    validators: [
                        { key: 'wsrep_ready', operator: '=', value: 'ON' },
                        { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                        { key: 'Threads_running', operator: '<', value: 50 }
                    ],
                    loadFactors: [
                        { key: 'Connections', multiplier: 2 },
                        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                    ],
                    timerCheckRange: {
                        start: 5000,
                        end: 15000
                    },
                    timerCheckMultiplier: 1.3,
                    errorRetryCount: 3,
                    queryTimeout: 2 * 60 * 1000,
                },
                {
                    host: '192.168.0.2',
                    user: 'test',
                    password: 'test2',
                    database: 'db',
                    port: "3306",
                    connectionLimit: 100,
                    validators: [
                        { key: 'wsrep_ready', operator: '=', value: 'OFF' }
                    ],
                    loadFactors: [
                        { key: 'Connections', multiplier: 2 },
                        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                    ],
                    timerCheckRange: {
                        start: 5000,
                        end: 15000
                    },
                    timerCheckMultiplier: 1.3,
                    errorRetryCount: 2,
                    queryTimeout: 2 * 60 * 1000,
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
                port: "3306",
                connectionLimit: 100,
                validators: [
                    { key: 'wsrep_ready', operator: '=', value: 'ON' },
                    { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                    { key: 'Threads_running', operator: '<', value: 50 }
                ],
                loadFactors: [
                    { key: 'Connections', multiplier: 2 },
                    { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                ],
                timerCheckRange: {
                    start: 5000,
                    end: 15000
                },
                timerCheckMultiplier: 1.3,
                errorRetryCount: 2,
                queryTimeout: 2 * 60 * 1000, // time in ms
            },
            logLevel: LOGLEVEL.FULL,
            useAmqpLogger: true,
            redisSettings: {
                algorithm: "test",
                encoding: "base64",
                keyPrefix: "test_m_d_c:",
                expiryMode: "EX",
                expire: 100,
                clearOnStart: false
            },
            amqpLoggerSettings: AmqpLoggerConfig
        }

        const result = Settings.mixSettings(userSettings);

        expect(result).toStrictEqual(expectedResult);
    })

    it ("check object merging settings", () => {
        const userSettings: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1'
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
            },
            logLevel: LOGLEVEL.FULL,
            redisSettings: {
                algorithm: "test",
                keyPrefix: "test_m_d_c:"
            }
        }

        const expectedResult: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1',
                    user: 'test',
                    password: 'test2',
                    database: 'db',
                    port: "3306",
                    connectionLimit: 100,
                    validators: [
                        { key: 'wsrep_ready', operator: '=', value: 'ON' },
                        { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                        { key: 'Threads_running', operator: '<', value: 50 }
                    ],
                    loadFactors: [
                        { key: 'Connections', multiplier: 2 },
                        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                    ],
                    timerCheckRange: {
                        start: 5000,
                        end: 15000
                    },
                    timerCheckMultiplier: 1.3,
                    errorRetryCount: 2,
                    queryTimeout: 2 * 60 * 1000,
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
                port: "3306",
                connectionLimit: 100,
                validators: [
                    { key: 'wsrep_ready', operator: '=', value: 'ON' },
                    { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                    { key: 'Threads_running', operator: '<', value: 50 }
                ],
                loadFactors: [
                    { key: 'Connections', multiplier: 2 },
                    { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                ],
                timerCheckRange: {
                    start: 5000,
                    end: 15000
                },
                timerCheckMultiplier: 1.3,
                errorRetryCount: 2,
                queryTimeout: 2 * 60 * 1000, // time in ms
            },
            logLevel: LOGLEVEL.FULL,
            useAmqpLogger: true,
            redisSettings: {
                algorithm: "test",
                encoding: "base64",
                keyPrefix: "test_m_d_c:",
                expiryMode: "EX",
                expire: 100,
                clearOnStart: false
            },
            amqpLoggerSettings: AmqpLoggerConfig
        }

        const result = Settings.mixSettings(userSettings);

        expect(result).toStrictEqual(expectedResult);
    })

    it('check array merging settings', () => {
        const userSettings: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1'
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
                validators: [
                    { key: 'wsrep_ready', operator: '=', value: 'OFF' }
                ],
                timerCheckRange: {
                    start: 100,
                    end: 502
                },
            }
        }

        const expectedResult: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1',
                    user: 'test',
                    password: 'test2',
                    database: 'db',
                    port: "3306",
                    connectionLimit: 100,
                    validators: [
                        { key: 'wsrep_ready', operator: '=', value: 'OFF' },
                    ],
                    loadFactors: [
                        { key: 'Connections', multiplier: 2 },
                        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                    ],
                    timerCheckRange: {
                        start: 100,
                        end: 502
                    },
                    timerCheckMultiplier: 1.3,
                    errorRetryCount: 2,
                    queryTimeout: 2 * 60 * 1000,
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
                port: "3306",
                connectionLimit: 100,
                validators: [
                    { key: 'wsrep_ready', operator: '=', value: 'OFF' },
                ],
                loadFactors: [
                    { key: 'Connections', multiplier: 2 },
                    { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                ],
                timerCheckRange: {
                    start: 100,
                    end: 502
                },
                timerCheckMultiplier: 1.3,
                errorRetryCount: 2,
                queryTimeout: 2 * 60 * 1000, // time in ms
            },
            logLevel: LOGLEVEL.REGULAR,
            useAmqpLogger: true,
            redisSettings: {
                algorithm: "md5",
                encoding: "base64",
                keyPrefix: "m_d_c:",
                expiryMode: "EX",
                expire: 100,
                clearOnStart: false
            },
            amqpLoggerSettings: AmqpLoggerConfig
        }

        const result = Settings.mixSettings(userSettings);

        expect(result).toStrictEqual(expectedResult);
    })

    it('check merging amqp settings', () => {
        const userSettings: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1'
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db'
            },
            amqpLoggerSettings: {
                log_amqp: [
                    {
                        connection: {
                            host: "127.0.0.2",
                            port: 5676,
                            ssl: true,
                            username: "test",
                            password: "test2",
                            vhost: "/",
                            heartbeat: 5
                        },
                        channel: {
                            directives: "ae",
                            exchange_name: "TestExe",
                            exchange_type: "fanoutTest",
                            exchange_durable: true,
                            topic: "",
                            options: {}
                        }
                    }
                ],
                pattern: {
                    Title: "Testing",
                    Message: "Test",
                }
            }
        }

        const expectedResult: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1',
                    user: 'test',
                    password: 'test2',
                    database: 'db',
                    port: "3306",
                    connectionLimit: 100,
                    validators: [
                        { key: 'wsrep_ready', operator: '=', value: 'ON' },
                        { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                        { key: 'Threads_running', operator: '<', value: 50 }
                    ],
                    loadFactors: [
                        { key: 'Connections', multiplier: 2 },
                        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                    ],
                    timerCheckRange: {
                        start: 5000,
                        end: 15000
                    },
                    timerCheckMultiplier: 1.3,
                    errorRetryCount: 2,
                    queryTimeout: 2 * 60 * 1000,
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
                port: "3306",
                connectionLimit: 100,
                validators: [
                    { key: 'wsrep_ready', operator: '=', value: 'ON' },
                    { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
                    { key: 'Threads_running', operator: '<', value: 50 }
                ],
                loadFactors: [
                    { key: 'Connections', multiplier: 2 },
                    { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
                ],
                timerCheckRange: {
                    start: 5000,
                    end: 15000
                },
                timerCheckMultiplier: 1.3,
                errorRetryCount: 2,
                queryTimeout: 2 * 60 * 1000,
            },
            logLevel: LOGLEVEL.REGULAR,
            useAmqpLogger: true,
            redisSettings: {
                algorithm: "md5",
                encoding: "base64",
                keyPrefix: "m_d_c:",
                expiryMode: "EX",
                expire: 100,
                clearOnStart: false
            },
            amqpLoggerSettings: {
                log_amqp: [
                    {
                        connection: {
                            host: "127.0.0.2",
                            port: 5676,
                            ssl: true,
                            username: "test",
                            password: "test2",
                            vhost: "/",
                            heartbeat: 5
                        },
                        channel: {
                            directives: "ae",
                            exchange_name: "TestExe",
                            exchange_type: "fanoutTest",
                            exchange_durable: true,
                            topic: "",
                            options: {}
                        }
                    }
                ],
                pattern: {
                    DateTime: "",
                    Title: "Testing",
                    Message: "Test",
                    LoggerSpecificData: "localhost",
                    LogSpecificData: "ThisLogType"
                },
                log_lvl: 3,
            }
        }

        const result = Settings.mixSettings(userSettings);

        expect(result).toStrictEqual(expectedResult);
    })
})
