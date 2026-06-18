/**
 * Created by Bohdan on Sep, 2021
 */

import { Timer } from "../../src/utils/Timer";
import { Utils } from "../../src/utils/Utils";

test("Timer async", () => {
    jest.useFakeTimers();
    try {
        let count = 0;
        const timer = new Timer(() => {
            count++;
            timer.start(30);
        })
        timer.start(30);
        // Deterministically fire 3 reschedules: ticks land at t=30, 60, 90.
        jest.advanceTimersByTime(90);
        timer.dispose();

        expect(count).toBe(3);
    } finally {
        jest.useRealTimers();
    }
})

test("Clamp", () => {
    expect.assertions(3);
    expect(Utils.clamp(-1, 0, 2)).toBe(0);
    expect(Utils.clamp(3, 0, 2)).toBe(2);
    expect(Utils.clamp(1, 0, 2)).toBe(1);
})
