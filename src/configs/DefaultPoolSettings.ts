/**
 * Created by Bohdan on Apr, 2022
 */

import { IDefaultPoolSettings } from "../types/PoolSettingsInterfaces";

const DefaultPoolSettings: IDefaultPoolSettings = {
    port: 3306,
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
    queryTimeout: 2 * 60 * 1000, // time in ms
    slowQueryTime: 1, // time in sec
    redisFactor: 100
}

Object.freeze(DefaultPoolSettings);

export default DefaultPoolSettings;
