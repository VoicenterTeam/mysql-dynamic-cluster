import { GlobalSettings } from "./interfaces";

const GlobalSettings: GlobalSettings = {
  port: "3306",
  connectionLimit: 100,
  retryCount: 3,
  connectionTimeout: 1000,
  validators: [
    { key: 'wsrep_ready', operator: '=', value: 'ON' },
    { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' }
  ],
  loadFactors: [
    { key: 'Connections', multiplier: 2 },
    { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
  ],
  timerCheckRange: [5, 15], // time in seconds
  timerCheckMultiplier: 1.3,
  errorRetryCount: 2,
  queryTimeout: 2 * 60 * 1000 // time in ms
}

export default GlobalSettings;
