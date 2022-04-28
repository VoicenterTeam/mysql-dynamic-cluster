/**
 * Created by Bohdan on Sep, 2021
 */

import { IDefaultSettings } from "../types/SettingsInterfaces";
import { AmqpLoggerConfig } from './AmqpLoggerConfig';
import { LOGLEVEL } from "../types/AmqpInterfaces";
import DefaultRedisSettings from "./DefaultRedisSettings";
import DefaultPoolSettings from "./DefaultPoolSettings";

const defaultSettings: IDefaultSettings = {
  globalPoolSettings: DefaultPoolSettings,
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
  redisSettings: DefaultRedisSettings,
  amqpLoggerSettings: AmqpLoggerConfig
}
Object.freeze(defaultSettings);

export default defaultSettings;
