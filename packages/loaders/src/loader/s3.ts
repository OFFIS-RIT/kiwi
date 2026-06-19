import { getFile } from "@kiwi/files";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GraphBinaryLoader } from "../types";

export class S3LoaderError extends Schema.TaggedErrorClass<S3LoaderError>()("S3LoaderError", {
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

export class S3Loader implements GraphBinaryLoader {
    constructor(
        private key: string,
        private bucket: string
    ) {}

    getTextEffect(): Effect.Effect<string, S3LoaderError> {
        const { bucket, key } = this;

        return Effect.gen(function* () {
            const body = yield* getFile(key, bucket, "text").pipe(
                Effect.mapError(
                    (cause) => new S3LoaderError({ message: `Failed to load file ${key} from bucket ${bucket}`, cause })
                )
            );
            if (!body) {
                return yield* new S3LoaderError({
                    message: `Failed to load file ${key} from bucket ${bucket}`,
                    cause: "File not found",
                });
            }

            return body.content;
        });
    }

    getText(): Promise<string> {
        return Effect.runPromise(this.getTextEffect());
    }

    getBinaryEffect(): Effect.Effect<ArrayBuffer, S3LoaderError> {
        const { bucket, key } = this;

        return Effect.gen(function* () {
            const body = yield* getFile(key, bucket, "bytes").pipe(
                Effect.mapError(
                    (cause) => new S3LoaderError({ message: `Failed to load file ${key} from bucket ${bucket}`, cause })
                )
            );
            if (!body) {
                return yield* new S3LoaderError({
                    message: `Failed to load file ${key} from bucket ${bucket}`,
                    cause: "File not found",
                });
            }

            return body.content;
        });
    }

    getBinary(): Promise<ArrayBuffer> {
        return Effect.runPromise(this.getBinaryEffect());
    }
}
