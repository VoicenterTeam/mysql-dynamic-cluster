/**
 * Created by Bohdan on Sep, 2021
 */

import amqp_logger_lib from '@voicenter-team/amqp-logger';

import defaultSettings from '../configs/DefaultSettings';
import { MethDict } from '../configs/AmqpLoggerConfig';
import { IAmqpConfig, IUserAmqpConfig, LOGLEVEL } from "../types/AmqpInterfaces";

let amqpLogger = null;
// prefix for each log message
let prefix: string = '[mysql galera]';
let clusterName: string = "mdc";

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
     * @param newClusterName cluster name used for prefix
     */
    init(useConsole: boolean, newClusterName: string) {
        this.useConsole = useConsole;
        clusterName = newClusterName;
        prefix = `[${clusterName}]`;
    },
    /**
     * Enable amqp logger when needed. It creates connection to it
     * @param amqpSettings amqp_logger config
     */
    enableAMQPLogger(amqpSettings: IUserAmqpConfig) {
        const loggerConfig: IAmqpConfig = {
            ...amqpSettings,
            meth_dict: MethDict
        }
        this.addPrefixAMQP(loggerConfig);

        amqpLogger = amqp_logger_lib.pastash(loggerConfig);
        Logger.info("AMQP logger enabled");
    },
    addPrefixAMQP(amqpConfig: IAmqpConfig) {
        amqpConfig.log_amqp = amqpConfig.log_amqp.map(amqpLog => {
            amqpLog.channel.exchange_name = `${clusterName}_${amqpLog.channel.exchange_name}`;
            return amqpLog;
        })
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
