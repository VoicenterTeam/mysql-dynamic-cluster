export class Utils {
    public static clamp (num, min, max): number {
        return Math.min(Math.max(num, min), max);
    }

    public sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
