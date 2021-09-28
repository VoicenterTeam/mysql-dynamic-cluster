/**
 * Created by Bohdan on Sep, 2021
 */

import { LOGLEVEL } from '../types/SettingsInterfaces';
import amqp_logger_lib from '@voicenter-team/amqp-logger';

import defaultSettings from '../configs/DefaultSettings';
import loggerConfig from '../configs/LoggerConfig';

const amqpLogger = amqp_logger_lib.pastash(loggerConfig);
// prefix for each log message
const prefix: string = '[mysql galera]';

/**
 * Output messages to console and rabbitmq
 */
const Logger = {
    /**
     * log level. Choose what messages send to console and rabbitmq
     */
    level: defaultSettings.logLevel ? defaultSettings.logLevel : LOGLEVEL.FULL,
    /**
     * Output to console with blue color and rabbitmq with debug log level
     * @param message log message what send to
     */
    debug(message: string) {
        if (this.level === LOGLEVEL.FULL) {
            console.log("\x1b[0m", prefix, "\x1b[34m", "[DEBUG]", message, "\x1b[0m");
            amqpLogger.debug(message);
        }
    },
    /**
     * Output to console with red color and rabbitmq with error log level
     * @param message log message what send to
     */
    error(message: string) {
        console.log("\x1b[0m", prefix, "\x1b[31m", "[ERROR]", message, "\x1b[0m");
        amqpLogger.error(message);
    },
    /**
     * Output to console with green color and rabbitmq with info log level
     * @param message log message what send to
     */
    info(message: string) {
        if (this.level !== LOGLEVEL.QUIET) {
            console.log("\x1b[0m", prefix, "\x1b[32m", "[INFO]", message, "\x1b[0m");
            amqpLogger.info(message);
        }
    },
    /**
     * Output to console with yellow color and rabbitmq with warning log level
     * @param message log message what send to
     */
    warn(message: string) {
        console.log("\x1b[0m", prefix, "\x1b[33m", "[WARNING]", message, "\x1b[0m");
        amqpLogger.warn(message);
    },
    /**
     * change log level
     * @param newLevel new log level
     */
    setLogLevel(newLevel: LOGLEVEL) {
        this.level = newLevel;
    }
}

export default Logger;
