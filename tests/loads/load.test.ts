import galeraCluster from '../../index'
import { Utils } from "../../src/utils/Utils";
import dotenv from "dotenv";

beforeAll(() => {
    dotenv.config({ path: './.env' });
})

it("choosing right server in many queries", async () => {
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
})
