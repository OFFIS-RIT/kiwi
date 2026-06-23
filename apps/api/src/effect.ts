import { AiClientFactory, AiClientFactoryLive } from "@kiwi/ai";
import { AiModelRegistry, makeAiModelRegistryLayer } from "@kiwi/ai/models";
import { Database, DatabaseLayer } from "@kiwi/db/effect";
import { FileStorage, FileStorageLive } from "@kiwi/files";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkerEta, WorkerEtaLive } from "./lib/worker-eta";
import { env } from "./env";

const AiModelRegistryLayer = makeAiModelRegistryLayer(env.AUTH_SECRET).pipe(Layer.provideMerge(DatabaseLayer));

export const ApiLayer = Layer.mergeAll(AiModelRegistryLayer, FileStorageLive, AiClientFactoryLive, WorkerEtaLive);

export type ApiServices = Database | FileStorage | AiModelRegistry | AiClientFactory | WorkerEta;

export function runApiEffect<T, E>(effect: Effect.Effect<T, E, ApiServices>): Promise<T> {
    return Effect.runPromise(Effect.provide(effect, ApiLayer));
}
