import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { FileStorage, FileStorageLive } from "../index";

const fullConfig = {
    S3_REGION: "us-test-1",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_ACCESS_KEY_ID: "test-access-key-id",
    S3_SECRET_ACCESS_KEY: "test-secret-access-key",
};

function acquireStorage(config: Record<string, string>) {
    const layer = FileStorageLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))));
    return Effect.provide(FileStorage, layer, { local: true });
}

describe("FileStorageLive config", () => {
    test("fails while acquiring the layer when required S3 config is missing", async () => {
        const exit = await Effect.runPromiseExit(acquireStorage({}));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            throw new Error("expected FileStorageLive acquisition to fail without S3 config");
        }

        expect(Cause.hasDies(exit.cause)).toBe(true);
        const failure = Cause.pretty(exit.cause);
        expect(failure).toContain("S3_ACCESS_KEY");
    });

    test("constructs the service from explicit S3 config without contacting S3", async () => {
        const exit = await Effect.runPromiseExit(acquireStorage(fullConfig));

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            throw new Error(Cause.pretty(exit.cause));
        }
    });

    test("accepts the legacy S3_ACCESS_KEY fallback", async () => {
        const exit = await Effect.runPromiseExit(
            acquireStorage({
                S3_REGION: fullConfig.S3_REGION,
                S3_ENDPOINT: fullConfig.S3_ENDPOINT,
                S3_ACCESS_KEY: "legacy-test-access-key",
                S3_SECRET_ACCESS_KEY: fullConfig.S3_SECRET_ACCESS_KEY,
            })
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            throw new Error(Cause.pretty(exit.cause));
        }
    });

    test("does not print provided redacted credentials in config failure output", async () => {
        const secret = "secret-value-that-must-not-leak";
        const accessKey = "access-key-that-must-not-leak";
        const exit = await Effect.runPromiseExit(
            acquireStorage({
                S3_REGION: fullConfig.S3_REGION,
                S3_ACCESS_KEY_ID: accessKey,
                S3_SECRET_ACCESS_KEY: secret,
            })
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            throw new Error("expected FileStorageLive acquisition to fail without S3_ENDPOINT");
        }

        const failure = Cause.pretty(exit.cause);
        expect(failure).toContain("S3_ENDPOINT");
        expect(failure).not.toContain(secret);
        expect(failure).not.toContain(accessKey);
    });
});
