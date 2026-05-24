/**
 * Team API functions for managing teams and their users.
 * @module api/teams
 */

import type {
    GraphListResponse,
    TeamAvailableUsersResponse,
    TeamCreateResponse,
    TeamCreateSuccessData,
    TeamDeleteResponse,
    TeamDeleteSuccessData,
    TeamListResponse,
    TeamPatchResponse,
    TeamPatchSuccessData,
    TeamUsersResponse,
} from "@kiwi/api/types";
import type { ApiGraph, ApiGroup, ApiGroupUser, ApiOrganizationMember } from "@/types/api";
import { unwrapApiResponse, type KiwiApiClient } from "./client";

/**
 * Fetches all teams the current user has access to.
 */
export async function fetchGroups(client: KiwiApiClient): Promise<ApiGroup[]> {
    const response = await client.get<TeamListResponse>("/teams");

    return unwrapApiResponse(response);
}

/**
 * Fetches all visible top-level graphs the current user has access to.
 */
export async function fetchGraphs(client: KiwiApiClient): Promise<ApiGraph[]> {
    const response = await client.get<GraphListResponse>("/graphs");

    return unwrapApiResponse(response);
}

/**
 * Creates a new team with a default admin user.
 * @param name - Team name
 */
export async function createGroup(client: KiwiApiClient, name: string): Promise<TeamCreateSuccessData> {
    const response = await client.post<TeamCreateResponse>("/teams", {
        name,
    });

    return unwrapApiResponse(response);
}

/**
 * Updates a team's name and user assignments.
 * @param groupId - Team to update
 * @param name - New team name
 * @param users - Updated list of users with roles
 */
export async function updateGroup(
    client: KiwiApiClient,
    groupId: string,
    name: string,
    users: { user_id: string; role: string }[]
): Promise<TeamPatchSuccessData> {
    const response = await client.patch<TeamPatchResponse>(`/teams/${groupId}`, { name, users });

    return unwrapApiResponse(response);
}

export async function updateGroupUsers(
    client: KiwiApiClient,
    groupId: string,
    users: { user_id: string; role: "admin" | "moderator" | "member" }[]
): Promise<ApiGroupUser[]> {
    const response = await client.patch<TeamUsersResponse>(`/teams/${groupId}/users`, { users });

    return unwrapApiResponse(response);
}

/**
 * Deletes a team and all its projects.
 * @param groupId - Team to delete
 */
export async function deleteGroup(client: KiwiApiClient, groupId: string): Promise<TeamDeleteSuccessData> {
    const response = await client.delete<TeamDeleteResponse>(`/teams/${groupId}`);

    return unwrapApiResponse(response);
}

/**
 * Fetches all users belonging to a team.
 * @param groupId - Team to fetch users from
 */
export async function fetchGroupUsers(client: KiwiApiClient, groupId: string): Promise<ApiGroupUser[]> {
    const response = await client.get<TeamUsersResponse>(`/teams/${groupId}/users`);

    return unwrapApiResponse(response);
}

export async function fetchGroupAvailableUsers(
    client: KiwiApiClient,
    groupId: string
): Promise<ApiOrganizationMember[]> {
    const response = await client.get<TeamAvailableUsersResponse>(`/teams/${groupId}/available-users`);

    return unwrapApiResponse(response);
}

export async function addGroupUser(
    client: KiwiApiClient,
    groupId: string,
    userId: string,
    role: "admin" | "moderator" | "member" = "member"
): Promise<ApiGroupUser[]> {
    const response = await client.post<TeamUsersResponse>(`/teams/${groupId}/users`, {
        user_id: userId,
        role,
    });

    return unwrapApiResponse(response);
}

export async function removeGroupUser(
    client: KiwiApiClient,
    groupId: string,
    userId: string
): Promise<ApiGroupUser[]> {
    const response = await client.delete<TeamUsersResponse>(`/teams/${groupId}/users/${userId}`);

    return unwrapApiResponse(response);
}
