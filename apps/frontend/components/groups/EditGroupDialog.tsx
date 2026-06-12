"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { fetchGroupAvailableUsers, fetchGroupUsers, updateGroup, updateGroupUsers } from "@/lib/api/groups";
import { canChangeTeamAdminRole, canManageTeam, canRemoveTeamMember, canRenameTeam } from "@/lib/capabilities";
import {
    type SearchableFields,
    compactUserSearch,
    createSearchIndex,
    fuzzySearchUsers,
    normalizeUserSearch,
} from "@/lib/user-search";
import type { Group } from "@/types";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { queryKeys } from "@/lib/query-keys";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type EditableUser = {
    user_id: string;
    user_name?: string | null;
    role: string;
};

type UserSuggestion = {
    id: string;
    name: string;
    email: string;
};

type SearchableUserSuggestion = UserSuggestion & SearchableFields;

function getInitials(name: string): string {
    return name
        .split(" ")
        .map((part) => part[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase();
}

type EditGroupDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    group: Group | null;
};

const MAX_NAME_LENGTH = 40;

export function EditGroupDialog({ open, onOpenChange, group }: EditGroupDialogProps) {
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const t = useAppTranslations();
    const { isAdmin } = useAuth();
    const context = { isAdmin };
    const canEdit = group ? canRenameTeam(group, context) : false;
    const canManageMembers = group ? canManageTeam(group, context) : false;
    const canAddUser = canManageMembers;
    const canManageRoles = canManageMembers;
    const canRemoveUser = group ? canRemoveTeamMember(group, context) : false;
    const canEditAdminRole = group ? canChangeTeamAdminRole(group, context) : false;
    const [isLoading, setIsLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [editedName, setEditedName] = useState("");
    const [editableUsers, setEditableUsers] = useState<EditableUser[]>([]);

    const nameTooLong = editedName.length > MAX_NAME_LENGTH;

    const [newUserSearch, setNewUserSearch] = useState("");
    const [selectedUser, setSelectedUser] = useState<UserSuggestion | null>(null);
    const [availableUsers, setAvailableUsers] = useState<UserSuggestion[]>([]);
    const [isSearchingUsers, setIsSearchingUsers] = useState(false);
    const [newUserRole, setNewUserRole] = useState("member");
    const groupId = group?.id;
    const groupName = group?.name;

    const loadGroupUsers = useCallback(async () => {
        if (!groupId) return;
        setIsLoading(true);
        setError(null);
        try {
            const users = await fetchGroupUsers(apiClient, groupId);
            setEditableUsers(users.map((u) => ({ user_id: u.user_id, user_name: u.user_name, role: u.role })));
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.loading.users"));
        } finally {
            setIsLoading(false);
        }
    }, [apiClient, groupId, t]);

    useEffect(() => {
        if (groupId && groupName !== undefined && open) {
            setEditedName(groupName);
            loadGroupUsers();
        } else {
            setError(null);
            setNewUserSearch("");
            setSelectedUser(null);
            setNewUserRole("member");
        }
    }, [groupId, groupName, open, loadGroupUsers]);

    const loadAvailableUsers = useCallback(async () => {
        if (!canAddUser || !open || !groupId) {
            return;
        }

        setIsSearchingUsers(true);

        try {
            const users = await fetchGroupAvailableUsers(apiClient, groupId);
            setAvailableUsers(
                users.map((user) => ({
                    id: user.user_id,
                    name: user.user_name ?? user.user_id,
                    email: user.user_email,
                }))
            );
        } catch {
            setAvailableUsers([]);
        } finally {
            setIsSearchingUsers(false);
        }
    }, [apiClient, canAddUser, groupId, open]);

    useEffect(() => {
        if (!open || !canAddUser) {
            setAvailableUsers([]);
            setIsSearchingUsers(false);
            return;
        }

        void loadAvailableUsers();
    }, [canAddUser, loadAvailableUsers, open]);

    const handleUpdateUserRole = (userId: string, newRole: string) => {
        setEditableUsers(editableUsers.map((user) => (user.user_id === userId ? { ...user, role: newRole } : user)));
    };

    const handleRemoveUser = (userId: string) => {
        setEditableUsers(editableUsers.filter((user) => user.user_id !== userId));
    };

    const handleAddUser = () => {
        if (!selectedUser) {
            setError(t("error.invalid.userid"));
            return;
        }
        const userID = selectedUser.id;
        if (editableUsers.some((u) => u.user_id === userID)) {
            setError(t("error.duplicate.userid"));
            return;
        }
        setError(null);
        setEditableUsers([
            ...editableUsers,
            { user_id: selectedUser.id, user_name: selectedUser.name, role: newUserRole },
        ]);
        setNewUserSearch("");
        setSelectedUser(null);
        setNewUserRole("member");
    };

    const handleSubmit = async () => {
        if (!group) return;
        setIsSubmitting(true);
        setError(null);
        try {
            if (canEdit) {
                await updateGroup(apiClient, group.id, editedName, editableUsers);
            } else {
                await updateGroupUsers(
                    apiClient,
                    group.id,
                    editableUsers.map((user) => ({
                        user_id: user.user_id,
                        role: user.role as "admin" | "moderator" | "member",
                    }))
                );
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
            onOpenChange(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.saving"));
        } finally {
            setIsSubmitting(false);
        }
    };

    const showUserSuggestions =
        newUserSearch.trim().length > 0 && (!selectedUser || newUserSearch.trim() !== selectedUser.name);

    const searchableUsers = useMemo<SearchableUserSuggestion[]>(
        () =>
            availableUsers
                .filter((user) => !editableUsers.some((member) => member.user_id === user.id))
                .map((user) => ({
                    ...user,
                    normalizedName: normalizeUserSearch(user.name),
                    compactName: compactUserSearch(user.name),
                })),
        [availableUsers, editableUsers]
    );

    const userSearchIndex = useMemo(() => createSearchIndex(searchableUsers), [searchableUsers]);

    const userSuggestions = useMemo(() => {
        if (!showUserSuggestions || !newUserSearch.trim()) {
            return [];
        }

        return fuzzySearchUsers(searchableUsers, userSearchIndex, newUserSearch)
            .map((user) => ({ id: user.id, name: user.name, email: user.email }) satisfies UserSuggestion)
            .slice(0, 5);
    }, [newUserSearch, searchableUsers, showUserSuggestions, userSearchIndex]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[800px] h-[80vh] flex flex-col"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
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
                                        onFocus={(e) => {
                                            const input = e.target;
                                            requestAnimationFrame(() => {
                                                input.selectionStart = input.selectionEnd = input.value.length;
                                            });
                                        }}
                                        disabled={!canEdit}
                                    />
                                    {nameTooLong && (
                                        <p className="text-sm text-destructive">
                                            {t("error.name.too.long", { max: String(MAX_NAME_LENGTH) })}
                                        </p>
                                    )}
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
                                    <div className="space-y-1">
                                        {editableUsers.map((user, index) => {
                                            const displayName = user.user_name?.trim() || user.user_id;

                                            return (
                                                <div key={user.user_id}>
                                                    <div className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                                                        <Avatar className="h-9 w-9 shrink-0">
                                                            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                                                                {getInitials(displayName)}
                                                            </AvatarFallback>
                                                        </Avatar>

                                                        <div className="min-w-0 flex-1">
                                                            <span className="block truncate text-sm font-medium">
                                                                {displayName}
                                                            </span>
                                                        </div>

                                                        {canManageRoles ? (
                                                            <div className="flex shrink-0 items-center gap-1">
                                                                <Select
                                                                    value={user.role}
                                                                    onValueChange={(newRole) =>
                                                                        handleUpdateUserRole(user.user_id, newRole)
                                                                    }
                                                                    disabled={!canEditAdminRole && user.role === "admin"}
                                                                >
                                                                    <SelectTrigger className="h-8 w-[110px] text-xs">
                                                                        <SelectValue placeholder={t("admin.role")} />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                        {canEditAdminRole && (
                                                                            <SelectItem value="admin">
                                                                                {t("admin.role.admin")}
                                                                            </SelectItem>
                                                                        )}
                                                                        <SelectItem value="moderator">
                                                                            {t("admin.role.moderator")}
                                                                        </SelectItem>
                                                                        <SelectItem value="member">
                                                                            {t("admin.role.user")}
                                                                        </SelectItem>
                                                                    </SelectContent>
                                                                </Select>
                                                                {canRemoveUser && (canEditAdminRole || user.role !== "admin") && (
                                                                    <Button
                                                                        type="button"
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        className="h-8 w-8"
                                                                        onClick={() => handleRemoveUser(user.user_id)}
                                                                    >
                                                                        <X className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <Badge
                                                                variant="outline"
                                                                className={
                                                                    user.role === "admin"
                                                                        ? "border-primary/30 bg-primary/10 text-primary"
                                                                        : "border-border bg-muted text-muted-foreground"
                                                                }
                                                            >
                                                                {user.role}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    {index < editableUsers.length - 1 ? (
                                                        <Separator className="mx-3" />
                                                    ) : null}
                                                </div>
                                            );
                                        })}

                                        {canAddUser && (
                                            <div>
                                                {editableUsers.length > 0 ? <Separator className="mx-3" /> : null}
                                                <div className="group flex flex-col gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-3">
                                                    <div className="flex min-w-0 flex-1 items-center gap-3">
                                                        <Avatar className="h-9 w-9 shrink-0">
                                                            <AvatarFallback
                                                                className={
                                                                    selectedUser
                                                                        ? "bg-primary/10 text-xs font-medium text-primary"
                                                                        : "bg-muted text-muted-foreground"
                                                                }
                                                            >
                                                                {selectedUser ? (
                                                                    getInitials(selectedUser.name)
                                                                ) : (
                                                                    <Plus className="h-4 w-4" />
                                                                )}
                                                            </AvatarFallback>
                                                        </Avatar>

                                                        <div className="relative flex-1">
                                                            <Input
                                                                placeholder={t("admin.search.users")}
                                                                value={newUserSearch}
                                                                onChange={(e) => {
                                                                    const nextValue = e.target.value;
                                                                    setNewUserSearch(nextValue);
                                                                    setError(null);
                                                                    if (
                                                                        selectedUser &&
                                                                        nextValue !== selectedUser.name
                                                                    ) {
                                                                        setSelectedUser(null);
                                                                    }
                                                                }}
                                                                className="h-9 border-0 bg-muted/50 shadow-none focus-visible:ring-1 sm:bg-transparent sm:px-0 sm:focus-visible:ring-0"
                                                            />

                                                            {showUserSuggestions ? (
                                                                <div className="absolute top-full left-0 z-20 mt-2 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
                                                                    {userSuggestions.length > 0 ? (
                                                                        <div className="p-1">
                                                                            {userSuggestions.map((user) => (
                                                                                <button
                                                                                    key={user.id}
                                                                                    type="button"
                                                                                    className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left hover:bg-muted"
                                                                                    onClick={() => {
                                                                                        setSelectedUser(user);
                                                                                        setNewUserSearch(user.name);
                                                                                        setError(null);
                                                                                    }}
                                                                                >
                                                                                    <Avatar className="h-8 w-8 shrink-0">
                                                                                        <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                                                                                            {getInitials(user.name)}
                                                                                        </AvatarFallback>
                                                                                    </Avatar>
                                                                                    <div className="min-w-0 flex-1">
                                                                                        <div className="truncate text-sm font-medium">
                                                                                            {user.name}
                                                                                        </div>
                                                                                        <div className="truncate text-xs text-muted-foreground">
                                                                                            {user.email}
                                                                                        </div>
                                                                                    </div>
                                                                                    {selectedUser?.id === user.id ? (
                                                                                        <Check className="h-4 w-4 text-primary" />
                                                                                    ) : null}
                                                                                </button>
                                                                            ))}
                                                                        </div>
                                                                    ) : isSearchingUsers ? (
                                                                        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                                                                            <Loader2 className="h-4 w-4 animate-spin" />
                                                                            {t("loading.users")}
                                                                        </div>
                                                                    ) : (
                                                                        <div className="px-3 py-2 text-sm text-muted-foreground">
                                                                            {t("admin.no.users")}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-2 sm:shrink-0">
                                                        <Select value={newUserRole} onValueChange={setNewUserRole}>
                                                            <SelectTrigger className="h-8 flex-1 text-xs sm:w-[110px]">
                                                                <SelectValue placeholder={t("admin.role")} />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                {canEditAdminRole && (
                                                                    <SelectItem value="admin">
                                                                        {t("admin.role.admin")}
                                                                    </SelectItem>
                                                                )}
                                                                <SelectItem value="moderator">
                                                                    {t("admin.role.moderator")}
                                                                </SelectItem>
                                                                <SelectItem value="member">
                                                                    {t("admin.role.user")}
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="outline"
                                                            className="px-3"
                                                            disabled={!selectedUser}
                                                            onClick={handleAddUser}
                                                        >
                                                            {t("add.user")}
                                                        </Button>
                                                    </div>
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
                        <Button onClick={handleSubmit} disabled={isSubmitting || nameTooLong}>
                            {t("save.changes")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
