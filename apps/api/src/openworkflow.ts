import { OpenWorkflow } from "openworkflow";
import { BackendPostgres } from "openworkflow/postgres";
import { env } from "./env";

export const backend = await BackendPostgres.connect(env.DATABASE_DIRECT_URL);
export const ow = new OpenWorkflow({ backend });
