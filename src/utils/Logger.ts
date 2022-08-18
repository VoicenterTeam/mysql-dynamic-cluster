/**
 * Created by Bohdan on Sep, 2021
 */

import winstonTransport from '@voicenter-team/failover-amqp-pool/WinstonAMQPPoolTransport';

import { createLogger, transports, format, LoggerOptions } from "winston";
import { LEVEL, MESSAGE, SPLAT} from "triple-beam"

import defaultSettings from '../configs/DefaultSettings';
import { MethDict } from '../configs/AmqpLoggerConfig';
import { IAmqpConfig, IUserAmqpConfig, LOGLEVEL } from "../types/AmqpInterfaces";

const  { combine, timestamp, label, printf } = format;



const winstonTransportFormat = format(({ requestID,subsystem, ...info}) => {
    // if(!requestID) requestID =  namespace && namespace.get("traceID")
    // if(!subsystem) subsystem =  namespace && namespace.get("subsystem")
    info.requestID = requestID
    info.subsystem = subsystem
    return info;
});
// tslint:disable-next-line:no-shadowed-variable
const myFormat = printf(({ level, timestamp,requestID, ...extra }) => {
    return `[${timestamp}]${requestID ? '[req:' + requestID + ']' : '' } [${level}] ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`;
});

const loggerOptions: LoggerOptions = {
    format: combine( winstonTransportFormat(),format.simple()),
    exitOnError:false,
    transports: [new transports.Console({
        level: 'info',
        format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss:SSS' }), myFormat),
        silent: true,
        handleExceptions: true
    })]
}


interface LooseObject{
    enableConsoleLogger: () => void,
    enableAMQPLogger:  (amqpSettings: IUserAmqpConfig) => void,
    init:  (useConsole: boolean, newClusterName: string) => void,
    setLogLevel:  (newLevel: LOGLEVEL) => void
}



const Logger = createLogger(loggerOptions)



 const init = {
    enableConsoleLogger( ){
        this.add(new transports.Console({
            level: 'info',
            format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss:SSS' }), myFormat),
            handleExceptions: true
        }))
    },
    enableAMQPLogger(amqpSettings: IUserAmqpConfig) {
        this.add(new winstonTransport({
            level: amqpSettings.log_lvl,
            format:  combine(timestamp()),
            pool: amqpSettings.pool,
            topic: amqpSettings.topic,
    }))
        this.info("AMQP logger enabled");
    },
    init(useConsole: boolean, newClusterName: string){
        if(useConsole){
            this.enableConsoleLogger()
        }
    },
    setLogLevel(newLevel: LOGLEVEL) {
        this.level = newLevel;
        this.info("Log level changed to " + LOGLEVEL[newLevel])
    }
}

export default Object.assign(Logger, init);
