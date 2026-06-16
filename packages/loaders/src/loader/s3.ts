import { getFile } from "@kiwi/files";
import * as Effect from "effect/Effect";
import type { GraphLoader } from "../types";

export class S3Loader implements GraphLoader {
    constructor(
        private key: string,
        private bucket: string
    ) {}

    async getText(): Promise<string> {
        const body = await Effect.runPromise(getFile(this.key, this.bucket, "text"));
        if (!body) {
            throw new Error(`Failed to load file ${this.key} from bucket ${this.bucket}`);
        }

        return body ? body.content : "";
    }

    async getBinary(): Promise<ArrayBuffer> {
        const body = await Effect.runPromise(getFile(this.key, this.bucket, "bytes"));
        if (!body) {
            throw new Error(`Failed to load file ${this.key} from bucket ${this.bucket}`);
        }
        return body.content;
    }
}
