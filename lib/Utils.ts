export class Utils {
    public static getRandomInRange(min: number, max: number): number {
        return Math.random() * (max - min) + min;
    }
    public static getRandomIntInRange(min: number, max: number): number {
        return Math.round(Math.random() * (max - min) + min);
    }
}
