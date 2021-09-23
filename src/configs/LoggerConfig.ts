/**
 * Created by Bohdan on Sep, 2021
 */

const LoggerConfig = {
    "log_amqp": [
        {
            "connection": {
                "host": "127.0.0.1",
                "port": 5672,
                "ssl": false,
                "username": "guest",
                "password": "guest",
                "vhost": "/",
                "heartbeat": 5
            },
            "channel": {
                "directives": "ae",
                "exchange_name": "TestE",
                "exchange_type": "fanout",
                "exchange_durable": true,
                "topic": "",
                "options": {}
            }
        }
    ],
    "pattern": {
        "DateTime": "",
        "Title": "",
        "Message": "",
        "LoggerSpecificData": "localhost",
        "LogSpecificData": "ThisLogType"
    },
    "meth_dict": {
        "error": 0,
        "warn": 1,
        "info": 2,
        "debug": 3,
        "trace": 4
    },
    "log_lvl": 3,
    "self_log_lvl": 3
};

export default LoggerConfig;
