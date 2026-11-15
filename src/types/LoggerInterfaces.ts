export enum LOGLEVEL {
	INFO = 'info',
	ERROR = 'error',
	DEBUG = 'debug',
    WARN = 'warn',
	SILENT = 'silent'
}

/**
 * Logger the app can pass to createPoolCluster. A winston logger or the console fits as it is
 */
export interface ILogger {
	debug(message: any, meta?: object): void;
	info(message: any, meta?: object): void;
	warn(message: any, meta?: object): void;
	error(message: any, meta?: object): void;
}

export interface ILoggerSettings {
	level?: LOGLEVEL;
}
