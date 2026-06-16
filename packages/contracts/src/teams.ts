import { Schema } from "effect";
import type { ApiResponse } from "./errors";
import { type MutableSchemaType, NonEmptyTrimmedStringSchema } from "./schema";

export const TEAM_USER_ROLE_VALUES = ["admin", "moderator", "member"] as const;
export const TeamUserRoleSchema = Schema.Literals(TEAM_USER_ROLE_VALUES);
export type TeamUserRole = Schema.Schema.Type<typeof TeamUserRoleSchema>;

export type TeamUserRecord = {
    teamId: string;
    userId: string;
    role: TeamUserRole;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type TeamRecord = {
    id: string;
    name: string;
    organizationId: string;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type TeamListItem = {
    team_id: string;
    team_name: string;
    role: TeamUserRole;
};

export type TeamUserListItem = {
    team_id: string;
    user_id: string;
    user_name: string | null;
    role: TeamUserRole;
    created_at: string | null;
    updated_at: string | null;
};

export type OrganizationMemberListItem = {
    user_id: string;
    user_name: string | null;
    user_email: string;
    role: string;
};

export const TeamUserInputSchema = Schema.Struct({
    user_id: Schema.String,
    role: TeamUserRoleSchema,
});
export type TeamUserInput = MutableSchemaType<Schema.Schema.Type<typeof TeamUserInputSchema>>;

export const TeamCreateInputSchema = Schema.Struct({
    name: NonEmptyTrimmedStringSchema,
    users: Schema.optional(Schema.Array(TeamUserInputSchema)),
});
export type TeamCreateInput = MutableSchemaType<Schema.Schema.Type<typeof TeamCreateInputSchema>>;

export const TeamAddUserInputSchema = Schema.Struct({
    user_id: Schema.String,
    role: Schema.optional(TeamUserRoleSchema),
});
export type TeamAddUserInput = MutableSchemaType<Schema.Schema.Type<typeof TeamAddUserInputSchema>>;

export const TeamUpdateUsersInputSchema = Schema.Struct({
    users: Schema.Array(TeamUserInputSchema),
});
export type TeamUpdateUsersInput = MutableSchemaType<Schema.Schema.Type<typeof TeamUpdateUsersInputSchema>>;

export const TeamPatchInputSchema = Schema.Struct({
    name: Schema.optional(NonEmptyTrimmedStringSchema),
    users: Schema.optional(Schema.Array(TeamUserInputSchema)),
});
export type TeamPatchInput = MutableSchemaType<Schema.Schema.Type<typeof TeamPatchInputSchema>>;

export type DeleteS3Cleanup = {
    attemptedKeyCount: number;
    failedKeyCount: number;
};

export type TeamCreateSuccessData = {
    team: Pick<TeamRecord, "id">;
    users: TeamUserRecord[];
};

export type TeamPatchSuccessData = {
    team: TeamRecord;
    users: TeamUserListItem[];
};

export type TeamDeleteSuccessData = {
    teamId: string;
    deletedGraphCount: number;
    deletedFileCount: number;
    s3Cleanup: DeleteS3Cleanup;
    warnings?: string[];
};

export type TeamCreateResponse = ApiResponse<
    TeamCreateSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_TEAM_MEMBERS" | "INTERNAL_SERVER_ERROR"
>;

export type TeamListResponse = ApiResponse<TeamListItem[], "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

export type TeamUsersResponse = ApiResponse<
    TeamUserListItem[],
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INVALID_TEAM_MEMBERS" | "INTERNAL_SERVER_ERROR"
>;

export type TeamAvailableUsersResponse = ApiResponse<
    OrganizationMemberListItem[],
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPatchResponse = ApiResponse<
    TeamPatchSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INVALID_TEAM_MEMBERS" | "INTERNAL_SERVER_ERROR"
>;

export type TeamDeleteResponse = ApiResponse<
    TeamDeleteSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;
