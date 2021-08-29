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

cluster.query(`SELECT * from officering_api_doc.MethodType`, (error, result) => {
    if (error) {
        console.log(error.toString())
        return
    }

    console.log("Query1 -> ", result[0])
})

console.log("Test")

cluster.query(`SELECT * from officering_api_doc.MethodType`, (error, result) => {
    if (error) {
        console.log(error.toString())
        return
    }

    console.log("Query2 -> ", result[0].MethodTypeName)

    cluster.disconnect()
})

