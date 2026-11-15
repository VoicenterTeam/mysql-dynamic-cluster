import { parseSettings } from './schema';
import Logger from '../utils/Logger';
import { IParsedSettings } from '../types/SettingsInterfaces';

/**
 * Settings of the cluster in this process. They come only from what the app passes to
 * createPoolCluster: the library reads no environment variable, no .env file and no config file
 */
class Config {
    private _current: IParsedSettings;
    private _loaded: boolean = false;

    /**
     * Validated settings. The defaults until createPoolCluster loads the settings of the app
     */
    public get current(): IParsedSettings {
        if (!this._current) this._current = parseSettings({});
        return this._current;
    }

    /**
     * @param settings validated settings
     */
    public load(settings: IParsedSettings): void {
        if (this._loaded) {
            Logger.warn("createPoolCluster was called again: " +
                "the settings of the earlier cluster are replaced");
        }
        this._loaded = true;
        this._current = settings;
    }
}

export default new Config();
