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
    database: process.env.DB_DATABASE
})

cluster.connect()

async function test() {
    cluster.query(`SELECT * from officering_api_doc.MethodType`)
        .then(result => console.log("Query1 -> ", result[0]))
        .catch(error => console.log(error.message))

    console.log("Test")

    cluster.query(`SELECT * from officering_api_doc.MethodType`)
        .then(result => {
            console.log("Query2 -> ", result[0].MethodTypeName)

            cluster.disconnect()
        })
        .catch(error => console.log(error.message))
}

test()

