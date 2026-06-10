"use client";

import { PromptEditor } from "@/components/settings/PromptEditor";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import type { User } from "./UserTable";

type UserPromptsDialogProps = {
    user: User | null;
    onOpenChange: (open: boolean) => void;
};

export function UserPromptsDialog({ user, onOpenChange }: UserPromptsDialogProps) {
    const t = useAppTranslations();

    return (
        <Dialog open={user !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>{t("admin.user.prompts.title", { name: user?.name ?? "" })}</DialogTitle>
                    <DialogDescription>{t("admin.user.prompts.description")}</DialogDescription>
                </DialogHeader>
                {user ? <PromptEditor scope={{ kind: "user", userId: user.id }} /> : null}
            </DialogContent>
        </Dialog>
    );
}
