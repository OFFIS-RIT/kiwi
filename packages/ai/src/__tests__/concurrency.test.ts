import { describe, expect, test } from "bun:test";

import { configureAIConcurrency, withAiSlot } from "../concurrency";

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;

    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });

    return { promise, resolve };
}

describe("withAiSlot", () => {
    test("limits concurrent work per capability", async () => {
        configureAIConcurrency({ image: 2 });

        const release = createDeferred<void>();
        const firstStarted = createDeferred<void>();
        const secondStarted = createDeferred<void>();
        let thirdStarted = false;
        let active = 0;
        let maxActive = 0;

        const work = [
            withAiSlot("image", async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                firstStarted.resolve();
                await release.promise;
                active -= 1;
            }),
            withAiSlot("image", async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                secondStarted.resolve();
                await release.promise;
                active -= 1;
            }),
            withAiSlot("image", async () => {
                thirdStarted = true;
                active += 1;
                maxActive = Math.max(maxActive, active);
                active -= 1;
            }),
        ];

        await Promise.all([firstStarted.promise, secondStarted.promise]);
        await Promise.resolve();

        expect(thirdStarted).toBe(false);

        release.resolve();
        await Promise.all(work);

        expect(maxActive).toBe(2);
    });

    test("releases slots after failures", async () => {
        configureAIConcurrency({ text: 1 });

        const error = new Error("boom");
        const firstStarted = createDeferred<void>();
        const releaseFirst = createDeferred<void>();
        let secondStarted = false;

        const first = withAiSlot("text", async () => {
            firstStarted.resolve();
            await releaseFirst.promise;
            throw error;
        });

        const second = withAiSlot("text", async () => {
            secondStarted = true;
            return "ok";
        });

        await firstStarted.promise;
        await Promise.resolve();

        expect(secondStarted).toBe(false);

        releaseFirst.resolve();

        await expect(Promise.allSettled([first, second])).resolves.toEqual([
            {
                status: "rejected",
                reason: expect.any(Error),
            },
            {
                status: "fulfilled",
                value: "ok",
            },
        ]);
        expect(secondStarted).toBe(true);
    });

    test("keeps capability slots isolated", async () => {
        configureAIConcurrency({ audio: 1, video: 1 });

        const releaseAudio = createDeferred<void>();
        const releaseVideo = createDeferred<void>();
        const firstAudioStarted = createDeferred<void>();
        const videoStarted = createDeferred<void>();
        let secondAudioStarted = false;

        const firstAudio = withAiSlot("audio", async () => {
            firstAudioStarted.resolve();
            await releaseAudio.promise;
        });

        const secondAudio = withAiSlot("audio", async () => {
            secondAudioStarted = true;
        });

        const video = withAiSlot("video", async () => {
            videoStarted.resolve();
            await releaseVideo.promise;
        });

        await Promise.all([firstAudioStarted.promise, videoStarted.promise]);
        await Promise.resolve();

        expect(secondAudioStarted).toBe(false);

        releaseVideo.resolve();
        releaseAudio.resolve();

        await Promise.all([firstAudio, secondAudio, video]);

        expect(secondAudioStarted).toBe(true);
    });
});
