/**
 * Created by Bohdan on Sep, 2021
 */

import dotenv from "dotenv";
import galeraCluster from "../../index";
import { ClusterHashing } from "../../src/cluster/ClusterHashing";
import { ServiceNodeMap } from "../../src/types/PoolInterfaces";

describe("Cluster hashing", () => {
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
        const functionNames: string[] = ["FN_GetServiceNodeMapping"];
        const proceduresNames: string[] = ["SP_NodeInsert", "SP_NodeServiceUpdate", "SP_RemoveNode", "SP_RemoveService"];
        let correctProcFunc: number = 0;
        await cluster.connect();

        const clusterHashing = new ClusterHashing(cluster, null, database);
        await clusterHashing.connect();

        const resultFunc: any[] = await cluster.query(`show function status WHERE Db like '${database}';`);
        const resultProc: any[] = await cluster.query(`show procedure status WHERE Db like '${database}';`);
        resultFunc.forEach(elem => {
            if (functionNames.includes(elem.Name)) correctProcFunc++;
        })
        resultProc.forEach(elem => {
            if (proceduresNames.includes(elem.Name)) correctProcFunc++;
        })
        await cluster.query(`DROP SCHEMA IF EXISTS \`${database}\`;`);

        clusterHashing.stop();
        cluster.disconnect();
        await expect(correctProcFunc).toBe(functionNames.length + proceduresNames.length);
    })

    it("check value from hashing", async () => {
        await cluster.connect();

        const clusterHashing = new ClusterHashing(cluster);
        await clusterHashing.checkHashing();
        const result1: ServiceNodeMap = clusterHashing.serviceNodeMap;
        clusterHashing.stop();
        const result2: ServiceNodeMap = (await cluster.query(`SELECT FN_GetServiceNodeMapping();`))[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;

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
