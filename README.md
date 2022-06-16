# mysql-dynamic-cluster
Galera cluster with implementation of dynamic choose mysql server for queries, caching, hashing it and metrics

## Features
1. **Pool checks** by 2 points:
   1. **Pool status** - if pool is valid and ready for work checked by [validators](#pool-settings)
   2. **Pool score** - prioritizing pools by load checked by [load factors](#pool-settings). Less load on the top
2. **Hashing services** for query - set to the table pool by service if query was successful with this service. Another query with the same service will be trying process in the pool from table
3. **Filter pools** by criteria:
   1. Pool status
4. **Sort pools** by criteria:
      1. Cluster hashing
      2. Pool score
5. **Caching query** by Redis
6. **Realtime metrics** for cluster and each database node
7. **Console logger** and [AMQP logger](#amqp-settings)

## Technologies
- [mysql2](https://www.npmjs.com/package/mysql2)
- [amqp-logger](https://www.npmjs.com/package/@voicenter-team/amqp-logger)
- [pm2.io metrics](https://www.npmjs.com/package/@pm2/io)
- [ioredis](https://www.npmjs.com/package/ioredis)
- [jest](https://www.npmjs.com/package/jest)
- [typescript](https://www.npmjs.com/package/typescript)

## Install
Download project from npm
```bash
$ npm i @voicenter-team/mysql-dynamic-cluster
```

## How to use
### Configure cluster
This is just main settings what necessary to configure cluster.
More detail about user settings [here](#user-settings)
```javascript
const cfg = {
    clusterName: 'demo',
    // Configuration for each pool. At least 2 pools are recommended
    hosts: [
        {
            host: "192.168.0.1",
            name: "demo1",
            /**
             * You can reconfigure global parameters for current pool
             */
            queryTimeout: 5000,
            user: "user_current",
            password: "password_current",
            database: "db_name_current"
        },
        {
            /**
             * ID is automatically generated, but if you set the id at least for one pool 
             * then other pools will be generated with a higher id 
             * started from the highest manually set id
             */
            id: 10,
            host: "192.168.0.2"
        }
    ],
    // Configuration for all pools
    globalPoolSettings: {
        user: "user",
        password: "password",
        database: "db_name"
    },
    logLevel: LOGLEVEL.FULL
}
```

### Example
`cfg` - [configuration for cluster](#configure-cluster)
```javascript
const galeraCluster = require('@voicenter-team/mysql-dynamic-cluster');
const cluster = galeraCluster.createPoolCluster(cfg);

async function test() {
   await cluster.connect();

   try {
      const result = await cluster.query(`SELECT SLEEP(5);`);
   } catch (e){
      console.log(e.message);
   }

   await cluster.disconnect();
}

test();
```

## Params
Exported library params

<table>
    <thead>
        <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Type</th>
            <th>Values</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>connected</td>
            <td>Status of cluster</td>
            <td>boolean</td>
            <td>
               <b>true</b> - cluster completely created <br>
               <b>false</b> - not connected yet or had some errors
            </td>
            <td>false</td>
        </tr>
        <tr>
            <td>LOGLEVEL</td>
            <td>Console log levels</td>
            <td>Enum</td>
            <td>
               <b>QUIET</b> - only warning and errors <br>
               <b>REGULAR</b> - all information instead debug <br>
               <b>FULL</b> - all log information <br>
            </td>
            <td>REGULAR</td>
        </tr>
    </tbody>
</table>

## Functions
### createPoolCluster
Creating the cluster and initialize with [user settings](#user-settings) <br>
Params:
1. [Cluster configuration](#user-settings) to configure library

```javascript
galeraCluster.createPoolCluster({
   hosts: [
      {
         host: "192.168.0.1",
      }
   ],
   user: "admin",
   password: "password_global",
   database: "global_db",
})
```

### connect
Connecting to all database pools passed in [user settings](#user-settings)
```javascript
cluster.connect()
```

### disconnect
Disconnecting from all database pools
```javascript
cluster.disconnect()
```

### on
Connecting to [events](#connect-to-events) <br>
Params:
1. Name of event
2. Callback when event is emitted

```javascript
cluster.on('connected', () => {
    console.log("Some stuff after an event emitted")
})
```

### query
Request to the database. Cluster automatically select best database node (pool) for quick result by filter and sort it. Pools configured in [user settings](#user-settings)  <br>
Params:
1. **Query string** - request to the database
2. **Query values** - values used in query string. Can be one of this structure: `string | any[] | { [paramName: string]: any }`. Similar to [mysql2](https://www.npmjs.com/package/mysql2) query values  
3. [Query options](#query-options) - configuration only for this request

```javascript
cluster.query(`SELECT SLEEP(?)`, [100], { redis: true })
```

## Configs
### User settings
Settings to configure library

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Required</th>
            <th>Type</th>
            <th>Values</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>clusterName</td>
            <td>Cluster name like global prefix for all names used in the library</td>
            <td>true</td>
            <td>string</td>
            <td>-</td>
            <td>-</td>
        </tr>
        <tr>
            <td>hosts</td>
            <td>Configuration for each pool</td>
            <td>true</td>
            <td>Array of object</td>
            <td>

[User pool settings](#user-pool-settings)
            </td>
            <td>-</td>
        </tr>
        <tr>
            <td>globalPoolSettings</td>
            <td>Configuration for all pools</td>
            <td>true</td>
            <td>object</td>
            <td>

[Global pool settings](#global-pool-settings)
            </td>
            <td>-</td>
        </tr>
        <tr>
            <td>redis</td>
            <td>Redis object created using <i>ioredis</i> library</td>
            <td>false</td>
            <td>Redis object</td>
            <td>

[Redis](https://www.npmjs.com/package/ioredis)
</td>
            <td>Default redis object using <i>ioredis</i> library</td>
        </tr>
        <tr>
            <td>errorRetryCount</td>
            <td>How much retry query in different servers if you have error</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>2</td>
        </tr>
        <tr>
            <td>useRedis</td>
            <td>Enable cache query using Redis</td>
            <td>false</td>
            <td>boolean</td>
            <td>-</td>
            <td>true</td>
        </tr>
        <tr>
            <td>serviceMetrics</td>
            <td>Configuration for service metrics</td>
            <td>false</td>
            <td>object</td>
            <td>

[Service metrics](#service-metrics-settings)
</td>
            <td>
<pre>
{
    database: 'swagger_realtime',
    table: 'Service'
}
</pre>
            </td>
        </tr>
        <tr>
            <td>useClusterHashing</td>
            <td>Enable cluster hashing</td>
            <td>false</td>
            <td>boolean</td>
            <td>-</td>
            <td>true</td>
        </tr>
        <tr>
            <td>clusterHashing</td>
            <td>Cluster hashing configuration</td>
            <td>false</td>
            <td>object</td>
            <td>

[Cluster hashing](#cluster-hashing-settings)
</td>
            <td>
<pre>
{
    nextCheckTime: 5000,
    dbName: "mysql_dynamic_cluster"
}
</pre>
            </td>
        </tr>
        <tr>
            <td>showMetricKeys</td>
            <td>Show metric keys instead metric names</td>
            <td>false</td>
            <td>boolean</td>
            <td>-</td>
            <td>false</td>
        </tr>
        <tr>
            <td>useAmqpLogger</td>
            <td>Enable AMQP logger</td>
            <td>false</td>
            <td>boolean</td>
            <td>-</td>
            <td>true</td>
        </tr>
        <tr>
            <td>amqpLoggerSettings</td>
            <td>AMQP logger configuration</td>
            <td>false</td>
            <td>object</td>
            <td>

[AMQP settings](#amqp-settings)
</td>
            <td>

[AMQP settings](#amqp-settings)
</td>
        </tr>
        <tr>
            <td>useConsoleLogger</td>
            <td>Enable console logger in this library</td>
            <td>false</td>
            <td>boolean</td>
            <td>-</td>
            <td>true</td>
        </tr>
        <tr>
            <td>redisSettings</td>
            <td>Redis configuration</td>
            <td>false</td>
            <td>object</td>
            <td>

[Redis settings](#redis-settings)
</td>
            <td>

[Redis settings](#redis-settings)
</td>
        </tr>
        <tr>
            <td>logLevel</td>
            <td>Console logging level</td>
            <td>false</td>
            <td>enum</td>
            <td>
               <b>QUIET</b> - only warning and errors <br>
               <b>REGULAR</b> - all information instead debug <br>
               <b>FULL</b> - all log information <br>
            </td>
            <td>QUIET</td>
        </tr>
    </tbody>
</table>

### Pool settings
General pool settings which inherited by [user pool settings](#user-pool-settings) and [global pool settings](#global-pool-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Required</th>
            <th>Type</th>
            <th>Values</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>port</td>
            <td>Port to connect to database</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>3306</td>
        </tr>
        <tr>
            <td>connectionLimit</td>
            <td>Connection limit in 1 database</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>100</td>
        </tr>
        <tr>
            <td>queryTimeout</td>
            <td>Timeout for query</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>120 000</td>
        </tr>
        <tr>
            <td>validators</td>
            <td>Validator params to check if pool is valid (pool status) and ready for work</td>
            <td>false</td>
            <td>Array of objects</td>
            <td>
                <b>key</b> - name (variable_name) of mysql global status <br>
                <b>operator</b> - operator to check with value. Exist: `=`, `<`, `>`, `Like`. For text only `=` or `Like` operator. `Like` is not strict equal check. <br>
                <b>value</b> - value what must be to complete pool check <br>
            </td>
            <td>

```typescript
[
    { key: 'wsrep_ready', operator: '=', value: 'ON' },
    { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
    { key: 'Threads_running', operator: '<', value: 50 }
]
```
</td>
        </tr>
        <tr>
            <td>loadFactors</td>
            <td>Load factor params to count pool score by load. Using to sort pools</td>
            <td>false</td>
            <td>Array of objects</td>
            <td>
                <b>key</b> - name (variable_name) of mysql global status <br>
                <b>multiplier</b> - multiplies the result to achieve the corresponding pool score <br>
            </td>
            <td>

```typescript
[
    { key: 'Connections', multiplier: 2 },
    { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
]
```
</td>
        </tr>
        <tr>
            <td>timerCheckRange</td>
            <td>Time range for next check pool status and pool score</td>
            <td>false</td>
            <td>Object</td>
            <td>
                <b>start</b> - min time <br>
                <b>end</b> - max time
            </td>
            <td>
<pre>
{
    start: 5000,
    end: 15000
}
</pre>
            </td>
        </tr>
        <tr>
            <td>timerCheckMultiplier</td>
            <td>Multiplier to increase time if check finish correctly and decrease it if had error in check. Time used for next check pool status and pool score</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>1.3</td>
        </tr>
        <tr>
            <td>slowQueryTime</td>
            <td>Logs query time that will consider slow in ms</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>1</td>
        </tr>
        <tr>
            <td>redisFactor</td>
            <td>Multiplier for set expire time in Redis</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td>100</td>
        </tr>
    </tbody>
</table>

### Global pool settings
Global pool settings is extended version of [pool settings](#pool-settings) using to configure all pools <br>
Used in [user settings](#user-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Required</th>
            <th>Type</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>user</td>
            <td>Username to connect to database</td>
            <td>true</td>
            <td>string</td>
            <td>-</td>
        </tr>
        <tr>
            <td>password</td>
            <td>Password to connect to database</td>
            <td>true</td>
            <td>string</td>
            <td>-</td>
        </tr>
        <tr>
            <td>database</td>
            <td>Default database name to connect</td>
            <td>true</td>
            <td>string</td>
            <td>-</td>
        </tr>
    </tbody>
</table>

### User pool settings
User pool settings is extended version of [pool settings](#pool-settings) using to configure each pool individually <br>
Used in [user settings](#user-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Required</th>
            <th>Type</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>host</td>
            <td>Host to database</td>
            <td>true</td>
            <td>string</td>
            <td>-</td>
        </tr>
        <tr>
            <td>id</td>
            <td>ID for pool</td>
            <td>false</td>
            <td>number</td>
            <td>Automatically generated, but if you set the id at least for one pool then other pools will be generated with a higher id started from the highest manually set id</td>
        </tr>
        <tr>
            <td>name</td>
            <td>Custom name for pool</td>
            <td>false</td>
            <td>string</td>
            <td>Automatically generated from host and port</td>
        </tr>
        <tr>
            <td>user</td>
            <td>Username to connect to database</td>
            <td>false</td>
            <td>string</td>
            <td>Set in global pool settings</td>
        </tr>
        <tr>
            <td>password</td>
            <td>Password to connect to database</td>
            <td>false</td>
            <td>string</td>
            <td>Set in global pool settings</td>
        </tr>
        <tr>
            <td>database</td>
            <td>Default database name to connect</td>
            <td>false</td>
            <td>string</td>
            <td>Set in global pool settings</td>
        </tr>
        <tr>
            <td>redisExpire</td>
            <td>Expire time for data in redis</td>
            <td>false</td>
            <td>number</td>
            <td>Redis settings <i>expire</i></td>
        </tr>
    </tbody>
</table>

### Redis settings
Configuration for Redis. Cashing the query <br>
Used in [user settings](#user-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Required</th>
            <th>Type</th>
            <th>Value</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>keyPrefix</td>
            <td>Prefix for all keys</td>
            <td>false</td>
            <td>string</td>
            <td>-</td>
            <td>mdc:</td>
        </tr>
        <tr>
            <td>expire</td>
            <td>Expire for stored data</td>
            <td>false</td>
            <td>number</td>
            <td>-</td>
            <td> 1 000 000</td>
        </tr>
        <tr>
            <td>expiryMode</td>
            <td>Expire mode</td>
            <td>false</td>
            <td>string</td>
            <td>-</td>
            <td>EX</td>
        </tr>
        <tr>
            <td>algorithm</td>
            <td>Algorithm for hashing</td>
            <td>false</td>
            <td>string</td>
            <td>-</td>
            <td>md5</td>
        </tr>
        <tr>
            <td>encoding</td>
            <td>Encoding for hashing</td>
            <td>false</td>
            <td>BinaryToTextEncoding</td>
            <td>
                <b>base64</b>
                <b>hex</b>
            </td>
            <td>base64</td>
        </tr>
        <tr>
            <td>clearOnStart</td>
            <td>Clear all data on library start</td>
            <td>false</td>
            <td>boolean</td>
            <td>-</td>
            <td>false</td>
        </tr>
    </tbody>
</table>

### AMQP settings
Settings to configure amqp logger. Logging to the console in object format and send to the AMQP server, for example RabbitMQ. <br>
All parameters are **not required** <br>
Used in [user settings](#user-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
            <th>Value</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>log_amqp</td>
            <td>Configuration for connection and channel for logging</td>
            <td>array of object</td>
            <td>
                <b>connection</b> - configuration for AMQP connection

[AMQP connection](#amqp-connection)
                <br>
                <br>
                <b>channel</b> - configuration for AMQP channel

[AMQP channel](#amqp-channel)
            </td>
            <td>

```typescript
[
    {
        connection: {
            host: "127.0.0.1",
            port: 5672,
            ssl: false,
            username: "guest",
            password: "guest",
            vhost: "/",
            heartbeat: 5
        },
        channel: {
            directives: "ae",
            exchange_name: "MDC",
            exchange_type: "fanout",
            exchange_durable: true,
            topic: "",
            options: {}
        }
    }
]
```
</td>
        </tr>
        <tr>
            <td>pattern</td>
            <td>Pattern for AMQP</td>
            <td>string</td>
            <td>

[AMQP pattern](#amqp-pattern)
</td>
            <td>

[AMQP pattern](#amqp-pattern)
</td>
        </tr>
        <tr>
            <td>log_lvl</td>
            <td>Logging level send to AMQP</td>
            <td>number</td>
            <td>
                Number means allow logging from a level number to a lower number <br>
                <b>0</b> - error <br>
                <b>1</b> - warning <br>
                <b>2</b> - info <br>
                <b>3</b> - debug <br>
                <b>4</b> - trace <br>
            </td>
            <td>1</td>
        </tr>
        <tr>
            <td>self_log_lvl</td>
            <td>Logging level to console from AMQP library</td>
            <td>number</td>
            <td>
                Number means allow logging from a level number to a lower number <br>
                <b>0</b> - error <br>
                <b>1</b> - warning <br>
                <b>2</b> - info <br>
                <b>3</b> - debug <br>
                <b>4</b> - trace <br>
            </td>
            <td>1</td>
        </tr>
    </tbody>
</table>

#### AMQP connection
Configuration for AMQP connection. <br>
All parameters are **required** <br>
Used in [AMQP settings](#amqp-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>host</td>
            <td>Host to connect to AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>port</td>
            <td>Port to hosted AMQP</td>
            <td>number</td>
        </tr>
        <tr>
            <td>ssl</td>
            <td>If AMQP host use ssl</td>
            <td>boolean</td>
        </tr>
        <tr>
            <td>username</td>
            <td>Username to connect to AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>password</td>
            <td>Password to connect to AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>vhost</td>
            <td>Vhost for AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>heartbeat</td>
            <td>Heartbeat rate for AMQP</td>
            <td>number</td>
        </tr>
    </tbody>
</table>

#### AMQP channel
Configuration for AMQP channel. <br>
All parameters are **required** <br>
Used in [AMQP settings](#amqp-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>directives</td>
            <td>Directives AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>exchange_name</td>
            <td>Exchange name AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>exchange_type</td>
            <td>Exchange type AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>exchange_durable</td>
            <td>Exchange durable AMQP</td>
            <td>boolean</td>
        </tr>
        <tr>
            <td>topic</td>
            <td>Topic AMQP</td>
            <td>string</td>
        </tr>
        <tr>
            <td>options</td>
            <td>Options for AMQP channel</td>
            <td>object</td>
        </tr>
    </tbody>
</table>

#### AMQP pattern
Configuration for AMQP pattern. <br>
All parameters are **not required** <br>
Used in [AMQP settings](#amqp-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>DateTime</td>
            <td>Date time AMQP</td>
            <td>string</td>
            <td>" "</td>
        </tr>
        <tr>
            <td>Title</td>
            <td>Title AMQP</td>
            <td>string</td>
            <td>" "</td>
        </tr>
        <tr>
            <td>Message</td>
            <td>Message AMQP</td>
            <td>string</td>
            <td>" "</td>
        </tr>
        <tr>
            <td>LoggerSpecificData</td>
            <td>Logger specific data AMQP</td>
            <td>string</td>
            <td>"localhost"</td>
        </tr>
        <tr>
            <td>LogSpecificData</td>
            <td>Log specific data AMQP</td>
            <td>string</td>
            <td>"ThisLogType"</td>
        </tr>
    </tbody>
</table>

### Cluster hashing settings
Configuration for cluster hashing. Cluster hashing set pool with current service on the top if exist in the hashing table. Service set to the table if query was success with this service. <br>
All parameters are **not required** <br> 
Used in [user settings](#user-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>nextCheckTime</td>
            <td>Next check time in database</td>
            <td>number</td>
            <td>5000</td>
        </tr>
        <tr>
            <td>dbName</td>
            <td>Database name for hashing</td>
            <td>string</td>
            <td>"mysql_dynamic_cluster"</td>
        </tr>
    </tbody>
</table>

### Service metrics settings
Configuration for service metrics to get correct data about services. Table must contain columns:
- ServiceID
- ServiceName
<br>

All parameters are **not required** <br>
Used in [user settings](#user-settings)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
            <th>Default</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>database</td>
            <td>Database name where stored information about services</td>
            <td>string</td>
            <td>"swagger_realtime"</td>
        </tr>
        <tr>
            <td>table</td>
            <td>Table name where stored all service ids</td>
            <td>string</td>
            <td>"Service"</td>
        </tr>
    </tbody>
</table>

### Query options
Reconfigure for current one query only. <br>
All parameters are **not required**. Default parameters are set using [pool settings](#pool-settings), [cluster settings](#user-settings) and [redis settings](#redis-settings) <br>
Used in each [query](#query)

<table>
    <thead>
        <tr>
            <th>Parameter name</th>
            <th>Description</th>
            <th>Type</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>timeout</td>
            <td>Timeout of waiting query request</td>
            <td>number</td>
        </tr>
        <tr>
            <td>database</td>
            <td>Database name where query should run</td>
            <td>string</td>
        </tr>
        <tr>
            <td>serviceName</td>
            <td>
                Service name to add this query to service metrics. By this name will find service id from table configured in service metrics. <br>
                <b>Don't use it, if passed serviceId</b>
            </td>
            <td>string</td>
        </tr>
        <tr>
            <td>serviceId</td>
            <td>
                Service id to add this query to service metrics. <br> 
                <b>Don't use it, if passed serviceName</b>
            </td>
            <td>number</td>
        </tr>
        <tr>
            <td>maxRetry</td>
            <td>How much retry query in different servers if you have error</td>
            <td>number</td>
        </tr>
        <tr>
            <td>redis</td>
            <td>Use redis for current query or not</td>
            <td>boolean</td>
        </tr>
        <tr>
            <td>redisFactor</td>
            <td>Multiplier for set expire time in Redis for current query</td>
            <td>number</td>
        </tr>
        <tr>
            <td>redisExpire</td>
            <td>Expire time for data in redis for current query</td>
            <td>number</td>
        </tr>
    </tbody>
</table>

## Connect to events
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

### hashing_created
The cluster will emit `hashing_created` event when hashing in cluster is completely created and connected.
```javascript
cluster.on('hashing_created', () => {
    console.log("Cluster hashing completely created");
})
```

### acquire
The pool will emit an `acquire` event when a connection is acquired from the pool. This is called after all acquiring activity has been performed on the connection, right before the connection is handed to the callback of the acquiring code.
```javascript
cluster.on('acquire', (connection, poolId) => {
    console.log('Connection %d acquired', connection.threadId, poolId);
})
```

### connection
The pool will emit a `connection` event when a new connection is made within the pool. If you need to set session variables on the connection before it gets used, you can listen to the `connection` event.
```javascript
cluster.on('connection', (connection, poolId) => {
    console.log('New connection made', connection.threadId, poolId);
})
```

### release
The pool will emit a `release` event when a connection is released back to the pool. This is called after all release activity has been performed on the connection, so the connection will be listed as free at the time of the event.
```javascript
cluster.on('release', (connection, poolId) => {
    console.log('Connection %d released', connection.threadId, poolId);
})
```

### pool_connected
The pool will emit `pool_connected` event when pool is completely connected. 
```javascript
cluster.on('pool_connected', (poolId) => {
    console.log("Pool completely created", poolId);
})
```

### pool_disconnected
The pool will emit `pool_disconnected` event when pool is completely disconnected.
```javascript
cluster.on('pool_disconnected', (poolId) => {
    console.log("Pool completely disconnected", poolId);
})
```

## Demo
Demo file `index.js` for how to use the library in `demo` folder. Build the project to run it

## Build
### Clone repository
```bash
$ git clone https://github.com/VoicenterTeam/mysql-dynamic-cluster.git
```

### Install dependencies
```bash
$ npm install
```

### Build the project
```bash
$ npm run build
```

### Create .env  
Create copy of `.env.example` and name it `.env`. Set correct values

### Run
To test that all work correctly run the [demo file](#demo) with script:
```bash
$ npm run start
```

## Tests
All unit tests in `tests` folder. Test created using [jest](https://www.npmjs.com/package/jest) library.  
To run all tests use script:
```bash
$ npm run test
```
