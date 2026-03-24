"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth-client";
import { useAuth } from "@/providers/AuthProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EditUserDialog } from "./EditUserDialog";

export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  banReason?: string;
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function UserTable() {
  const { t } = useLanguage();
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchValue, setSearchValue] = useState("");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const limit = 20;

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await authClient.admin.listUsers({
        query: {
          limit,
          offset,
          ...(searchValue
            ? {
                searchValue,
                searchField: "name" as const,
                searchOperator: "contains" as const,
              }
            : {}),
        },
      });
      if (error) throw error;
      setUsers(
        (data?.users ?? []).map((u) => ({
          id: u.id,
          name: u.name ?? "",
          email: u.email ?? "",
          role: u.role ?? "user",
          banned: u.banned ?? false,
          banReason: (u as { banReason?: string }).banReason,
        }))
      );
      setTotal(data?.total ?? 0);
    } catch {
      toast.error(t("error.loading.users"));
    } finally {
      setLoading(false);
    }
  }, [searchValue, offset, t]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleRoleChange = async (userId: string, newRole: string) => {
    if (userId === currentUser?.id) {
      toast.error(t("admin.error.self.action"));
      return;
    }
    try {
      await authClient.admin.setRole({
        userId,
        role: newRole as "user" | "admin" | "manager",
      });
      await fetchUsers();
    } catch {
      toast.error(t("error.saving"));
    }
  };

  const handleBanToggle = async (user: User) => {
    if (user.id === currentUser?.id) {
      toast.error(t("admin.error.self.action"));
      return;
    }
    try {
      if (user.banned) {
        await authClient.admin.unbanUser({ userId: user.id });
      } else {
        await authClient.admin.banUser({ userId: user.id });
      }
      await fetchUsers();
    } catch {
      toast.error(t("error.saving"));
    }
  };

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("admin.search.users")}
          value={searchValue}
          onChange={(e) => {
            setSearchValue(e.target.value);
            setOffset(0);
          }}
          className="pl-9 bg-muted/50 border-0 focus-visible:ring-1"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : users.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {t("admin.no.users")}
        </p>
      ) : (
        <div className="space-y-1">
          {users.map((u, i) => (
            <div key={u.id}>
              <div className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarFallback
                    className={
                      u.banned
                        ? "bg-destructive/10 text-destructive text-xs font-medium"
                        : "bg-primary/10 text-primary text-xs font-medium"
                    }
                  >
                    {getInitials(u.name)}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {u.name}
                    </span>
                    {u.banned && (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0 h-4"
                      >
                        {t("admin.status.banned")}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground truncate block">
                    {u.email}
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Select
                    value={u.role}
                    onValueChange={(value) => handleRoleChange(u.id, value)}
                    disabled={u.id === currentUser?.id}
                  >
                    <SelectTrigger className="w-[110px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">
                        {t("admin.role.admin")}
                      </SelectItem>
                      <SelectItem value="manager">
                        {t("admin.role.manager")}
                      </SelectItem>
                      <SelectItem value="user">
                        {t("admin.role.user")}
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setEditingUser(u)}
                    title={t("admin.edit.user")}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 ${u.banned ? "text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950" : "text-destructive hover:bg-destructive/10"}`}
                    onClick={() => handleBanToggle(u)}
                    disabled={u.id === currentUser?.id}
                    title={
                      u.banned ? t("admin.unban.user") : t("admin.ban.user")
                    }
                  >
                    {u.banned ? (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    ) : (
                      <Ban className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
              {i < users.length - 1 && <Separator className="mx-3" />}
            </div>
          ))}
        </div>
      )}

      {total > limit && (
        <div className="flex items-center justify-between pt-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {currentPage} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      <EditUserDialog
        user={editingUser}
        onOpenChange={(open) => {
          if (!open) setEditingUser(null);
        }}
        onUpdated={fetchUsers}
      />
    </div>
  );
}
