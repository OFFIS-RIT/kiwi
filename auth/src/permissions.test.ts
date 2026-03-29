import { describe, expect, test } from "bun:test";
import { ac, admin, manager, user } from "./permissions";

describe("permissions", () => {
  test("ac is defined", () => {
    expect(ac).toBeDefined();
  });

  describe("admin role", () => {
    test("has all project permissions", () => {
      expect(admin.statements.project).toContain("create");
      expect(admin.statements.project).toContain("update");
      expect(admin.statements.project).toContain("delete");
      expect(admin.statements.project).toContain("add:file");
      expect(admin.statements.project).toContain("delete:file");
      expect(admin.statements.project).toContain("list:file");
    });

    test("has all group permissions", () => {
      expect(admin.statements.group).toContain("create");
      expect(admin.statements.group).toContain("update");
      expect(admin.statements.group).toContain("delete");
      expect(admin.statements.group).toContain("view:all");
      expect(admin.statements.group).toContain("view");
      expect(admin.statements.group).toContain("add:user");
      expect(admin.statements.group).toContain("remove:user");
      expect(admin.statements.group).toContain("list:user");
    });

    test("has full user management permissions", () => {
      expect(admin.statements.user).toContain("create");
      expect(admin.statements.user).toContain("list");
      expect(admin.statements.user).toContain("set-role");
      expect(admin.statements.user).toContain("ban");
      expect(admin.statements.user).toContain("impersonate");
      expect(admin.statements.user).toContain("delete");
      expect(admin.statements.user).toContain("set-password");
      expect(admin.statements.user).toContain("get");
      expect(admin.statements.user).toContain("update");
    });

    test("has session management permissions", () => {
      expect(admin.statements.session).toContain("list");
      expect(admin.statements.session).toContain("revoke");
      expect(admin.statements.session).toContain("delete");
    });
  });

  describe("manager role", () => {
    test("has all project permissions", () => {
      expect(manager.statements.project).toContain("create");
      expect(manager.statements.project).toContain("update");
      expect(manager.statements.project).toContain("delete");
      expect(manager.statements.project).toContain("add:file");
      expect(manager.statements.project).toContain("delete:file");
      expect(manager.statements.project).toContain("list:file");
    });

    test("has view and list:user permissions for groups", () => {
      expect(manager.statements.group).toContain("view");
      expect(manager.statements.group).toContain("list:user");
      expect(manager.statements.group).not.toContain("create");
      expect(manager.statements.group).not.toContain("delete");
      expect(manager.statements.group).not.toContain("view:all");
      expect(manager.statements.group).not.toContain("add:user");
      expect(manager.statements.group).not.toContain("remove:user");
    });

    test("has no user management permissions", () => {
      expect(manager.statements.user).toEqual([]);
    });

    test("has no session management permissions", () => {
      expect(manager.statements.session).toEqual([]);
    });
  });

  describe("user role", () => {
    test("has view and list:user permissions for groups", () => {
      expect(user.statements.group).toContain("view");
      expect(user.statements.group).toContain("list:user");
      expect(user.statements.group).not.toContain("create");
      expect(user.statements.group).not.toContain("delete");
      expect(user.statements.group).not.toContain("view:all");
    });

    test("has only list:file permission for projects", () => {
      expect(user.statements.project).toEqual(["list:file"]);
    });

    test("has no user management permissions", () => {
      expect(user.statements.user).toEqual([]);
    });

    test("has no session management permissions", () => {
      expect(user.statements.session).toEqual([]);
    });
  });

  describe("role hierarchy", () => {
    test("admin has more group permissions than manager", () => {
      expect(admin.statements.group.length).toBeGreaterThan(
        manager.statements.group.length
      );
    });

    test("manager has more project permissions than user", () => {
      expect(manager.statements.project.length).toBeGreaterThan(
        user.statements.project.length
      );
    });

    test("admin has user management permissions that manager does not", () => {
      expect(admin.statements.user.length).toBeGreaterThan(0);
      expect(manager.statements.user.length).toBe(0);
    });
  });
});
