import { BackendPostgres } from "openworkflow/postgres";
import { OpenWorkflow } from "openworkflow";

export const backend = await BackendPostgres.connect(process.env["DATABASE_URL"]!);
export const ow = new OpenWorkflow({ backend });
