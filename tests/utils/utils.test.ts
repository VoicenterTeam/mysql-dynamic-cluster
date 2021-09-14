import { Timer } from "../../src/utils/Timer";
import { Utils } from "../../src/utils/Utils";

test("Timer async", async () => {
    let count = 0;
    const timer = new Timer(() => {
        console.log("Count")
        count++;
        timer.start(30);
    })
    timer.start(30);
    await new Utils().sleep(35 * 4);

    await expect(count).toBe(3);
})
