"use client";

import { CreateGroupDialog, DeleteGroupDialog, EditGroupDialog } from "@/components/groups";
import { Button } from "@/components/ui/button";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { canCreateTeam, canDeleteTeam, canManageTeam } from "@/lib/capabilities";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useAuth } from "@/providers/AuthProvider";
import type { Group } from "@/types";
import { Edit, Loader2, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";

export function SettingsGroupManagement() {
    const t = useAppTranslations();
    const { isAdmin } = useAuth();
    const { data: groups = [], isLoading } = useGroupsWithProjects();
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    const [editingGroup, setEditingGroup] = useState<Group | null>(null);
    const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);

    const context = { isAdmin };
    const teamGroups = useMemo(() => groups.filter((group) => group.scope === "team"), [groups]);
    const canCreateGroup = canCreateTeam(context);
    const getRoleLabel = (role: Group["role"]) => {
        if (role === "admin" || role === "moderator") {
            return t(`admin.role.${role}`);
        }

        return t("admin.role.user");
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <>
            <div className="overflow-hidden rounded-lg border">
                <div className="flex items-center justify-between gap-3 border-b p-4">
                    <div>
                        <h2 className="text-sm font-medium">{t("settings.groupManagement.groups")}</h2>
                        <p className="text-sm text-muted-foreground">
                            {t("settings.groupManagement.groups.description")}
                        </p>
                    </div>
                    {canCreateGroup ? (
                        <Button variant="outline" size="sm" onClick={() => setShowCreateGroup(true)}>
                            <Plus className="mr-2 h-4 w-4" />
                            {t("create.new.group")}
                        </Button>
                    ) : null}
                </div>
                {teamGroups.length === 0 ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">{t("no.groups")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-4 py-2 text-left font-medium">{t("group")}</th>
                                    <th className="px-4 py-2 text-left font-medium">
                                        {t("knowledge.projects")}
                                    </th>
                                    <th className="px-4 py-2 text-left font-medium">{t("admin.role")}</th>
                                    <th className="px-4 py-2 text-right font-medium">{t("options")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {teamGroups.map((group) => {
                                    const canEdit = canManageTeam(group, context);
                                    const canDelete = canDeleteTeam(group, context);

                                    return (
                                        <tr key={group.id}>
                                            <td className="min-w-48 px-4 py-3">
                                                <div className="flex items-center gap-3">
                                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                                                        <Users className="h-4 w-4 text-primary" />
                                                    </div>
                                                    <span className="truncate font-medium">{group.name}</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {t("settings.groupManagement.projectCount", {
                                                    count: group.projects.length,
                                                })}
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {getRoleLabel(group.role)}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        onClick={() => setEditingGroup(group)}
                                                        disabled={!canEdit}
                                                        title={t("edit")}
                                                    >
                                                        <Edit className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 text-destructive hover:bg-destructive/10"
                                                        onClick={() => setDeletingGroup(group)}
                                                        disabled={!canDelete}
                                                        title={t("delete")}
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
            <CreateGroupDialog open={showCreateGroup} onOpenChange={setShowCreateGroup} />
            <EditGroupDialog
                open={editingGroup !== null}
                onOpenChange={(open) => !open && setEditingGroup(null)}
                group={editingGroup}
            />
            <DeleteGroupDialog
                open={deletingGroup !== null}
                onOpenChange={(open) => !open && setDeletingGroup(null)}
                group={deletingGroup}
            />
        </>
    );
}
