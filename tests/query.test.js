const galeraCluster = require('../dist/index')
require('dotenv').config()

let cluster;

beforeAll(() => {
    cluster = galeraCluster.createPoolCluster({
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
})

afterAll(() => {
    cluster.disconnect()
})

test('Query Promise', (done) => {
    cluster.query(`SELECT * from officering_api_doc.MethodType`)
        .then(result => {
            expect(result[0].MethodTypeName).toBe('get')
            done()
        })
        .catch(error => throw new Error(error.message))
})
