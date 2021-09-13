import { GlobalStatusResult, LoadFactorParams } from "../types/PoolInterfaces";
import { Logger } from "../utils/Logger";

export class LoadFactor {
    private _loadFactors: LoadFactorParams[];

    constructor(loadFactors: LoadFactorParams[]) {
        this._loadFactors = loadFactors;
    }

    public check(result: GlobalStatusResult[]): number {
        let score = 0;
        this._loadFactors.forEach(loadFactor => {
            const value = result.find(res => res.Variable_name === loadFactor.key).Value;
            if (isNaN(+value) || !value) {
                Logger("Error: value from db isn't number. Check if you set right key. Current key: " + loadFactor.key)
            } else {
                score += +value * loadFactor.multiplier;
            }
        })

        return score;
    }
}
