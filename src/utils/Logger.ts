/**
 * Created by Bohdan on Sep, 2021
 */

import { LOGLEVEL } from '../types/SettingsInterfaces';
import amqp_logger_lib from '@voicenter-team/amqp-logger';

import defaultSettings from '../configs/DefaultSettings';
import { MethDict } from '../configs/AmqpLoggerConfig';
import { IUserAmqpConfig } from "../types/AmqpInterfaces";

let amqpLogger = null;
// prefix for each log message
const prefix: string = '[mysql galera]';

/**
 * Output messages to console and rabbitmq
 */
const Logger = {
    /**
     * Log level. Choose what messages send to console and rabbitmq
     */
    level: defaultSettings.logLevel,
    useConsole: defaultSettings.useConsoleLogger,
    /**
     * Initialize logger
     * @param useConsole enable logger in a console
     */
    init(useConsole: boolean) {
        this.useConsole = useConsole;
    },
    /**
     * Enable amqp logger when needed. It creates connection to it
     * @param amqpSettings amqp_logger config
     */
    enableAMQPLogger(amqpSettings: IUserAmqpConfig) {
        const loggerConfig = {
            ...amqpSettings,
            meth_dict: MethDict
        }
        amqpLogger = amqp_logger_lib.pastash(loggerConfig)
        Logger.info("AMQP logger enabled");
    },
    /**
     * Change log level
     * @param newLevel new log level
     */
    setLogLevel(newLevel: LOGLEVEL) {
        this.level = newLevel;
        Logger.info("Log level changed to " + LOGLEVEL[newLevel])
    },
    /**
     * Output to console with blue color and rabbitmq with debug log level
     * @param message log message what send to
     */
    debug(message: string) {
        if (this.level === LOGLEVEL.FULL) {
            if (this.useConsole) console.log("\x1b[0m", prefix, "\x1b[34m", "[DEBUG]", message, "\x1b[0m");
            amqpLogger?.debug(message);
        }
    },
    /**
     * Output to console with red color and rabbitmq with error log level
     * @param message log message what send to
     */
    error(message: string) {
        if (this.useConsole) console.log("\x1b[0m", prefix, "\x1b[31m", "[ERROR]", message, "\x1b[0m");
        amqpLogger?.error(message);
    },
    /**
     * Output to console with green color and rabbitmq with info log level
     * @param message log message what send to
     */
    info(message: string) {
        if (this.level !== LOGLEVEL.QUIET) {
            if (this.useConsole) console.log("\x1b[0m", prefix, "\x1b[32m", "[INFO]", message, "\x1b[0m");
            amqpLogger?.info(message);
        }
    },
    /**
     * Output to console with yellow color and rabbitmq with warning log level
     * @param message log message what send to
     */
    warn(message: string) {
        if (this.useConsole) console.log("\x1b[0m", prefix, "\x1b[33m", "[WARNING]", message, "\x1b[0m");
        amqpLogger?.warn(message);
    }
}

export default Logger;
