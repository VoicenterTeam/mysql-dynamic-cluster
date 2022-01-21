/**
 * Created by Bohdan on Jan, 2022
 */

import {Redis as RedisLib, Cluster, ValueType, Ok} from "ioredis";
import Logger from "./Logger";
import {RedisSettings} from "../types/SettingsInterfaces";
import { createHash } from "crypto";

class Redis {
	private redis: RedisLib | Cluster;
	private isReady: boolean = false;
	private redisSettings: RedisSettings;

	init(newRedis: RedisLib | Cluster, redisSettings: RedisSettings): void {
		this.redis = newRedis;
		this.redisSettings = redisSettings;
		this.connectEvents();
		Logger.debug("Initialized Redis");
	}

	private clearAll() {
		this.redis.keys(this.redisSettings.keyPrefix + "*").then((keys) => {
			const pipeline = this.redis.pipeline();
			keys.forEach((key) => {
				pipeline.del(key);
			});
			return pipeline.exec();
		});

		Logger.debug("Redis cache cleared related to project");
	}

	private connectEvents() {
		this.redis.on("ready", () => {
			this.isReady = true;
			this.clearAll();
			Logger.info("Redis is ready");
		})
	}

	private isEnabled() {
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

	async set(key: string, value: ValueType): Promise<Ok | null> {
		try {
			key = this.redisSettings.keyPrefix + this.hash(key);
			Logger.debug(`Redis set data by key: ${key}`);
			return this.isEnabled() ? await this.redis.set(key, value) : null;
		} catch (e) {
			Logger.error(e);
		}
	}

	async get(key: string): Promise<string | null> {
		try {
			key = this.redisSettings.keyPrefix + this.hash(key);
			Logger.debug(`Redis get data by key: ${key}`);
			return this.isEnabled() ? await this.redis.get(key) : null;
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
