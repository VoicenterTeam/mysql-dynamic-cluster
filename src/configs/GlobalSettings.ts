/**
 * Created by Bohdan on Sep, 2021
 */
import { DEBUG, GlobalSettings } from "../types/SettingsInterfaces";
import defaultSettings from './DefaultSettings'

const GlobalSettings: GlobalSettings = {
    debug: defaultSettings.debug ? defaultSettings.debug : DEBUG.FULL,
}

export default GlobalSettings;
