import { describe, expect, test } from "bun:test";

import { configureAIConcurrency, withAiSlot } from "../concurrency";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withAiSlot", () => {
    test("limits concurrent work per capability", async () => {
        configureAIConcurrency({ image: 2 });

        let active = 0;
        let maxActive = 0;

        await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
                withAiSlot("image", async () => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);

                    await sleep(10 + index);

                    active -= 1;
                })
            )
        );

        expect(maxActive).toBe(2);
    });

    test("releases slots after failures", async () => {
        configureAIConcurrency({ text: 1 });

        await expect(
            Promise.allSettled([
                withAiSlot("text", async () => {
                    throw new Error("boom");
                }),
                withAiSlot("text", async () => "ok"),
            ])
        ).resolves.toEqual([
            {
                status: "rejected",
                reason: expect.any(Error),
            },
            {
                status: "fulfilled",
                value: "ok",
            },
        ]);
    });
});
