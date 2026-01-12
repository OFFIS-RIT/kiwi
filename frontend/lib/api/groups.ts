/**
 * Groups API functions for managing groups and their users.
 * @module api/groups
 */

import type { ApiGroup, ApiGroupUser, ApiGroupWithProjects } from "@/types/api";
import { apiClient } from "./client";

/**
 * Fetches all groups the current user has access to.
 */
export async function fetchGroups(): Promise<ApiGroup[]> {
  return apiClient.get<ApiGroup[]>("/groups");
}

/**
 * Fetches all groups with their nested projects.
 */
export async function fetchProjects(): Promise<ApiGroupWithProjects[]> {
  return apiClient.get<ApiGroupWithProjects[]>("/projects");
}

/**
 * Creates a new group with a default admin user.
 * @param name - Group name
 */
export async function createGroup(name: string) {
  return apiClient.post("/groups", {
    name,
    users: [{ user_id: 12, role: "admin" }],
  });
}

/**
 * Updates a group's name and user assignments.
 * @param groupId - Group to update
 * @param name - New group name
 * @param users - Updated list of users with roles
 */
export async function updateGroup(
  groupId: string,
  name: string,
  users: { user_id: number; role: string }[]
) {
  return apiClient.patch(`/groups/${groupId}`, { name, users });
}

/**
 * Deletes a group and all its projects.
 * @param groupId - Group to delete
 */
export async function deleteGroup(groupId: string) {
  return apiClient.delete(`/groups/${groupId}`);
}

/**
 * Fetches all users belonging to a group.
 * @param groupId - Group to fetch users from
 */
export async function fetchGroupUsers(
  groupId: string
): Promise<ApiGroupUser[]> {
  return apiClient.get<ApiGroupUser[]>(`/groups/${groupId}/users`);
}
