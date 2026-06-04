import { and, eq, isNull, type SQL } from "drizzle-orm";
import { chatTable } from "@kiwi/db/tables/chats";

export type GraphChatTarget = {
    scope: "graph";
    graphId: string;
};

export type TeamChatTarget = {
    scope: "team";
    teamId: string;
};

export type ChatTarget = GraphChatTarget | TeamChatTarget;

export type ChatTargetRow = {
    scope: "graph" | "team";
    graphId: string | null;
    teamId: string | null;
};

export function graphChatTarget(graphId: string): GraphChatTarget {
    return { scope: "graph", graphId };
}

export function teamChatTarget(teamId: string): TeamChatTarget {
    return { scope: "team", teamId };
}

export function chatTargetInsertValues(target: ChatTarget) {
    return target.scope === "graph"
        ? {
              scope: target.scope,
              graphId: target.graphId,
              teamId: null,
          }
        : {
              scope: target.scope,
              graphId: null,
              teamId: target.teamId,
          };
}

export function chatTargetWhere(target: ChatTarget): SQL {
    return target.scope === "graph"
        ? and(eq(chatTable.scope, "graph"), eq(chatTable.graphId, target.graphId), isNull(chatTable.teamId))!
        : and(eq(chatTable.scope, "team"), isNull(chatTable.graphId), eq(chatTable.teamId, target.teamId))!;
}

export function chatTargetMatchesRow(row: ChatTargetRow, target: ChatTarget) {
    return target.scope === "graph"
        ? row.scope === "graph" && row.graphId === target.graphId && row.teamId === null
        : row.scope === "team" && row.graphId === null && row.teamId === target.teamId;
}

export function chatTargetLogContext(target: ChatTarget) {
    return target.scope === "graph" ? { graphId: target.graphId } : { teamId: target.teamId };
}
