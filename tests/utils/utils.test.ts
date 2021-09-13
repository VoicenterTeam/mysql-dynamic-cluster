import { Timer } from "../../src/utils/Timer";
import {Utils} from "../../src/utils/Utils";

test("Timer", async (done) => {
    let count = 0;
    const timer = new Timer(() => {
        count++;
        console.log("Count")
        timer.start(30)
    });
    timer.start(30);
    const utils = new Utils();

    await utils.sleep(35 * 4);
    timer.dispose();
    expect(count).toBe(3);
    done();
})
