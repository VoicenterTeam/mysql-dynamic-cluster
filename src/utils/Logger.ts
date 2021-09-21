/**
 * Created by Bohdan on Sep, 2021
 */

import GlobalSettings from "../configs/GlobalSettings";
import { DEBUG } from '../types/SettingsInterfaces'

const prefix: string = '[mysql galera]';

const Logger = {
    debug(...arg: any[]) {
        if (GlobalSettings.debug === DEBUG.FULL) console.log("\x1b[0m", prefix, "\x1b[34m", ...arg, "\x1b[0m");
    },
    error(...arg: any[]) {
        console.log("\x1b[0m", prefix, "\x1b[31m", ...arg, "\x1b[0m");
    },
    info(...arg: any[]) {
        if (GlobalSettings.debug !== DEBUG.QUIET) console.log("\x1b[0m", prefix, "\x1b[32m", ...arg, "\x1b[0m");
    },
    warn(...arg: any[]) {
        console.log("\x1b[0m", prefix, "\x1b[33m", ...arg, "\x1b[0m");
    },
}

export default Logger;
