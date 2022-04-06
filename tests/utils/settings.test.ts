/**
 * Created by Bohdan on Sep, 2021
 */

import { Settings } from "../../src/utils/Settings";
import {LOGLEVEL, UserSettings} from "../../src/types/SettingsInterfaces";
import AmqpLoggerConfig from "../../src/configs/AmqpLoggerConfig";
import defaultSettings from "../../src/configs/DefaultSettings";

describe("Mix settings", () => {
    it ("check 1 level of merging settings", () => {
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
            logLevel: LOGLEVEL.FULL
        }

        const expectedResult: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1'
                }
            ],
            globalPoolSettings: {
                user: 'test',
                password: 'test2',
                database: 'db',
            }
            // #TODO: finish add expected keys
        }

        const result = Settings.mixSettings(userSettings);

        expect(result).toStrictEqual(expectedResult);
    })

    it('check 2 level of merging settings', () => {
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
            },
            redisSettings: {
                algorithm: "test",
                keyPrefix: "test_m_d_c:"
            }
        }

        const expectedResult: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1'
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
})
