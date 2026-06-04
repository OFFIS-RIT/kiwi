import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { chatTable } from "@kiwi/db/tables/chats";
import { teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import { graphTable } from "@kiwi/db/tables/graph";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth";
import type { ChatLibrarySuccessData, SearchSuccessData } from "../types/routes";
import { requireOrganizationMembership } from "./team-access";

const SEARCH_LIMIT = 8;

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

function buildAccessibleGraphWhere(
    userId: string,
    organizationId: string,
    accessibleTeamIds: string[],
    organizationAdmin: boolean
) {
    if (organizationAdmin) {
        return or(eq(graphTable.organizationId, organizationId), eq(graphTable.userId, userId));
    }

    const teamAccess =
        accessibleTeamIds.length > 0
            ? and(eq(graphTable.organizationId, organizationId), inArray(graphTable.teamId, accessibleTeamIds))
            : undefined;

    return or(
        eq(graphTable.userId, userId),
        and(eq(graphTable.organizationId, organizationId), isNull(graphTable.teamId)),
        ...(teamAccess ? [teamAccess] : [])
    );
}

async function listAccessibleTeamIds(userId: string, organizationId: string) {
    const rows = await db
        .select({ teamId: teamMemberTable.teamId })
        .from(teamMemberTable)
        .innerJoin(teamTable, eq(teamTable.id, teamMemberTable.teamId))
        .where(and(eq(teamMemberTable.userId, userId), eq(teamTable.organizationId, organizationId)));

    return rows.map((row) => row.teamId);
}

export async function searchWorkspace(user: AuthUser, rawQuery: string): Promise<SearchSuccessData> {
    const query = rawQuery.trim();
    if (query.length < 2) {
        return {
            projects: [],
            teams: [],
            chats: [],
        };
    }

    const membership = await requireOrganizationMembership(user);
    const organizationId = membership.organizationId;
    const organizationAdmin = roleIncludes(membership.role, "admin");
    const accessibleTeamIds = organizationAdmin ? [] : await listAccessibleTeamIds(user.id, organizationId);
    const accessibleGraphWhere = buildAccessibleGraphWhere(
        user.id,
        organizationId,
        accessibleTeamIds,
        organizationAdmin
    );
    const graphScope = buildGraphScope();
    const projectScore = buildSearchScore(graphTable.name, query);
    const teamScore = buildSearchScore(teamTable.name, query);
    const chatScore = buildSearchScore(chatTable.title, query);

    const [projects, teams, chats] = await Promise.all([
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
                  .where(and(eq(teamTable.organizationId, organizationId), buildSearchWhere(teamTable.name, query)))
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
              : Promise.resolve([]),
        db
            .select({
                id: chatTable.id,
                title: chatTable.title,
                isPinned: sql<boolean>`${chatTable.pinnedAt} IS NOT NULL`,
                projectId: graphTable.id,
                projectName: graphTable.name,
                scope: graphScope,
                teamId: graphTable.teamId,
                teamName: teamTable.name,
                score: chatScore,
                updatedAt: chatTable.updatedAt,
            })
            .from(chatTable)
            .innerJoin(graphTable, eq(graphTable.id, chatTable.graphId))
            .leftJoin(teamTable, eq(teamTable.id, graphTable.teamId))
            .where(
                and(
                    eq(chatTable.userId, user.id),
                    eq(chatTable.scope, "graph"),
                    isNull(chatTable.archivedAt),
                    isNull(graphTable.graphId),
                    eq(graphTable.hidden, false),
                    accessibleGraphWhere,
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
    ]);

    return {
        projects: projects.map(({ score: _score, ...project }) => project),
        teams: teams.map(({ score: _score, ...team }) => team),
        chats: chats.map(({ score: _score, updatedAt: _updatedAt, ...chat }) => chat),
    };
}

async function listAccessibleChats(
    user: AuthUser,
    options: { filter: SQL; orderBy: SQL[]; offset?: number; limit?: number }
): Promise<ChatLibrarySuccessData> {
    const membership = await requireOrganizationMembership(user);
    const organizationId = membership.organizationId;
    const organizationAdmin = roleIncludes(membership.role, "admin");
    const accessibleTeamIds = organizationAdmin ? [] : await listAccessibleTeamIds(user.id, organizationId);
    const accessibleGraphWhere = buildAccessibleGraphWhere(
        user.id,
        organizationId,
        accessibleTeamIds,
        organizationAdmin
    );
    const graphScope = buildGraphScope();

    const baseQuery = db
        .select({
            id: chatTable.id,
            title: chatTable.title,
            isPinned: sql<boolean>`${chatTable.pinnedAt} IS NOT NULL`,
            projectId: graphTable.id,
            projectName: graphTable.name,
            scope: graphScope,
            teamId: graphTable.teamId,
            teamName: teamTable.name,
            updatedAt: chatTable.updatedAt,
        })
        .from(chatTable)
        .innerJoin(graphTable, eq(graphTable.id, chatTable.graphId))
        .leftJoin(teamTable, eq(teamTable.id, graphTable.teamId))
        .where(
            and(
                eq(chatTable.userId, user.id),
                eq(chatTable.scope, "graph"),
                isNull(graphTable.graphId),
                eq(graphTable.hidden, false),
                accessibleGraphWhere,
                options.filter
            )
        )
        .orderBy(...options.orderBy);

    const effectiveLimit = typeof options.limit === "number" && options.limit > 0 ? options.limit + 1 : undefined;

    const rows = await (typeof effectiveLimit === "number"
        ? typeof options.offset === "number" && options.offset > 0
            ? baseQuery.limit(effectiveLimit).offset(options.offset)
            : baseQuery.limit(effectiveLimit)
        : typeof options.offset === "number" && options.offset > 0
          ? baseQuery.offset(options.offset)
          : baseQuery);

    const hasMore = typeof options.limit === "number" && options.limit > 0 ? rows.length > options.limit : false;
    const items = (hasMore ? rows.slice(0, options.limit) : rows).map((row) => ({
        ...row,
        updatedAt: row.updatedAt?.toISOString() ?? null,
    }));

    return { items, hasMore };
}

export async function listPinnedChats(user: AuthUser): Promise<ChatLibrarySuccessData> {
    return listAccessibleChats(user, {
        filter: and(isNotNull(chatTable.pinnedAt), isNull(chatTable.archivedAt))!,
        orderBy: [desc(chatTable.pinnedAt), desc(chatTable.updatedAt), asc(chatTable.title)],
    });
}

export async function listArchivedChats(
    user: AuthUser,
    options: { offset?: number; limit?: number } = {}
): Promise<ChatLibrarySuccessData> {
    return listAccessibleChats(user, {
        filter: isNotNull(chatTable.archivedAt),
        orderBy: [desc(chatTable.archivedAt), desc(chatTable.updatedAt), asc(chatTable.title)],
        offset: options.offset,
        limit: options.limit,
    });
}
