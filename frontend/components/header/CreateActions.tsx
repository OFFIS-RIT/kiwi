"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/providers/LanguageProvider";
import { BookOpen, Plus, Upload, Users } from "lucide-react";
import { Suspense, lazy, useState } from "react";

const CreateGroupDialog = lazy(() =>
  import("@/components/groups").then((mod) => ({
    default: mod.CreateGroupDialog,
  }))
);
const CreateProjectDialog = lazy(() =>
  import("@/components/projects").then((mod) => ({
    default: mod.CreateProjectDialog,
  }))
);

export function CreateActions() {
  const { t } = useLanguage();
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Plus className="h-5 w-5" />
            <span className="sr-only">{t("create.new")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setShowGroupDialog(true)}>
            <Users className="mr-2 h-4 w-4" />
            <span>{t("create.new.group")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShowProjectDialog(true)}>
            <BookOpen className="mr-2 h-4 w-4" />
            <span>{t("create.new.project")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Upload className="mr-2 h-4 w-4" />
            <span>{t("upload.files")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Suspense fallback={null}>
        <CreateProjectDialog
          open={showProjectDialog}
          onOpenChange={setShowProjectDialog}
        />
      </Suspense>
      <Suspense fallback={null}>
        <CreateGroupDialog
          open={showGroupDialog}
          onOpenChange={setShowGroupDialog}
        />
      </Suspense>
    </>
  );
}
