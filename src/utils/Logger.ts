import winston from 'winston';
import winstonTransport from '@voicenter-team/failover-amqp-pool/WinstonAMQPPoolTransport';
import { LOGLEVEL, LOGTYPES } from '../types/LoggerInterfaces';
import config from "../configs";
import { IDefaultAmqpConfig } from "../types/AmqpInterfaces";




const consoleFormat = winston.format.printf(({
  level, timestamp, requestID,message, ...extra
}) => {
  return  `[${timestamp}]${requestID ? '[req:' + requestID + ']' : '' } [${level}] ${message} ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`
})


class Logger {
  logger: winston.Logger;
  init(){
    const logLevel = config.get('logs.level')
    const output = config.get('logs.output')
    .split(',')
    .map((out) => out.trim());

    this.logger = winston.createLogger({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      ),
      silent: logLevel === LOGLEVEL.SILENT
    });
    if (output.includes('console')){
      this.logger.add(
				new winston.transports.Console({
					format: consoleFormat,
				}),
			);
    }
    if(output.includes('amqp')){
      const amqpConfig: IDefaultAmqpConfig ={
        topic: config.get('amqp_logs.topic'),
        pool: []
      }
      amqpConfig.pool.push({
        connection: config.get('amqp_logs.connection_master'),
        channel: {
          exchange: config.get('amqp_logs.exchage'),
          queue: config.get('amqp_logs.queue'),
          binding: config.get('amqp_logs.bindings'),
          prefetch: config.get('amqp_logs.prefetch')
        }
      })
      this.logger.add( new winstonTransport(amqpConfig))
    }
  }
  log(type: LOGTYPES, message: string, meta: object = {}): void {
		this.logger.log(type, message, meta);
	}
  	// Convenience methods below
	debug(message: string, meta: object = {}): void {
		this.log(LOGTYPES.DEBUG, message, meta);
	}

	info(message: string, meta: object = {}): void {
		this.log(LOGTYPES.INFO, message, meta);
	}

	error(message: string, meta: object = {}): void {
		this.log(LOGTYPES.ERROR, message, meta);
	}

	verbose(message: string, meta: object = {}): void {
		this.log(LOGTYPES.VERBOSE, message, meta);
	}

	warn(message: string, meta: object = {}): void {
		this.log(LOGTYPES.WARN, message, meta);
	}


}



export default  new Logger()
