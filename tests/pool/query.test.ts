/**
 * Created by Bohdan on Sep, 2021
 */

import dotenv from "dotenv";
import { Pool } from '../../src/pool/Pool'
// import { ServiceNodeMap } from "../../src/types/PoolInterfaces";

describe("Pool queries", () => {
    dotenv.config({path: './.env'});
    const pool = new Pool({
        id: 0,
        host: process.env.DB_HOST2,
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
    });

    it("Query without values", async () => {
        await pool.connect(err => console.log(err));
        const result = (await pool.query(`SELECT * from officering_api_doc.MethodType`))[0];
        pool.disconnect();

        await expect(result.MethodTypeName).toBe("get");
    })

    it("Query with timeout option", async () => {
        await pool.connect(err => console.log(err));
        try {
            await pool.query(`SELECT * from officering_api_doc.MethodType`, { timeout: 5 });
        } catch (e) {
            console.log(e.message);
            await expect(e.message).toContain("Query inactivity timeout");
        }
        pool.disconnect();
    })

    // it("Query change database", async () => {
    //     await cluster.connect();
    //     // await cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [20, 'test', '192.168.0.1', 3306],
    //     // {
    //     //     database: 'mysql-dynamic-cluster'
    //     // });
    //     await cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [100, 'test', '0.0.0.0', 3306], {
    //         database: 'mysql-dynamic-cluster'
    //     });
    //
    //     const result = (await cluster.query('SELECT FN_GetServiceNodeMapping();', null,
    //     {
    //         database: 'mysql-dynamic-cluster'
    //     }))[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;
    //     cluster.disconnect();
    //
    //     console.log(result);
    //     await expect(result[1]).toBe(0);
    // })
})
