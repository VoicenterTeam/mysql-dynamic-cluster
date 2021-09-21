/**
 * Created by Bohdan on Sep, 2021
 */

import { LOGLEVEL } from '../types/SettingsInterfaces'
import defaultSettings from '../configs/DefaultSettings';

const prefix: string = '[mysql galera]';

const Logger = {
    level: defaultSettings.logLevel ? defaultSettings.logLevel : LOGLEVEL.FULL,
    debug(...arg: any[]) {
        if (this.level === LOGLEVEL.FULL) console.log("\x1b[0m", prefix, "\x1b[34m", ...arg, "\x1b[0m");
    },
    error(...arg: any[]) {
        console.log("\x1b[0m", prefix, "\x1b[31m", "[ERROR]", ...arg, "\x1b[0m");
    },
    info(...arg: any[]) {
        if (this.level !== LOGLEVEL.QUIET) console.log("\x1b[0m", prefix, "\x1b[32m", ...arg, "\x1b[0m");
    },
    warn(...arg: any[]) {
        console.log("\x1b[0m", prefix, "\x1b[33m", "[WARNING]", ...arg, "\x1b[0m");
    },
    setLogLevel(newLevel: LOGLEVEL) {
        this.level = newLevel;
    }
}

export default Logger;
