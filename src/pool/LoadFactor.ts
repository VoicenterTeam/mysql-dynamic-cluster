/**
 * Created by Bohdan on Sep, 2021
 */

import { GlobalStatusResult, ILoadFactorParams } from "../types/PoolInterfaces";
import Logger from "../utils/Logger";

/**
 * Load factor for pools to easily sort them
 */
export class LoadFactor {
    private _loadFactors: ILoadFactorParams[];

    /**
     * @param loadFactors parameters by which values pools should sort
     */
    constructor(loadFactors: ILoadFactorParams[]) {
        this._loadFactors = loadFactors;
    }

    /**
     * Update load factors from result of db global status if db has some changes
     * @param result result of db global status
     */
    public check(result: GlobalStatusResult[]): number {
        let score = 0;
        this._loadFactors?.forEach(loadFactor => {
            const value = result.find(res => res.Variable_name === loadFactor.key).Value;
            if (isNaN(+value) || !value) {
                Logger.error("Value from db isn't number. Check if you set right key. Current key: " + loadFactor.key)
            } else {
                score += +value * loadFactor.multiplier;
            }
        })

        return score;
    }
}
