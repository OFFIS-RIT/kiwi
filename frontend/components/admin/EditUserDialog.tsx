"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth-client";
import { useLanguage } from "@/providers/LanguageProvider";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { User } from "./UserTable";

type EditUserDialogProps = {
  user: User | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
};

export function EditUserDialog({
  user,
  onOpenChange,
  onUpdated,
}: EditUserDialogProps) {
  const { t } = useLanguage();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setEmail(user.email);
      setPassword("");
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name || !email) return;

    setSaving(true);
    let didSucceed = false;
    try {
      const nameChanged = name !== user.name;
      const emailChanged = email !== user.email;

      if (nameChanged || emailChanged) {
        const { error } = await authClient.admin.updateUser({
          userId: user.id,
          data: {
            ...(nameChanged ? { name } : {}),
            ...(emailChanged ? { email } : {}),
          },
        });
        if (error) throw error;
        user.name = name;
        user.email = email;
        didSucceed = true;
        toast.success(t("admin.user.updated"));
      }

      if (password) {
        const { error } = await authClient.admin.setUserPassword({
          userId: user.id,
          newPassword: password,
        });
        if (error) throw error;
        didSucceed = true;
        toast.success(t("admin.password.updated"));
      }

      onOpenChange(false);
    } catch {
      toast.error(t("error.saving"));
    } finally {
      if (didSucceed) onUpdated();
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("admin.edit.user")}</DialogTitle>
          <DialogDescription>
            {t("admin.edit.user.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-name">{t("auth.name")}</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("auth.name.placeholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-email">{t("auth.email")}</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.email.placeholder")}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="edit-password">{t("admin.new.password")}</Label>
            <Input
              id="edit-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("admin.new.password.placeholder")}
            />
          </div>

          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("admin.save")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
