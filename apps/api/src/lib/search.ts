import * as Effect from "effect/Effect";
import { roleIncludes } from "@kiwi/auth/permissions";
import { tryDb, type Database, type DatabaseError } from "@kiwi/db/effect";
import { chatTable } from "@kiwi/db/tables/chats";
import { teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import { graphTable } from "@kiwi/db/tables/graph";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth";
import type { ChatLibraryItem, ChatLibrarySuccessData, SearchChatItem, SearchSuccessData } from "../types/routes";
import { requireOrganizationMembership } from "./team/access";

const SEARCH_LIMIT = 8;
const chatGraphTeamTable = alias(teamTable, "chat_graph_team");
const chatTargetTeamTable = alias(teamTable, "chat_target_team");

function escapeLike(value: string) {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function buildSearchScore(column: AnyPgColumn, query: string) {
    const escapedQuery = escapeLike(query);
    const prefixQuery = `${escapedQuery}%`;
    const containsQuery = `%${escapedQuery}%`;

    return sql<number>`
        (
            CASE
                WHEN ${column} ILIKE ${escapedQuery} THEN 3
                WHEN ${column} ILIKE ${prefixQuery} THEN 2
                WHEN ${column} ILIKE ${containsQuery} THEN 1
                ELSE 0
            END
            + greatest(similarity(${column}, ${query}), word_similarity(${query}, ${column}))
        )
    `;
}

function buildSearchWhere(column: AnyPgColumn, query: string) {
    const escapedQuery = escapeLike(query);
    const containsQuery = `%${escapedQuery}%`;

    return sql<boolean>`
        (
            ${column} ILIKE ${containsQuery}
            OR similarity(${column}, ${query}) >= 0.12
            OR word_similarity(${query}, ${column}) >= 0.2
        )
    `;
}

function buildGraphScope() {
    return sql<"organization" | "team" | "private">`
        CASE
            WHEN ${graphTable.userId} IS NOT NULL THEN 'private'
            WHEN ${graphTable.teamId} IS NOT NULL THEN 'team'
            ELSE 'organization'
        END
    `;
}

function buildChatScope() {
    return sql<"organization" | "team" | "private">`
        CASE
            -- Team chats have no joined graph row, so this discriminator must stay before graph-derived branches.
            WHEN ${chatTable.scope} = 'team' THEN 'team'
            WHEN ${graphTable.userId} IS NOT NULL THEN 'private'
            WHEN ${graphTable.teamId} IS NOT NULL THEN 'team'
            ELSE 'organization'
        END
    `;
}

function buildChatTeamId() {
    return sql<string | null>`
        CASE
            WHEN ${chatTable.scope} = 'team' THEN ${chatTable.teamId}
            ELSE ${graphTable.teamId}
        END
    `;
}

function buildChatTeamName(graphTeamNameColumn: AnyPgColumn, chatTeamNameColumn: AnyPgColumn) {
    return sql<string | null>`
        CASE
            WHEN ${chatTable.scope} = 'team' THEN ${chatTeamNameColumn}
            ELSE ${graphTeamNameColumn}
        END
    `;
}

function buildAccessibleGraphWhere(
    userId: string,
    organizationId: string,
    accessibleTeamIds: string[],
    organizationAdmin: boolean
): SQL {
    if (organizationAdmin) {
        return or(eq(graphTable.organizationId, organizationId), eq(graphTable.userId, userId)) ?? sql<boolean>`false`;
    }

    const teamAccess =
        accessibleTeamIds.length > 0
            ? and(eq(graphTable.organizationId, organizationId), inArray(graphTable.teamId, accessibleTeamIds))
            : undefined;

    return (
        or(
            eq(graphTable.userId, userId),
            and(eq(graphTable.organizationId, organizationId), isNull(graphTable.teamId)),
            ...(teamAccess ? [teamAccess] : [])
        ) ?? sql<boolean>`false`
    );
}

function buildAccessibleTeamChatWhere(
    organizationId: string,
    accessibleTeamIds: string[],
    organizationAdmin: boolean,
    teamIdColumn: AnyPgColumn,
    teamOrganizationIdColumn: AnyPgColumn
): SQL | undefined {
    if (organizationAdmin) {
        return eq(teamOrganizationIdColumn, organizationId);
    }

    if (accessibleTeamIds.length === 0) {
        // Non-admins only search team chats for teams they can still access.
        return undefined;
    }

    return and(eq(teamOrganizationIdColumn, organizationId), inArray(teamIdColumn, accessibleTeamIds));
}

function buildAccessibleChatWhere(accessibleGraphWhere: SQL, accessibleTeamChatWhere: SQL | undefined): SQL {
    // Graph chats are only searchable while their graph row still exists and is accessible.
    const graphChatWhere =
        and(
            eq(chatTable.scope, "graph"),
            isNotNull(chatTable.graphId),
            isNull(chatTable.teamId),
            isNull(graphTable.graphId),
            eq(graphTable.hidden, false),
            accessibleGraphWhere
        ) ?? sql<boolean>`false`;
    const teamChatWhere = accessibleTeamChatWhere
        ? (and(
              eq(chatTable.scope, "team"),
              isNull(chatTable.graphId),
              isNotNull(chatTable.teamId),
              accessibleTeamChatWhere
          ) ?? sql<boolean>`false`)
        : undefined;

    return or(graphChatWhere, ...(teamChatWhere ? [teamChatWhere] : [])) ?? sql<boolean>`false`;
}

type ChatResultRow = {
    id: string;
    title: string;
    isPinned: boolean;
    targetType: "graph" | "team";
    projectId: string | null;
    projectName: string | null;
    scope: "organization" | "team" | "private";
    teamId: string | null;
    teamName: string | null;
};

function toSearchChatItem(row: ChatResultRow): SearchChatItem | null {
    if (row.targetType === "team") {
        if (!row.teamId || !row.teamName) {
            return null;
        }

        return {
            id: row.id,
            title: row.title,
            isPinned: row.isPinned,
            targetType: "team",
            projectId: null,
            projectName: null,
            scope: "team",
            teamId: row.teamId,
            teamName: row.teamName,
        };
    }

    if (!row.projectId || !row.projectName) {
        return null;
    }

    return {
        id: row.id,
        title: row.title,
        isPinned: row.isPinned,
        targetType: "graph",
        projectId: row.projectId,
        projectName: row.projectName,
        scope: row.scope,
        teamId: row.teamId,
        teamName: row.teamName,
    };
}

function toChatLibraryItem(row: ChatResultRow & { updatedAt: Date | null }): ChatLibraryItem | null {
    const chat = toSearchChatItem(row);
    if (!chat) {
        return null;
    }

    return {
        ...chat,
        updatedAt: row.updatedAt?.toISOString() ?? null,
    };
}

function listAccessibleTeamIds(
    userId: string,
    organizationId: string
): Effect.Effect<string[], DatabaseError, Database> {
    return Effect.map(
        tryDb((db) =>
            db
                .select({ teamId: teamMemberTable.teamId })
                .from(teamMemberTable)
                .innerJoin(teamTable, eq(teamTable.id, teamMemberTable.teamId))
                .where(and(eq(teamMemberTable.userId, userId), eq(teamTable.organizationId, organizationId)))
        ),
        (rows) => rows.map((row) => row.teamId)
    );
}

export function searchWorkspace(user: AuthUser, rawQuery: string): Effect.Effect<SearchSuccessData, unknown, Database> {
    return Effect.gen(function* () {
        const query = rawQuery.trim();
        if (query.length < 2) {
            return {
                projects: [],
                teams: [],
                chats: [],
            };
        }

        const membership = yield* requireOrganizationMembership(user);
        const organizationId = membership.organizationId;
        const organizationAdmin = roleIncludes(membership.role, "admin");
        const accessibleTeamIds = organizationAdmin ? [] : yield* listAccessibleTeamIds(user.id, organizationId);
        const accessibleGraphWhere = buildAccessibleGraphWhere(
            user.id,
            organizationId,
            accessibleTeamIds,
            organizationAdmin
        );
        const graphScope = buildGraphScope();
        const chatScope = buildChatScope();
        const chatTeamId = buildChatTeamId();
        const chatTeamName = buildChatTeamName(chatGraphTeamTable.name, chatTargetTeamTable.name);
        const accessibleTeamChatWhere = buildAccessibleTeamChatWhere(
            organizationId,
            accessibleTeamIds,
            organizationAdmin,
            chatTargetTeamTable.id,
            chatTargetTeamTable.organizationId
        );
        const accessibleChatWhere = buildAccessibleChatWhere(accessibleGraphWhere, accessibleTeamChatWhere);
        const projectScore = buildSearchScore(graphTable.name, query);
        const teamScore = buildSearchScore(teamTable.name, query);
        const chatScore = buildSearchScore(chatTable.title, query);

        const [projects, teams, chats] = yield* tryDb((db) =>
            Effect.all(
                [
                    db
                        .select({
                            id: graphTable.id,
                            name: graphTable.name,
                            scope: graphScope,
                            teamId: graphTable.teamId,
                            teamName: teamTable.name,
                            score: projectScore,
                        })
                        .from(graphTable)
                        .leftJoin(teamTable, eq(teamTable.id, graphTable.teamId))
                        .where(
                            and(
                                isNull(graphTable.graphId),
                                eq(graphTable.hidden, false),
                                accessibleGraphWhere,
                                buildSearchWhere(graphTable.name, query)
                            )
                        )
                        .orderBy(desc(projectScore), asc(graphTable.name))
                        .limit(SEARCH_LIMIT),
                    organizationAdmin
                        ? db
                              .select({
                                  id: teamTable.id,
                                  name: teamTable.name,
                                  score: teamScore,
                              })
                              .from(teamTable)
                              .where(
                                  and(
                                      eq(teamTable.organizationId, organizationId),
                                      buildSearchWhere(teamTable.name, query)
                                  )
                              )
                              .orderBy(desc(teamScore), asc(teamTable.name))
                              .limit(SEARCH_LIMIT)
                        : accessibleTeamIds.length > 0
                          ? db
                                .select({
                                    id: teamTable.id,
                                    name: teamTable.name,
                                    score: teamScore,
                                })
                                .from(teamTable)
                                .where(
                                    and(
                                        eq(teamTable.organizationId, organizationId),
                                        inArray(teamTable.id, accessibleTeamIds),
                                        buildSearchWhere(teamTable.name, query)
                                    )
                                )
                                .orderBy(desc(teamScore), asc(teamTable.name))
                                .limit(SEARCH_LIMIT)
                          : Effect.succeed([]),
                    db
                        .select({
                            id: chatTable.id,
                            title: chatTable.title,
                            isPinned: sql<boolean>`${chatTable.pinnedAt} IS NOT NULL`,
                            targetType: chatTable.scope,
                            projectId: graphTable.id,
                            projectName: graphTable.name,
                            scope: chatScope,
                            teamId: chatTeamId,
                            teamName: chatTeamName,
                            score: chatScore,
                            updatedAt: chatTable.updatedAt,
                        })
                        .from(chatTable)
                        .leftJoin(graphTable, eq(graphTable.id, chatTable.graphId))
                        .leftJoin(chatGraphTeamTable, eq(chatGraphTeamTable.id, graphTable.teamId))
                        .leftJoin(chatTargetTeamTable, eq(chatTargetTeamTable.id, chatTable.teamId))
                        .where(
                            and(
                                eq(chatTable.userId, user.id),
                                isNull(chatTable.archivedAt),
                                accessibleChatWhere,
                                buildSearchWhere(chatTable.title, query)
                            )
                        )
                        .orderBy(
                            desc(chatScore),
                            sql`case when ${chatTable.pinnedAt} is null then 1 else 0 end`,
                            desc(chatTable.updatedAt),
                            asc(chatTable.title)
                        )
                        .limit(SEARCH_LIMIT),
                ],
                { concurrency: "unbounded" }
            )
        );

        return {
            projects: projects.map(({ score: _score, ...project }) => project),
            teams: teams.map(({ score: _score, ...team }) => team),
            chats: chats.flatMap(({ score: _score, updatedAt: _updatedAt, ...chat }) => {
                const item = toSearchChatItem(chat);
                return item ? [item] : [];
            }),
        };
    });
}

function listAccessibleChats(
    user: AuthUser,
    options: { filter: SQL; orderBy: SQL[]; offset?: number; limit?: number }
): Effect.Effect<ChatLibrarySuccessData, unknown, Database> {
    return Effect.gen(function* () {
        const membership = yield* requireOrganizationMembership(user);
        const organizationId = membership.organizationId;
        const organizationAdmin = roleIncludes(membership.role, "admin");
        const accessibleTeamIds = organizationAdmin ? [] : yield* listAccessibleTeamIds(user.id, organizationId);
        const accessibleGraphWhere = buildAccessibleGraphWhere(
            user.id,
            organizationId,
            accessibleTeamIds,
            organizationAdmin
        );
        const chatScope = buildChatScope();
        const chatTeamId = buildChatTeamId();
        const chatTeamName = buildChatTeamName(chatGraphTeamTable.name, chatTargetTeamTable.name);
        const accessibleTeamChatWhere = buildAccessibleTeamChatWhere(
            organizationId,
            accessibleTeamIds,
            organizationAdmin,
            chatTargetTeamTable.id,
            chatTargetTeamTable.organizationId
        );
        const accessibleChatWhere = buildAccessibleChatWhere(accessibleGraphWhere, accessibleTeamChatWhere);

        const effectiveLimit = typeof options.limit === "number" && options.limit > 0 ? options.limit + 1 : undefined;

        const rows = yield* tryDb((db) => {
            const baseQuery = db
                .select({
                    id: chatTable.id,
                    title: chatTable.title,
                    isPinned: sql<boolean>`${chatTable.pinnedAt} IS NOT NULL`,
                    targetType: chatTable.scope,
                    projectId: graphTable.id,
                    projectName: graphTable.name,
                    scope: chatScope,
                    teamId: chatTeamId,
                    teamName: chatTeamName,
                    updatedAt: chatTable.updatedAt,
                })
                .from(chatTable)
                .leftJoin(graphTable, eq(graphTable.id, chatTable.graphId))
                .leftJoin(chatGraphTeamTable, eq(chatGraphTeamTable.id, graphTable.teamId))
                .leftJoin(chatTargetTeamTable, eq(chatTargetTeamTable.id, chatTable.teamId))
                .where(and(eq(chatTable.userId, user.id), accessibleChatWhere, options.filter))
                .orderBy(...options.orderBy);

            return typeof effectiveLimit === "number"
                ? typeof options.offset === "number" && options.offset > 0
                    ? baseQuery.limit(effectiveLimit).offset(options.offset)
                    : baseQuery.limit(effectiveLimit)
                : typeof options.offset === "number" && options.offset > 0
                  ? baseQuery.offset(options.offset)
                  : baseQuery;
        });

        const hasMore = typeof options.limit === "number" && options.limit > 0 ? rows.length > options.limit : false;
        const items = (hasMore ? rows.slice(0, options.limit) : rows).flatMap((row) => {
            const item = toChatLibraryItem(row);
            return item ? [item] : [];
        });

        return { items, hasMore };
    });
}

export function listPinnedChats(user: AuthUser): Effect.Effect<ChatLibrarySuccessData, unknown, Database> {
    return listAccessibleChats(user, {
        filter: and(isNotNull(chatTable.pinnedAt), isNull(chatTable.archivedAt))!,
        orderBy: [desc(chatTable.pinnedAt), desc(chatTable.updatedAt), asc(chatTable.title)],
    });
}

export function listArchivedChats(
    user: AuthUser,
    options: { offset?: number; limit?: number } = {}
): Effect.Effect<ChatLibrarySuccessData, unknown, Database> {
    return listAccessibleChats(user, {
        filter: isNotNull(chatTable.archivedAt),
        orderBy: [desc(chatTable.archivedAt), desc(chatTable.updatedAt), asc(chatTable.title)],
        offset: options.offset,
        limit: options.limit,
    });
}
