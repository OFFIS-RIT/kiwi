import z from "zod";

export const groupUserRoleSchema = z.enum(["admin", "user", "moderator"]);

export type GroupUserRole = z.infer<typeof groupUserRoleSchema>;
type NormalizedGroupUser = {
    userId: string;
    role: GroupUserRole;
};

export const normalizeGroupUsers = (
    users: Array<{ user_id: string; role: GroupUserRole }>,
    excludeUserId?: string
): NormalizedGroupUser[] =>
    Array.from(
        new Map(
            users
                .filter(({ user_id }) => user_id !== excludeUserId)
                .map(({ user_id, role }) => [
                    user_id,
                    {
                        userId: user_id,
                        role,
                    } satisfies NormalizedGroupUser,
                ])
        ).values()
    );
