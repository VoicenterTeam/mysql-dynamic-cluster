const galeraCluster = require('../dist/index')
require('dotenv').config()

const cluster = galeraCluster.createPoolCluster({
    hosts: [
        {
            host: process.env.DB_HOST2
        },
        {
            host: process.env.DB_HOST3
        }
    ],
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    validators: [
        { key: 'wsrep_ready', operator: '=', value: 'ON' },
        { key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' },
        { key: 'available_connection_count', operator: '>', value: 50 }
    ],
    loadFactors: [
        { key: 'Connections', multiplier: 2 },
        { key: 'wsrep_local_recv_queue_avg', multiplier: 10 }
    ]
})


async function test() {
    await cluster.connect()

    try {
        const res = await cluster.query(`SELECT * from officering_api_doc.MethodType`);
        console.log(res[0]);
    } catch (e){
        console.log(e.message);
    }

    console.log("Async test")

    try {
        const res = await cluster.query(`SELECT * from officering_api_doc.MethodType`);
        console.log(res[0].MethodTypeName)

        cluster.disconnect()

    } catch (e){
        console.log(e.message)
    }
}

test()

