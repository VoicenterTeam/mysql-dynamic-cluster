/**
 * Created by Bohdan on Mar, 2022
 */

export enum LOGLEVEL {
	QUIET,
	REGULAR,
	FULL
}

export interface IUserAmqpConfig {
	pool?: IAmqpLog[],
	topic?: string
	pattern?: IAmqpPattern,
	log_lvl?: number,
	self_log_lvl?: number
}

export interface IDefaultAmqpConfig extends IUserAmqpConfig {
	log_amqp: IAmqpLog[],
	pattern: IDefaultAmqpPattern,
	log_lvl: number
	self_log_lvl: number
}

export interface IAmqpConfig extends IUserAmqpConfig {
	meth_dict: IMethDict
}

export interface IMethDict {
	[key: string]: number
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
	exchange: IAmqpExchange,
	queue?: IAmqpQueue,
	binding?: IAmqpBiding,
	prefetch?: number
}
interface IAmqpExchange {
	name: string,
	type: string,
	options: object
}
interface IAmqpQueue {
	name: string,
	options: object
}
interface IAmqpBiding {
	name: string,
	options: object
}

interface IAmqpPattern {
	DateTime?: string,
	Title?: string,
	Message?: string,
	LoggerSpecificData?: string,
	LogSpecificData?: string
}

interface IDefaultAmqpPattern extends IAmqpPattern{
	DateTime: string,
	Title: string,
	Message: string,
	LoggerSpecificData: string,
	LogSpecificData: string
}
