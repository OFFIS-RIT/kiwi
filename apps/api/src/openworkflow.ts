import { OpenWorkflow } from "openworkflow";
import { BackendPostgres } from "openworkflow/postgres";
import { env } from "./env";

export const backend = await BackendPostgres.connect(env.OPENWORKFLOW_POSTGRES_URL);
export const ow = new OpenWorkflow({ backend });
