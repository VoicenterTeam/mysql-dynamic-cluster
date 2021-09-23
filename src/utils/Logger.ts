/**
 * Created by Bohdan on Sep, 2021
 */

import { LOGLEVEL } from '../types/SettingsInterfaces';
import amqp_logger_lib from '@voicenter-team/amqp-logger';

import defaultSettings from '../configs/DefaultSettings';
import loggerConfig from '../configs/LoggerConfig';

const amqpLogger = amqp_logger_lib.pastash(loggerConfig);
const prefix: string = '[mysql galera]';

const Logger = {
    level: defaultSettings.logLevel ? defaultSettings.logLevel : LOGLEVEL.FULL,
    debug(message: string) {
        if (this.level === LOGLEVEL.FULL) {
            console.log("\x1b[0m", prefix, "\x1b[34m", "[DEBUG]", message, "\x1b[0m");
            amqpLogger.debug(message);
        }
    },
    error(message: string) {
        console.log("\x1b[0m", prefix, "\x1b[31m", "[ERROR]", message, "\x1b[0m");
        amqpLogger.error(message);
    },
    info(message: string) {
        if (this.level !== LOGLEVEL.QUIET) {
            console.log("\x1b[0m", prefix, "\x1b[32m", "[INFO]", message, "\x1b[0m");
            amqpLogger.info(message);
        }
    },
    warn(message: string) {
        console.log("\x1b[0m", prefix, "\x1b[33m", "[WARNING]", message, "\x1b[0m");
        amqpLogger.warn(message);
    },
    setLogLevel(newLevel: LOGLEVEL) {
        this.level = newLevel;
    }
}

export default Logger;
