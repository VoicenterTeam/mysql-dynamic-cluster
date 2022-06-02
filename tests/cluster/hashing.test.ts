/**
 * Created by Bohdan on Sep, 2021
 */

import dotenv from "dotenv";
import { createPoolCluster } from "../../index";
import { ClusterHashing } from "../../src/cluster/ClusterHashing";
import { IServiceNodeMap } from "../../src/types/PoolInterfaces";
import { readdirSync } from "fs";
import { join, parse } from "path";

describe("Cluster hashing", () => {
    dotenv.config({path: './.env'});
    const cluster = createPoolCluster({
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
        database: "mysql-dynamic-cluster",
        validators: [
            {key: 'wsrep_ready', operator: '=', value: 'ON'},
            {key: 'wsrep_local_state_comment', operator: '=', value: 'Synced'},
            {key: 'Threads_running', operator: '<', value: 50}
        ],
        loadFactors: [
            {key: 'Connections', multiplier: 2},
            {key: 'Threads_running', multiplier: 100}
        ]
    })

    it("check creating database for hashing", async () => {
        const database = 'test_hashing';
        const sqlLocations: string[] = [
            '../../assets/sql/create_hashing_database/tables/',
            '../../assets/sql/create_hashing_database/routines/'
        ];
        const sqlFileNames: string[] = [];
        let countCorrectlyCreated: number = 0;

        sqlLocations.forEach(path => {
            readdirSync(join(__dirname, path)).forEach(filename => {
                sqlFileNames.push(parse(filename).name);
            });
        })

        await cluster.connect();
        const clusterHashing = new ClusterHashing(cluster, null, database);
        await clusterHashing.connect();

        const resultTable: any[] = await cluster.query(`show table status from \`${database}\`;`);
        const resultFunc: any[] = await cluster.query(`show function status WHERE Db like '${database}';`);
        const resultProc: any[] = await cluster.query(`show procedure status WHERE Db like '${database}';`);
        [...resultTable, ...resultFunc, ...resultProc].forEach(elem => {
            if (sqlFileNames.includes(elem.Name)) countCorrectlyCreated++;
        })
        await cluster.query(`DROP SCHEMA IF EXISTS \`${database}\`;`);

        clusterHashing.stop();
        cluster.disconnect();
        await expect(countCorrectlyCreated).toBe(sqlFileNames.length);
    })

    it("check value from hashing", async () => {
        await cluster.connect();

        const clusterHashing = new ClusterHashing(cluster);
        await clusterHashing._checkHashing();
        const result1: IServiceNodeMap = clusterHashing.serviceNodeMap;
        clusterHashing.stop();
        const result2: IServiceNodeMap = (await cluster.query(`SELECT FN_GetServiceNodeMapping();`))[0]["FN_GetServiceNodeMapping()"] as IServiceNodeMap;

        cluster.disconnect();
        await expect(result1).toStrictEqual(result2);
    })

    it("check for creating node", async () => {
        await cluster.connect();
        await cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [100, 'test', `192.167.100.1`, 3306]);
        const result = (await cluster.query(`SELECT node_name FROM \`mysql-dynamic-cluster\`.node WHERE node_id = 100;`))[0].node_name;
        await cluster.query(`CALL SP_RemoveNode( ? );`, [100]);
        cluster.disconnect();

        expect(result).toBe('test');
    })

    // it("check update data for hashing", async () => {
    //     await cluster.connect();
    //     const nodeRand: number = Math.floor(Math.random() * 10 + 100);
    //     const serviceID: number = 100;
    //     console.log("Node: " + nodeRand);
    //     console.log("Service ID: " + serviceID);
    //
    //     const clusterHashing = new ClusterHashing(cluster);
    //     await cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [nodeRand, 'test', `192.167.${nodeRand}.1`, 3306]);
    //
    //     const resultBefore: ServiceNodeMap = (await cluster.query(`SELECT FN_GetServiceNodeMapping();`))[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;
    //     clusterHashing.updateServiceForNode(serviceID, nodeRand);
    //     const resultAfter: ServiceNodeMap = (await cluster.query(`SELECT FN_GetServiceNodeMapping();`))[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;
    //     clusterHashing.stop();
    //     await cluster.query(`CALL SP_RemoveService( ? );`, [serviceID]);
    //     await cluster.query(`CALL SP_RemoveNode( ? );`, [nodeRand]);
    //     cluster.disconnect();
    //
    //     const result: ServiceNodeMap = {
    //         ...resultBefore,
    //         [serviceID.toString()]: nodeRand
    //     }
    //
    //     console.log("Was before:", resultBefore);
    //     console.log("Should be:", result);
    //     console.log("Updated data: ", resultAfter);
    //     await expect(resultAfter).toStrictEqual(result);
    // })
})
