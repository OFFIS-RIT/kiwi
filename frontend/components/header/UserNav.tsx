"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/providers/LanguageProvider";
import { useAuth } from "@/providers/AuthProvider";
import { LogOut, Shield } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

const UserManagementSheet = lazy(() =>
  import("@/components/admin").then((mod) => ({
    default: mod.UserManagementSheet,
  }))
);

export function UserNav() {
  const { t } = useLanguage();
  const { user, isAdmin, signOut } = useAuth();
  const [showUserManagement, setShowUserManagement] = useState(false);

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-2 px-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="hidden md:inline">{user?.name ?? ""}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <ThemeToggle />
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowUserManagement(true)}>
                <Shield className="h-4 w-4" />
                <span>{t("admin.user.management")}</span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => signOut()}>
            <LogOut className="h-4 w-4" />
            <span>{t("auth.sign.out")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && (
        <Suspense fallback={null}>
          <UserManagementSheet
            open={showUserManagement}
            onOpenChange={setShowUserManagement}
          />
        </Suspense>
      )}
    </>
  );
}
