/**
 * Created by Bohdan on Mar, 2022
 */

export interface IUserAmqpConfig {
	topic?: string,
	connection_master: IAmqpConnection,
	exchage: IAmqpExchange,
	queue: IAmqpQueue,
	bindings: IAmqpBinding,
	prefetch?: number
}
export enum ExchangeType {
	TOPIC = 'topic',
	HEADERS = 'headers',
	FANOUT = 'fanout',
    DIECT = 'dierct',
}

export interface IDefaultAmqpConfig {
	pool: IAmqp[],
	topic?: string,
}

export interface IAmqpConfig extends IUserAmqpConfig {
	meth_dict: IMethDict
}

export interface IMethDict {
	[key: string]: number
}

interface IAmqp {
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
	exchange: IAmqpExchange
	queue: IAmqpQueue
	binding?: IAmqpBinding,
	prefetch?: number
}


interface IAmqpExchange {
	name: string,
	type: ExchangeType,
	options?: IAmqpExchangeOptions
}
interface IAmqpExchangeOptions {
	durable: boolean
}
interface IAmqpQueue{
	name: string,
	options?: IAmqpQueueOptions
}
interface IAmqpQueueOptions {
	exclusive: boolean,
	durable: boolean
}

interface IAmqpBinding{
	enabled: boolean
	pattern: string,
	options?: IAmqpBindingOptions
}

interface IAmqpBindingOptions{}




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
