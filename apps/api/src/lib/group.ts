import z from "zod";

export const groupUserRoleSchema = z.enum(["admin", "user", "moderator"]);
