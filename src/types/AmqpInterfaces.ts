/**
 * Created by Bohdan on Mar, 2022
 */

export interface IUserAmqpConfig {
	log_amqp?: IAmqpLog[],
	pattern?: IAmqpPattern,
	log_lvl?: number,
}

export interface IAmqpConfig extends IUserAmqpConfig {
	log_amqp: IAmqpLog[],
	pattern: IAmqpPattern,
	meth_dict: {
		[key: string]: number
	},
	log_lvl: number
	// self_log_lvl: number
}

interface IAmqpLog {
	connection: IAmqpConnection,
	channel: IAmqpChannel
}

interface IAmqpConnection {
	host: string,
	port: number,
	ssl: boolean,
	username: string,
	password: string,
	vhost: string,
	heartbeat: number
}

interface IAmqpChannel {
	directives: string,
	exchange_name: string,
	exchange_type: string,
	exchange_durable: boolean,
	topic: string,
	options: object
}

interface IAmqpPattern {
	DateTime: string,
	Title: string,
	Message: string,
	LoggerSpecificData: string,
	LogSpecificData: string
}
