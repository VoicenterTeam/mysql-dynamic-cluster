/**
 * Created by Bohdan on Sep, 2021
 */

import galeraCluster from '../../index'
import { Utils } from "../../src/utils/Utils";
import dotenv from "dotenv";
import { GlobalStatusResult } from "../../src/types/PoolInterfaces";

beforeAll(() => {
    dotenv.config({ path: './.env' });
})

it("choosing right server in many queries", async () => {
    expect.assertions(2);
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

    const utils = new Utils();

    await cluster.connect();
    for (let i = 0; i < 100; i++) {
        try {
            cluster.query(`select sleep(100);`);
            await utils.sleep(2000);
        } catch (e){
            console.log(e.message);
        }
    }

    const results: GlobalStatusResult[] = [];
    results.push((await cluster.pools[0].query(`SHOW GLOBAL STATUS LIKE 'Threads_running';`))[0] as GlobalStatusResult);
    results.push((await cluster.pools[1].query(`SHOW GLOBAL STATUS LIKE 'Threads_running';`))[0] as GlobalStatusResult);
    cluster.disconnect();
    await expect(+results[0].Value).toBeGreaterThanOrEqual(22);
    await expect(+results[1].Value).toBeGreaterThanOrEqual(22);
})
