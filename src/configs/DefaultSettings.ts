/**
 * Created by Bohdan on Sep, 2021
 */

import { DefaultSettings, LOGLEVEL } from "../types/SettingsInterfaces";

const DefaultSettings: DefaultSettings = {
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
  timerCheckRange: [5000, 15000],
  timerCheckMultiplier: 1.3,
  errorRetryCount: 2,
  queryTimeout: 2 * 60 * 1000, // time in ms
  logLevel: LOGLEVEL.REGULAR,
  use_amqp_logger: false
}

export default DefaultSettings;
