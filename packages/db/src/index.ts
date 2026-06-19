import { drizzle } from "drizzle-orm/node-postgres";

// Better Auth's Drizzle adapter expects promise-based queries until it supports Effect.
export const betterAuthDb = drizzle(process.env.DATABASE_URL!);
