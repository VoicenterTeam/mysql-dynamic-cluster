

export enum LOGLEVEL {
	INFO = 'info',
	ERROR = 'error',
	DEBUG = 'debug',
    WARN = 'warn',
	SILENT = 'silent'
}
export enum OUTPUT {
	CONSOLE = 'console',
	AMQP = 'amqp',
}
export enum LOGTYPES {
	DEBUG = 'debug',
	INFO = 'info',
	ERROR = 'error',
	VERBOSE = 'verbose',
	WARN = 'warn',
}
export interface ILoggerSettings {
	level: LOGLEVEL;
	output: string;
}
