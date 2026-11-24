import { ILogger, LOGLEVEL } from '../types/LoggerInterfaces';

type LogMethod = keyof ILogger;

// From the most to the least verbose. A level lets through itself and everything after it
const LEVEL_ORDER: LogMethod[] = ['debug', 'info', 'warn', 'error'];

const pad = (value: number) => String(value).padStart(2, '0');

const timestamp = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// meta as text. Never throws: circular or BigInt values fall back to String()
const metaText = (meta?: object): string => {
  if (!meta || !Object.keys(meta).length) return '';
  try {
    return JSON.stringify(meta);
  } catch (e) {
    return String(meta);
  }
}

const consoleLine = (level: LogMethod) => (message: any, meta?: object): void => {
  const text = message instanceof Error ? message.stack || message.message : message;
  console.log(`[${timestamp()}] [${level}] ${text} ${metaText(meta)}`);
}

/**
 * Default logger: one entry per message on stdout. An Error is printed with its stack
 */
export const consoleLogger: ILogger = {
  debug: consoleLine('debug'),
  info: consoleLine('info'),
  warn: consoleLine('warn'),
  error: consoleLine('error')
}

/**
 * Library logger. Writes to the console, or to the logger the app passed to createPoolCluster.
 * The library owns no log transport: sending logs anywhere else is up to the app's logger.
 * The logger of each cluster is Object.create() of the module logger with init() called on it,
 * see clusterContext in index.ts (#86): it has these methods, and only _logger and _level of
 * its own. So the fields stay TS-private, never JS #private, which a method called on such a
 * view could not read, and the class keeps no other state per instance: a view would share it
 * with the module logger
 */
class Logger {
  private _logger: ILogger = consoleLogger;
  private _level: LOGLEVEL = LOGLEVEL.INFO;

  /**
   * @param level lowest level to log, applied to the app's logger too. An unknown level means info
   * @param logger logger of the app. The console when not passed
   * @throws Error when the logger lacks one of the four methods
   */
  init(level: LOGLEVEL, logger?: ILogger) {
    if (logger !== undefined && logger !== null) {
      const missing = LEVEL_ORDER.filter(method => typeof logger[method] !== 'function');
      if (missing.length) {
        throw new Error("Invalid logger: it has no " + missing.join(', ') + " method");
      }
    }

    const known = level === LOGLEVEL.SILENT || LEVEL_ORDER.indexOf(level as LogMethod) !== -1;
    this._level = known ? level : LOGLEVEL.INFO;
    this._logger = logger || consoleLogger;
  }

  debug(message: any, meta?: object): void {
    this._log('debug', message, meta);
  }

  info(message: any, meta?: object): void {
    this._log('info', message, meta);
  }

  warn(message: any, meta?: object): void {
    this._log('warn', message, meta);
  }

  error(message: any, meta?: object): void {
    this._log('error', message, meta);
  }

  private _log(method: LogMethod, message: any, meta?: object): void {
    if (this._level === LOGLEVEL.SILENT) return;
    if (LEVEL_ORDER.indexOf(method) < LEVEL_ORDER.indexOf(this._level as LogMethod)) return;

    // a failing logger must never fail a query, whether it throws or returns a rejected promise
    try {
      const logger: any = this._logger;
      const result = meta === undefined ? logger[method](message) : logger[method](message, meta);
      if (result && typeof result.catch === 'function') result.catch(() => undefined);
    } catch (e) {
      // nowhere left to report it
    }
  }
}

export default  new Logger()
