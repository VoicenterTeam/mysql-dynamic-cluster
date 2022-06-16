/**
 * Created by Bohdan on Sep, 2021
 */

const galeraCluster = require('../dist')
require('dotenv').config()
const RedisLib = require('ioredis');

const cfg = {
    clusterName: 'demo',
    // Configuration for each pool. At least 2 pools are recommended
    hosts: [
        {
            host: process.env.DB_HOST2,
            name: "demo1",
            /**
             * You can reconfigure global parameters for current pool
             */
            // queryTimeout: 5000,
            // user: "user_current",
            // password: "password_current",
            // database: "db_name_current"
        },
        {
            /**
             * ID is automatically generated, but if you set the id at least for one pool
             * then other pools will be generated with a higher id
             * started from the highest manually set id
             */
            id: 10,
            host: process.env.DB_HOST3
        }
    ],
    // Configure global settings for all pools
    globalPoolSettings: {
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
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
    },
    // showMetricKeys: true,
    // useAmqpLogger: false,
    // useConsoleLogger: false,
    // redis: new RedisLib(),
    /**
     * Level for logger. Default REGULAR
     * FULL - show all log information
     * REGULAR - show all information instead debug
     * QUIET - show only warning and errors
     */
    // logLevel: galeraCluster.LOGLEVEL.FULL,
}

const cluster = galeraCluster.createPoolCluster(cfg);

/**
 * Connect to the cluster event
 */
cluster.on('connected', () => {
    console.log("Cluster completely created. Called from main program");
})

async function test() {
    await cluster.connect();

    try {
        const res = await cluster.query(`SHOW GLOBAL STATUS;`, null, { redis: true });
        console.log(res[0]);
    } catch (e) {
        console.log(e.message);
    }

    try {
        const res = await cluster.query(`SHOW GLOBAL STATUS;`, null, { redis: true });
        console.log(res[0].Variable_name);

        // cluster.disconnect();
    } catch (e) {
        console.log(e.message);
    }

    /**
     * Part of code to test load. Just uncomment if you want to test
     */
    // for (let i = 0; i < 100; i++) {
    //     try {
    //         cluster.query(`select sleep(100);`);
    //     } catch (e){
    //         console.log(e.message);
    //     }
    // }
}

test()

