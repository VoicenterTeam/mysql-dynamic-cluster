/**
 * Created by Bohdan on Sep, 2021
 */

const galeraCluster = require('../dist')
require('dotenv').config()
const RedisLib = require('ioredis');

const cfg = {
    // configuration for each pool. 2 pools are minimum
    clusterName: 'demo',
    hosts: [
        {
            host: process.env.DB_HOST2
        },
        {
            id: 10,
            host: process.env.DB_HOST3
        }
    ],
    globalPoolSettings: {
        // Configure global settings for all pools
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
    /**
     * Level for logger. Default REGULAR
     * FULL - show all log information
     * REGULAR - show all information instead debug
     * QUIET - show only warning and errors
     */
    logLevel: galeraCluster.LOGLEVEL.FULL,
    // showMetricKeys: true,
    useAmqpLogger: true,
    useConsoleLogger: true,
    amqpLoggerSettings: {
        log_lvl: 4
    },
    redis: new RedisLib()
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
    /**
     * Enable hashing if needed.
     * Recommend at first running on a server use await for completely create database for hashing
     */
    await cluster.enableHashing();

    try {
        const res = await cluster.query(`SELECT * from officering_api_doc.MethodType`, null, { redis: true });
        console.log(res[0]);
    } catch (e) {
        console.log(e.message);
    }

    console.log("Async test");

    try {
        const res = await cluster.query(`SELECT * from officering_api_doc.MethodType`, null, { redis: true });
        console.log(res[0].MethodTypeName);

        // cluster.disconnect();
    } catch (e) {
        console.log(e.message);
    }

    /**
     * Part of code to test load
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

