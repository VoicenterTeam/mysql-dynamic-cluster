export interface IClusterHashingSettings {
    nextCheckTime?: number,
    dbName?: string
}

export interface IDefaultClusterHashingSettings extends IClusterHashingSettings {
    nextCheckTime: number,
    dbName: string
}
