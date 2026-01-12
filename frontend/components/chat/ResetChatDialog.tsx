"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/providers/LanguageProvider";
import { RotateCcw } from "lucide-react";
import type React from "react";

type ResetChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  projectName: string;
};

export function ResetChatDialog({
  open,
  onOpenChange,
  onConfirm,
  projectName,
}: ResetChatDialogProps) {
  const { t } = useLanguage();

  const handleReset = () => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t("reset.chat.confirm")}</DialogTitle>
          <DialogDescription>
            {t("reset.chat.description", { projectName })}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={handleReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("reset.chat")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
