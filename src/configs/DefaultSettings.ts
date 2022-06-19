/**
 * Created by Bohdan on Sep, 2021
 */

import { IDefaultSettings } from "../types/SettingsInterfaces";
import { AmqpLoggerConfig } from './AmqpLoggerConfig';
import { LOGLEVEL } from "../types/AmqpInterfaces";
import DefaultRedisSettings from "./DefaultRedisSettings";
import DefaultPoolSettings from "./DefaultPoolSettings";
import RedisLib from 'ioredis';

const defaultSettings: IDefaultSettings = {
  globalPoolSettings: DefaultPoolSettings,
  redis: null,
  errorRetryCount: 2,
  useRedis: true,
  serviceMetrics: {
    database: 'swagger_realtime',
    table: 'Service'
  },
  useClusterHashing: true,
  clusterHashing: {
    nextCheckTime: 5000,
    dbName: "mysql_dynamic_cluster"
  },
  showMetricKeys: false,
  useConsoleLogger: true,
  useAmqpLogger: true,
  amqpLoggerSettings: AmqpLoggerConfig,
  redisSettings: DefaultRedisSettings,
  logLevel: LOGLEVEL.REGULAR
}
Object.freeze(defaultSettings);

export default defaultSettings;
