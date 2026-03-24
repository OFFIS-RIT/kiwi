"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useLanguage } from "@/providers/LanguageProvider";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { CreateUserDialog } from "./CreateUserDialog";
import { UserTable } from "./UserTable";

const authMode = process.env.NEXT_PUBLIC_AUTH_MODE ?? "credentials";

type UserManagementSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function UserManagementSheet({
  open,
  onOpenChange,
}: UserManagementSheetProps) {
  const { t } = useLanguage();
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto p-6">
          <SheetHeader>
            <SheetTitle>{t("admin.user.management")}</SheetTitle>
            <SheetDescription>{t("admin.users")}</SheetDescription>
          </SheetHeader>
          <div className="space-y-3">
            {authMode === "credentials" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreateUser(true)}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                {t("admin.create.user")}
              </Button>
            )}
            <UserTable key={refreshKey} />
          </div>
        </SheetContent>
      </Sheet>
      <CreateUserDialog
        open={showCreateUser}
        onOpenChange={setShowCreateUser}
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    </>
  );
}
