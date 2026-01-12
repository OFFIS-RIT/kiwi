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
import { useDeleteGroup } from "@/hooks/use-data";
import { getChatStorageKey } from "@/lib/utils";
import { useLanguage } from "@/providers/LanguageProvider";
import { useNavigation } from "@/providers/NavigationProvider";
import { useData } from "@/providers/DataProvider";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

type DeleteGroupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: {
    id: string;
    name: string;
  } | null;
};

export function DeleteGroupDialog({
  open,
  onOpenChange,
  group,
}: DeleteGroupDialogProps) {
  const { t } = useLanguage();
  const { showGroups, selectedGroup } = useNavigation();
  const { groups } = useData();
  const deleteGroupMutation = useDeleteGroup();

  useEffect(() => {
    if (!open) {
      deleteGroupMutation.reset();
    }
  }, [open, deleteGroupMutation]);

  const handleDelete = async () => {
    if (!group) return;

    const groupWithProjects = groups.find((g) => g.id === group.id);
    const projectIds = groupWithProjects?.projects.map((p) => p.id) ?? [];

    try {
      await deleteGroupMutation.mutateAsync(group.id);

      for (const projectId of projectIds) {
        localStorage.removeItem(getChatStorageKey(projectId));
      }

      onOpenChange(false);

      if (selectedGroup?.id === group.id) {
        showGroups();
      }
    } catch (err) {
      console.error("Failed to delete group:", err);
    }
  };

  const error = deleteGroupMutation.error
    ? deleteGroupMutation.error instanceof Error
      ? deleteGroupMutation.error.message
      : t("delete.group.error") || "Fehler beim Löschen der Gruppe."
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t("delete.group.confirm")}</DialogTitle>
          <DialogDescription>
            {t("delete.group.description", { groupName: group?.name || "" })}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md text-sm">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteGroupMutation.isPending}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteGroupMutation.isPending}
          >
            {deleteGroupMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
