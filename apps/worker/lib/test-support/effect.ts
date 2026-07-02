import {
    AiClientFactory,
    AiClientFactoryLive,
    type AiClientFactoryService,
} from "@kiwi/ai";
import {
    AiModelRegistry,
    makeAiModelRegistryLayer,
    type AiModelRegistryService,
} from "@kiwi/ai/models";
import { Database, type EffectDatabase } from "@kiwi/db/effect";
import {
    FileStorage,
    StorageError,
    type FileStorageGetFile,
    type FileStorageService,
} from "@kiwi/files";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type TestDatabaseService = Partial<EffectDatabase> & {
    readonly select?: (...args: readonly unknown[]) => unknown;
};

type TestTextGetFile = (
    key: string,
    bucket: string,
    type: "text"
) => Effect.Effect<{ type: "text"; content: string } | null, StorageError>;
type TestJsonGetFile = <T = unknown>(
    key: string,
    bucket: string,
    type: "json"
) => Effect.Effect<{ type: "json"; content: T } | null, StorageError>;
type TestFileStorageService = Partial<Omit<FileStorageService, "getFile">> & {
    readonly getFile?: FileStorageGetFile | TestTextGetFile | TestJsonGetFile;
};

function missingStorageMethod(method: string): Effect.Effect<never, StorageError> {
    return Effect.fail(new StorageError(method));
}

function missingGetFile(key: string, bucket: string): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
function missingGetFile(
    key: string,
    bucket: string,
    type: "bytes"
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
function missingGetFile(
    key: string,
    bucket: string,
    type: "text"
): Effect.Effect<{ type: "text"; content: string } | null, StorageError>;
function missingGetFile<T = unknown>(
    key: string,
    bucket: string,
    type: "json"
): Effect.Effect<{ type: "json"; content: T } | null, StorageError>;
function missingGetFile(
    _key: string,
    _bucket: string,
    _type: "bytes" | "text" | "json" = "bytes"
): Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, StorageError> {
    return missingStorageMethod("getFile");
}

const defaultFileStorageService: FileStorageService = {
    putFile: () => missingStorageMethod("putFile"),
    putGraphFile: () => missingStorageMethod("putGraphFile"),
    putNamedFile: () => missingStorageMethod("putNamedFile"),
    getFile: missingGetFile as FileStorageGetFile,
    getFileStream: () => missingStorageMethod("getFileStream"),
    getFileArrayBuffer: () => missingStorageMethod("getFileArrayBuffer"),
    getFileMetadata: () => missingStorageMethod("getFileMetadata"),
    deleteFile: () => missingStorageMethod("deleteFile"),
    listFiles: () => missingStorageMethod("listFiles"),
    getPresignedDownloadUrl: () => missingStorageMethod("getPresignedDownloadUrl"),
};

export function makeTestDatabaseLayer(database: TestDatabaseService): Layer.Layer<Database> {
    return Layer.succeed(Database, database as EffectDatabase);
}

export function makeTestFileStorageLayer(overrides: TestFileStorageService): Layer.Layer<FileStorage> {
    const { getFile, ...rest } = overrides;
    return Layer.succeed(FileStorage, {
        ...defaultFileStorageService,
        ...rest,
        ...(getFile ? { getFile: getFile as FileStorageGetFile } : {}),
    });
}

export function makeTestAiModelRegistryLayer(secret: string, databaseLayer: Layer.Layer<Database>): Layer.Layer<AiModelRegistry>;
export function makeTestAiModelRegistryLayer(service: AiModelRegistryService): Layer.Layer<AiModelRegistry>;
export function makeTestAiModelRegistryLayer(
    secretOrService: string | AiModelRegistryService,
    databaseLayer?: Layer.Layer<Database>
): Layer.Layer<AiModelRegistry> {
    if (typeof secretOrService === "string") {
        if (!databaseLayer) {
            throw new Error("makeTestAiModelRegistryLayer requires a database layer when given a secret");
        }

        return makeAiModelRegistryLayer(secretOrService).pipe(Layer.provide(databaseLayer));
    }

    return Layer.succeed(AiModelRegistry, secretOrService);
}

export function makeTestAiClientFactoryLayer(service?: AiClientFactoryService): Layer.Layer<AiClientFactory> {
    return service ? Layer.succeed(AiClientFactory, service) : AiClientFactoryLive;
}

export function runTestEffect<T, E, R>(effect: Effect.Effect<T, E, R>, layer: Layer.Layer<R>): Promise<T> {
    return Effect.runPromise(Effect.provide(effect, layer));
}
