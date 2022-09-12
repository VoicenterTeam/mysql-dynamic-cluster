/**
 * Created by Bohdan on Jan, 2022
 */

import { Redis as RedisLib, Cluster, ValueType, Ok } from "ioredis";
import Logger from "../utils/Logger";
import { createHash } from "crypto";
import { IRedisSettings } from "../types/RedisInterfaces";

class Redis {
	private redis: RedisLib | Cluster;
	private isReady: boolean = false;
	private redisSettings: IRedisSettings;

	init(newRedis: RedisLib | Cluster, clusterName: string, redisSettings: IRedisSettings): void {

		this.redis = newRedis;
		this.redisSettings = redisSettings;
		this.redisSettings.keyPrefix = `${clusterName}_${this.redisSettings.keyPrefix}`;
		this.connectEvents();
		Logger.debug("Initialized Redis");
	}

	private clearAll(): void {
		this.redis?.keys(this.redisSettings.keyPrefix + "*").then((keys) => {
			const pipeline = this.redis.pipeline();
			keys.forEach((key) => {
				pipeline.del(key);
			});
			return pipeline.exec();
		});

		Logger.debug("Redis cache cleared related to project");
	}

	private connectEvents(): void {
		if(!this.redis) return;
		this.redis?.on("ready", () => {
			this.isReady = true;
			if (this.redisSettings.clearOnStart) this.clearAll();
			Logger.info("Redis is ready");
		})
	}

	private isEnabled(): boolean {
		return this.redis && this.isReady;
	}

	async connect(callback?: () => void): Promise<void> {
		if (this.isEnabled()) return;
		await this.redis?.connect(callback);
		Logger.info("Redis connected");
	}

	disconnect(reconnect?: boolean): void {
		this.redis?.disconnect(reconnect);
		this.isReady = false;
		Logger.info("Redis disconnected");
	}

	async set(key: string, value: ValueType, queryExpire?: number): Promise<Ok | null> {
		if (!this.isEnabled()) return null;
		try {
			const expire: number = queryExpire || this.redisSettings.expire || 100;
			const expireMode: string = this.redisSettings.expiryMode || 'EX';

			key = this.redisSettings.keyPrefix + this.hash(key);
			Logger.debug(`Redis set data by key: ${key}`);
			return await this.redis.set(key, value, expireMode, expire);
		} catch (e) {
			Logger.error(e);
		}
	}

	async get(key: string): Promise<string | null> {
		if (!this.isEnabled()) return null;
		try {
			key = this.redisSettings.keyPrefix + this.hash(key);
			Logger.debug(`Redis get data by key: ${key}`);
			return await this.redis.get(key);
		} catch (e) {
			Logger.error(e);
		}
	}

	hash(data: string): string {
		return createHash(this.redisSettings.algorithm)
			.update(data)
			.digest(this.redisSettings.encoding);
	}
}

export default new Redis();
