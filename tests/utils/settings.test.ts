/**
 * Created by Bohdan on Sep, 2021
 */

import { Settings } from "../../src/utils/Settings";
import { UserPoolSettings, UserSettings } from "../../src/types/SettingsInterfaces";

describe("Mix settings", () => {
    it ("Set credentials for all pools", () => {
        const userSettings: UserSettings = {
            hosts: [
                {
                    host: '192.168.0.1'
                }
            ],
            user: 'test',
            password: 'test2',
            database: 'db'
        }

        const expectedResult: UserPoolSettings = {
            host: '192.168.0.1',
            user: 'test',
            password: 'test2',
            database: 'db'
        }

        const result = Settings.mixSettings(userSettings);

        expect(result).toStrictEqual(expectedResult);
    })

    // it('Override global credential for pool', () => {
    //     const userSettings: UserSettings = {
    //         hosts: [
    //             {
    //                 host: '192.168.0.1',
    //                 user: 'amazing'
    //             }
    //         ],
    //         user: 'test',
    //         password: 'test2',
    //         database: 'db'
    //     }
    //
    //     const expectedResult: UserPoolSettings = {
    //         host: '192.168.0.1',
    //         user: 'amazing',
    //         password: 'test2',
    //         database: 'db'
    //     }
    //
    //     const result = Settings.mixSettings(userSettings.hosts[0], userSettings);
    //
    //     expect(result).toStrictEqual(expectedResult);
    // })
})
