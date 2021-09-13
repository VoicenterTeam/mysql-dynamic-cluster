import { GlobalSettings } from "../types/SettingsInterfaces";

const GlobalSettings: GlobalSettings = {
  port: "3306",
  connectionLimit: 100,
  validators: [
    { key: 'wsrep_ready', operator: '=', value: 'ON' },
    { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
    { key: 'Threads_running', operator: '<', value: 50 }
  ],
  loadFactors: [
    { key: 'Connections', multiplier: 2 },
    { key: 'Threads_running', multiplier: 100 }
  ],
  timerCheckRange: [5, 15], // time in seconds
  timerCheckMultiplier: 1.3,
  errorRetryCount: 2,
  queryTimeout: 2 * 60 * 1000 // time in ms
}

export default GlobalSettings;