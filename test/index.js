const { galeraCluster } = require('../dist/index')
const { Logger } = require('../dist/lib/Logger');
require('dotenv').config()

const cluster = galeraCluster.createPoolCluster([
    {
        host: process.env.DB_HOST2,
        port: process.env.DB_PORT,
        connectionLimit: process.env.DB_CONNECTION_LIMIT
    },
    {
        host: process.env.DB_HOST3,
        port: process.env.DB_PORT,
        connectionLimit: process.env.DB_CONNECTION_LIMIT
    }
])

cluster.connect(process.env.DB_USERNAME, process.env.DB_PASSWORD, process.env.DB_DATABASE)

cluster.query(`SELECT * from officering_api_doc.MethodType`, (error, result) => {
    if (error) {
        Logger(error)
        return
    }

    console.log(result)


    cluster.disconnect()
})


