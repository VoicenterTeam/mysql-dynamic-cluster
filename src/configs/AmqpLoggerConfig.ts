/**
 * Created by Bohdan on Sep, 2021
 */
import { IDefaultAmqpConfig, IMethDict } from "../types/AmqpInterfaces";

const AmqpLoggerConfig: IDefaultAmqpConfig = {
    log_amqp: [
        {
            connection: {
                host: "127.0.0.1",
                port: 5672,
                ssl: false,
                username: "guest",
                password: "guest",
                vhost: "/",
                heartbeat: 5
            },
            channel: {
                directives: "ae",
                exchange_name: "MDC",
                exchange_type: "fanout",
                exchange_durable: true,
                topic: "",
                options: {}
            }
        }
    ],
    pattern: {
        DateTime: "",
        Title: "",
        Message: "",
        LoggerSpecificData: "localhost",
        LogSpecificData: "ThisLogType"
    },
    log_lvl: 1,
    self_log_lvl: -1
};

const MethDict: IMethDict = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4
}

Object.freeze(AmqpLoggerConfig);
Object.freeze(MethDict);

export { AmqpLoggerConfig, MethDict };
