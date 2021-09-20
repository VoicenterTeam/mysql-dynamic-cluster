/**
 * Created by Bohdan on Sep, 2021
 */

import { Timer } from "../../src/utils/Timer";
import { Utils } from "../../src/utils/Utils";

test("Timer async", async () => {
    let count = 0;
    const timer = new Timer(() => {
        console.log("Count");
        count++;
        timer.start(30);
    })
    timer.start(30);
    await new Utils().sleep(35 * 4);
    timer.dispose();

    await expect(count).toBe(3);
})

test("Clamp", () => {
    expect.assertions(3);
    expect(Utils.clamp(-1, 0, 2)).toBe(0);
    expect(Utils.clamp(3, 0, 2)).toBe(2);
    expect(Utils.clamp(1, 0, 2)).toBe(1);
})
