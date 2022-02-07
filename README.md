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
npm i @voicenter-team/mysql-dynamic-cluster
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
    logLevel: LOGLEVEL.FULL,
   /**
    * Enabling amqp logger
    * Default: false
    */
   useAmqpLogger: false
}
```

### Example
```javascript
const galeraCluster = require('@voicenter-team/mysql-dynamic-cluster');
const cluster = galeraCluster.createPoolCluster(cfg);

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

## Connect to the events
### connected
The cluster will emit `connected` event when cluster is completely created.
```javascript
cluster.on('connected', () => {
    console.log("Cluster completely created");
})
```
### disconnected
The cluster will emit `disconnected` event when cluster is completely disconnected.
```javascript
cluster.on('disconnected', () => {
    console.log("Cluster completely disconnected");
})
```
### acquire
The pool will emit an `acquire` event when a connection is acquired from the pool. This is called after all acquiring activity has been performed on the connection, right before the connection is handed to the callback of the acquiring code.
```javascript
cluster.on('acquire', (connection) => {
    console.log('Connection %d acquired', connection.threadId);
})
```
### connection
The pool will emit a `connection` event when a new connection is made within the pool. If you need to set session variables on the connection before it gets used, you can listen to the `connection` event.
```javascript
cluster.on('connection', (connection) => {
    console.log("SET SESSION auto_increment_increment=1");
})
```
### release
The pool will emit a `release` event when a connection is released back to the pool. This is called after all release activity has been performed on the connection, so the connection will be listed as free at the time of the event.
```javascript
cluster.on('release', (connection) => {
    console.log('Connection %d released', connection.threadId);
})
```
### pool_connected
The pool will emit `pool_connected` event when pool is completely connected. 
```javascript
cluster.on('pool_connected', () => {
    console.log("Pool completely created");
})
```
### pool_disconnected
The pool will emit `pool_disconnected` event when pool is completely disconnected.
```javascript
cluster.on('pool_disconnected', () => {
    console.log("Pool completely disconnected");
})
```
### hashing_created
The cluster will emit `hashing_created` event when hashing in cluster is completely created and connected.
```javascript
cluster.on('hashing_created', () => {
    console.log("Cluster hashing completely created");
})
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

Create .env
#### Example .env
```dotenv
DB_HOST1=192.168.0.1
DB_HOST2=192.168.0.2
DB_HOST3=192.168.0.3

DB_USERNAME=admin
DB_PASSWORD=password
DB_DATABASE=database
DB_PORT=3306
DB_CONNECTION_LIMIT=100
DB_CHARSET=utf8mb4
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
