export interface ClusterHashingSettings {
    nextCheckTime?: number,
    dbName?: string
}

export interface DefaultClusterHashingSettings extends ClusterHashingSettings {
    nextCheckTime: number,
    dbName: string
}
