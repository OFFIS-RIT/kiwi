import { describe, expect, test } from "vitest";
import type { Group } from "@/types";
import {
    canAccessSystemAdmin,
    canChangeTeamAdminRole,
    canCreateAnyProject,
    canCreateOrganizationProject,
    canCreatePersonalProject,
    canCreateProjectInGroup,
    canCreateTeam,
    canDeleteTeam,
    canManageProjectFilesInGroup,
    canManageTeam,
    canMutateProjectInGroup,
    canRemoveTeamMember,
    canRenameTeam,
    canViewProjectFilesInGroup,
} from "./capabilities";

function group(role: Group["role"], scope: Group["scope"] = "team"): Group {
    return {
        id: `${scope}-${role}`,
        name: `${scope} ${role}`,
        role,
        scope,
        projects: [],
    };
}

describe("capabilities", () => {
    test("lets organization admins manage teams and team graphs", () => {
        const adminContext = { isAdmin: true };
        const team = group("member");

        expect(canCreateTeam(adminContext)).toBe(true);
        expect(canManageTeam(team, adminContext)).toBe(true);
        expect(canRenameTeam(team, adminContext)).toBe(true);
        expect(canDeleteTeam(team, adminContext)).toBe(true);
        expect(canChangeTeamAdminRole(team, adminContext)).toBe(true);
        expect(canCreateProjectInGroup(team, adminContext)).toBe(true);
        expect(canMutateProjectInGroup(team, adminContext)).toBe(true);
        expect(canManageProjectFilesInGroup(team, adminContext)).toBe(true);
    });

    test("lets team admins manage members and graphs without team lifecycle access", () => {
        const memberContext = { isAdmin: false };
        const team = group("admin");

        expect(canCreateTeam(memberContext)).toBe(false);
        expect(canManageTeam(team, memberContext)).toBe(true);
        expect(canRemoveTeamMember(team, memberContext)).toBe(true);
        expect(canRenameTeam(team, memberContext)).toBe(false);
        expect(canDeleteTeam(team, memberContext)).toBe(false);
        expect(canChangeTeamAdminRole(team, memberContext)).toBe(false);
        expect(canCreateProjectInGroup(team, memberContext)).toBe(true);
        expect(canMutateProjectInGroup(team, memberContext)).toBe(true);
        expect(canManageProjectFilesInGroup(team, memberContext)).toBe(true);
    });

    test("lets team moderators manage graphs without member access", () => {
        const memberContext = { isAdmin: false };
        const team = group("moderator");

        expect(canManageTeam(team, memberContext)).toBe(false);
        expect(canCreateProjectInGroup(team, memberContext)).toBe(true);
        expect(canMutateProjectInGroup(team, memberContext)).toBe(true);
        expect(canManageProjectFilesInGroup(team, memberContext)).toBe(true);
        expect(canViewProjectFilesInGroup()).toBe(true);
    });

    test("keeps regular members on view-only graph access", () => {
        const memberContext = { isAdmin: false };
        const team = group("member");

        expect(canManageTeam(team, memberContext)).toBe(false);
        expect(canCreateProjectInGroup(team, memberContext)).toBe(false);
        expect(canMutateProjectInGroup(team, memberContext)).toBe(false);
        expect(canManageProjectFilesInGroup(team, memberContext)).toBe(false);
        expect(canViewProjectFilesInGroup()).toBe(true);
    });

    test("lets organization admins manage organization graphs but not personal graphs", () => {
        const adminContext = { isAdmin: true };
        const orgGroup = group("admin", "organization");

        expect(canCreateOrganizationProject(adminContext)).toBe(true);
        expect(canCreatePersonalProject(adminContext)).toBe(false);
        expect(canCreateProjectInGroup(orgGroup, adminContext)).toBe(true);
        expect(canMutateProjectInGroup(orgGroup, adminContext)).toBe(true);
        expect(canManageProjectFilesInGroup(orgGroup, adminContext)).toBe(true);
        expect(canCreateAnyProject([orgGroup], adminContext)).toBe(true);
    });

    test("exposes system administration only to system admins", () => {
        expect(canAccessSystemAdmin({ isSystemAdmin: true })).toBe(true);
        expect(canAccessSystemAdmin({ isSystemAdmin: false })).toBe(false);
    });
});
