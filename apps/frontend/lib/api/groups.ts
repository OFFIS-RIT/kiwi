/**
 * Groups API functions for managing groups and their users.
 * @module api/groups
 */

import type {
    GroupCreateResponse,
    GroupCreateSuccessData,
    GroupDeleteResponse,
    GroupDeleteSuccessData,
    GraphListResponse,
    GroupUsersResponse,
    GroupPatchResponse,
    GroupPatchSuccessData,
    GroupListResponse,
} from "@kiwi/api/types";
import type { ApiGraph, ApiGroup, ApiGroupUser } from "@/types/api";
import { unwrapApiResponse, type KiwiApiClient } from "./client";

/**
 * Fetches all groups the current user has access to.
 */
export async function fetchGroups(client: KiwiApiClient): Promise<ApiGroup[]> {
    const response = await client.get<GroupListResponse>("/groups");

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
 * Creates a new group with a default admin user.
 * @param name - Group name
 */
export async function createGroup(client: KiwiApiClient, name: string): Promise<GroupCreateSuccessData> {
    const response = await client.post<GroupCreateResponse>("/groups", {
        name,
    });

    return unwrapApiResponse(response);
}

/**
 * Updates a group's name and user assignments.
 * @param groupId - Group to update
 * @param name - New group name
 * @param users - Updated list of users with roles
 */
export async function updateGroup(
    client: KiwiApiClient,
    groupId: string,
    name: string,
    users: { user_id: string; role: string }[]
): Promise<GroupPatchSuccessData> {
    const response = await client.patch<GroupPatchResponse>(`/groups/${groupId}`, { name, users });

    return unwrapApiResponse(response);
}

/**
 * Deletes a group and all its projects.
 * @param groupId - Group to delete
 */
export async function deleteGroup(client: KiwiApiClient, groupId: string): Promise<GroupDeleteSuccessData> {
    const response = await client.delete<GroupDeleteResponse>(`/groups/${groupId}`);

    return unwrapApiResponse(response);
}

/**
 * Fetches all users belonging to a group.
 * @param groupId - Group to fetch users from
 */
export async function fetchGroupUsers(client: KiwiApiClient, groupId: string): Promise<ApiGroupUser[]> {
    const response = await client.get<GroupUsersResponse>(`/groups/${groupId}/users`);

    return unwrapApiResponse(response);
}
