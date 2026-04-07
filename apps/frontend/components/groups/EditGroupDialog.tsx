"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { fetchGroupUsers, updateGroup } from "@/lib/api/groups";
import { useAuth } from "@/providers/AuthProvider";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { Loader2, Plus, UserCircle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type EditableUser = {
    user_id: string;
    role: string;
};

type EditGroupDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    group: {
        id: string;
        name: string;
    } | null;
};

export function EditGroupDialog({ open, onOpenChange, group }: EditGroupDialogProps) {
    const { t } = useLanguage();
    const { hasPermission } = useAuth();
    const { refreshData } = useData();
    const canEdit = hasPermission("group.update");
    const canAddUser = hasPermission("group.add:user");
    const canRemoveUser = hasPermission("group.remove:user");
    const [isLoading, setIsLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [editedName, setEditedName] = useState("");
    const [editableUsers, setEditableUsers] = useState<EditableUser[]>([]);

    const [newUserId, setNewUserId] = useState("");
    const [newUserRole, setNewUserRole] = useState("user");

    const loadGroupUsers = useCallback(async () => {
        if (!group) return;
        setIsLoading(true);
        setError(null);
        try {
            const users = await fetchGroupUsers(group.id);
            setEditableUsers(users.map((u) => ({ user_id: u.user_id, role: u.role })));
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.loading.users"));
        } finally {
            setIsLoading(false);
        }
    }, [group, t]);

    useEffect(() => {
        if (group && open) {
            setEditedName(group.name);
            loadGroupUsers();
        } else {
            setError(null);
            setNewUserId("");
            setNewUserRole("user");
        }
    }, [group, open, loadGroupUsers]);

    const handleUpdateUserRole = (userId: string, newRole: string) => {
        setEditableUsers(editableUsers.map((user) => (user.user_id === userId ? { ...user, role: newRole } : user)));
    };

    const handleRemoveUser = (userId: string) => {
        setEditableUsers(editableUsers.filter((user) => user.user_id !== userId));
    };

    const handleAddUser = () => {
        const userID = newUserId.trim();
        if (!userID) {
            setError(t("error.invalid.userid"));
            return;
        }
        if (editableUsers.some((u) => u.user_id === userID)) {
            setError(t("error.duplicate.userid"));
            return;
        }
        setError(null);
        setEditableUsers([...editableUsers, { user_id: userID, role: newUserRole }]);
        setNewUserId("");
        setNewUserRole("user");
    };

    const handleSubmit = async () => {
        if (!group) return;
        setIsSubmitting(true);
        setError(null);
        try {
            await updateGroup(group.id, editedName, editableUsers);
            await refreshData();
            onOpenChange(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.saving"));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[800px] h-[80vh] flex flex-col">
                <DialogHeader className="flex-shrink-0">
                    <DialogTitle>{t("edit.group")}</DialogTitle>
                    <DialogDescription>{t("edit.group.description")}</DialogDescription>
                </DialogHeader>

                <div className="flex-1 min-h-0">
                    <ScrollArea className="h-full">
                        <div className="space-y-6 pr-4">
                            {error && (
                                <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md text-sm">
                                    {error}
                                </div>
                            )}

                            <div className="space-y-4">
                                <div className="grid gap-2">
                                    <Label htmlFor="group-name">{t("group.name")}</Label>
                                    <Input
                                        id="group-name"
                                        value={editedName}
                                        onChange={(e) => setEditedName(e.target.value)}
                                        disabled={!canEdit}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label htmlFor="group-id">{t("group.id")}</Label>
                                    <Input
                                        id="group-id"
                                        value={group?.id || ""}
                                        disabled
                                        className="bg-muted font-mono text-sm"
                                    />
                                </div>
                            </div>

                            <Separator />

                            <div className="space-y-4">
                                <h3 className="text-lg font-medium">{t("group.users")}</h3>
                                {isLoading ? (
                                    <div className="flex items-center justify-center py-4">
                                        <Loader2 className="h-6 w-6 animate-spin" />
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {editableUsers.map((user) => (
                                            <div
                                                key={user.user_id}
                                                className="flex items-center gap-2 rounded-md border p-2"
                                            >
                                                <UserCircle className="h-5 w-5 text-muted-foreground" />
                                                <span className="flex-1 font-mono text-sm">
                                                    {t("user.id")}: {user.user_id}
                                                </span>
                                                {canRemoveUser ? (
                                                    <>
                                                        <Select
                                                            value={user.role}
                                                            onValueChange={(newRole) =>
                                                                handleUpdateUserRole(user.user_id, newRole)
                                                            }
                                                        >
                                                            <SelectTrigger className="w-[140px]">
                                                                <SelectValue placeholder={t("admin.role")} />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="admin">
                                                                    {t("admin.role.admin")}
                                                                </SelectItem>
                                                                <SelectItem value="moderator">
                                                                    {t("admin.role.manager")}
                                                                </SelectItem>
                                                                <SelectItem value="user">
                                                                    {t("admin.role.user")}
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => handleRemoveUser(user.user_id)}
                                                        >
                                                            <X className="h-4 w-4" />
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <Badge
                                                        variant="outline"
                                                        className={
                                                            user.role === "admin"
                                                                ? "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                                                                : "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                                                        }
                                                    >
                                                        {user.role}
                                                    </Badge>
                                                )}
                                            </div>
                                        ))}

                                        {canAddUser && (
                                            <div className="rounded-md border p-2">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Input
                                                        placeholder={t("user.id.placeholder")}
                                                        value={newUserId}
                                                        onChange={(e) => setNewUserId(e.target.value)}
                                                        className="max-w-[160px]"
                                                    />
                                                    <Select value={newUserRole} onValueChange={setNewUserRole}>
                                                        <SelectTrigger className="w-[140px]">
                                                            <SelectValue placeholder={t("admin.role")} />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="admin">
                                                                {t("admin.role.admin")}
                                                            </SelectItem>
                                                            <SelectItem value="moderator">
                                                                {t("admin.role.manager")}
                                                            </SelectItem>
                                                            <SelectItem value="user">{t("admin.role.user")}</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                    <Button type="button" onClick={handleAddUser}>
                                                        <Plus className="mr-2 h-4 w-4" />
                                                        {t("add.user")}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </ScrollArea>
                </div>

                <DialogFooter className="flex-shrink-0">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        {canEdit || canAddUser || canRemoveUser ? t("cancel") : t("close")}
                    </Button>
                    {(canEdit || canAddUser || canRemoveUser) && (
                        <Button onClick={handleSubmit} disabled={isSubmitting}>
                            {t("save.changes")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
