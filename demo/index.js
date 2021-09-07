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

cluster.connect()

async function test() {
    cluster.query(`SELECT * from officering_api_doc.MethodType`)
        .then(result => console.log("Query1 -> ", result[0]))
        .catch(error => console.log(error.message))

    console.log("Async test")

    cluster.query(`SELECT * from officering_api_doc.MethodType`)
        .then(result => {
            console.log("Query2 -> ", result[0].MethodTypeName)

            cluster.disconnect()
        })
        .catch(error => console.log(error.message))
}

test()

