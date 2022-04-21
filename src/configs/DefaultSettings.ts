/**
 * Created by Bohdan on Sep, 2021
 */

import { DefaultSettings } from "../types/SettingsInterfaces";
import { AmqpLoggerConfig } from './AmqpLoggerConfig';
import { LOGLEVEL } from "../types/AmqpInterfaces";

const defaultSettings: DefaultSettings = {
  globalPoolSettings: {
    port: "3306",
    connectionLimit: 100,
    validators: [
      { key: 'wsrep_ready', operator: '=', value: 'ON' },
      { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
      { key: 'Threads_running', operator: '<', value: 50 }
    ],
    loadFactors: [
      { key: 'Connections', multiplier: 2 },
      { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
    ],
    timerCheckRange: {
      start: 5000,
      end: 15000
    },
    timerCheckMultiplier: 1.3,
    errorRetryCount: 2,
    queryTimeout: 2 * 60 * 1000, // time in ms
    slowQueryTime: 1 // time in sec
  },
  serviceMetrics: {
    database: 'swagger_realtime',
    table: 'Service'
  },
  clusterHashing: {
    nextCheckTime: 5000,
    dbName: "mysql_dynamic_cluster"
  },
  showMetricKeys: false,
  logLevel: LOGLEVEL.REGULAR,
  useAmqpLogger: true,
  useConsoleLogger: true,
  redisSettings: {
    algorithm: "md5",
    encoding: "base64",
    keyPrefix: "mdc:",
    expiryMode: "EX",
    expire: 1_000_000,
    clearOnStart: false
  },
  amqpLoggerSettings: AmqpLoggerConfig
}
Object.freeze(defaultSettings);

export default defaultSettings;
