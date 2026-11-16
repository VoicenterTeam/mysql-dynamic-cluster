import { Timer } from '../../src/utils/Timer';

describe('Timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('runs the callback once after the time', () => {
        const callback = jest.fn();
        const timer = new Timer(callback);
        timer.start(30);
        jest.advanceTimersByTime(29);
        expect(callback).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(callback).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(100);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('a second start replaces the first, so one run is pending', () => {
        const callback = jest.fn();
        const timer = new Timer(callback);
        timer.start(30);
        timer.start(50);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(49);
        expect(callback).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('dispose clears the pending run and makes start do nothing', () => {
        const callback = jest.fn();
        const timer = new Timer(callback);
        timer.start(30);
        timer.dispose();
        expect(timer.active).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
        timer.start(30);
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(100);
        expect(callback).not.toHaveBeenCalled();
    });

    it('activate lets start work again after dispose, and starts nothing itself', () => {
        const callback = jest.fn();
        const timer = new Timer(callback);
        timer.dispose();
        timer.activate();
        expect(timer.active).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        timer.start(30);
        jest.advanceTimersByTime(30);
        expect(callback).toHaveBeenCalledTimes(1);
    });
});
