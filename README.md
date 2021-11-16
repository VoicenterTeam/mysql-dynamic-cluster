# mysql-dynamic-cluster
Galera cluster with implementation of dynamic choose mysql server for queries and hashing services

## Logic
1. Choose what pool to use for mysql query. Choosing by 2 points:
   1. Validators - if pool is valid and ready for work
   2. Load factors - prioritize pools by load. Less load on the top
2. Hashing services for fast respond
3. Realtime metrics for tracking
4. Custom logger to console and RabbitMQ

## Install
Download project from npm
```bash
npm i <name>
```

## How to use

### Configuration

```javascript
const cfg = {
    // configuration for each pool. 2 pools are minimum
    hosts: [
        {
            host: "192.168.0.1", // required
            // This settings is not required. It configure settings for each pool
            name: "test1", // name to set to the pool
            queryTimeout: 5000,
            // connect to db only for this pool
            user: "admin",
            password: "password",
            database: "test_db"
        },
        {
            id: 10, // id to set to the pool. Not required
            host: "192.168.0.2"
        }
    ],
    // Configure global settings for all pools
    user: "admin",
    password: "password_global",
    database: "global_db",
    /**
     * Validators to set that pool is valid and ready for work
     * key - variable_name in mysql global status
     * operator - operator to compare (=, <, >). For text only '='
     * value - what value must be to complete pool check
     */
    validators: [
        { key: 'wsrep_ready', operator: '=', value: 'ON' },
        { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
        { key: 'available_connection_count', operator: '>', value: 50 }
    ],
    /**
     * Load factors to sort the pools depends on load
     * key - variable_name in mysql global status
     * multiplier - multiply value of corresponding variable_name in mysql global status selected by key
     */
    loadFactors: [
        { key: 'Connections', multiplier: 2 },
        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
    ],
    /**
     * Level for logger. Default QUIET
     * FULL - show all log information
     * REGULAR - show all information instead debug
     * QUIET - show only warning and errors
     */
    logLevel: LOGLEVEL.FULL
}
```

### Example
```javascript
const galeraCluster = require('<name>');
const cluster = galeraCluster.default.createPoolCluster(cfg);

await cluster.connect();
/**
 * Enable hashing if need.
 * Recommend at first running on a server use await for completely create database for hashing
 */
await cluster.enableHashing();

try {
    const result = await cluster.query(`SELECT SLEEP(5);`);
    await cluster.disconnect();
} catch (e){
    console.log(e.message);
}
```

## Demo
Demo file **index.js** for how to use the library in **demo** folder. Build the project to run it

## Build
Clone repo and install dependencies:
```bash
git clone https://github.com/VoicenterTeam/mysql-dynamic-cluster.git
npm install
```

Build the project:
```bash
npm run build
```

To test that all work correctly run the demo file with script:
```bash
npm run start
```

## Tests
All unit tests in **tests** folder. Test created using **jest** library.  
To run all tests use script:
```bash
npm run test
```
