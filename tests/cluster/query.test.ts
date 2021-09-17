/**
 * Created by Bohdan on Sep, 2021
 */

import galeraCluster from "../../index";
import dotenv from "dotenv";

describe("Cluster queries", () => {
    dotenv.config({path: './.env'});
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
            { key: 'Threads_running', operator: '<', value: 50 }
        ],
        loadFactors: [
            { key: 'Connections', multiplier: 2 },
            { key: 'Threads_running', multiplier: 100 }
        ]
    })

    it("Query without values", async () => {
        await cluster.connect();
        const result = (await cluster.query(`SELECT * from officering_api_doc.MethodType`))[0];
        cluster.disconnect();

        await expect(result.MethodTypeName).toBe("get");
    })

    it("Query with string value", async () => {
        await cluster.connect();
        const result = (await cluster.query(`SELECT * from officering_api_doc.MethodType WHERE MethodTypeID = ?;`, '1'))[0];
        cluster.disconnect();

        await expect(result.MethodTypeName).toBe("get");
    })

    it("Query with array values", async () => {
        await cluster.connect();
        const result = (await cluster.query(`SELECT * from officering_api_doc.MethodType WHERE MethodTypeID = ? OR MethodTypeID = ?;`, ['1', '2']))[0];
        cluster.disconnect();

        await expect(result.MethodTypeName).toBe("get");
    })

    it("Query with object values", async () => {
        await cluster.connect();
        const result = (await cluster.query(
            `SELECT * from officering_api_doc.MethodType WHERE MethodTypeID = :id1 OR MethodTypeID = :id2;`,
            {id1: '1', id2: '2'}
        ))[0];
        cluster.disconnect();

        await expect(result.MethodTypeName).toBe("get");
    })
})
