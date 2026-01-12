"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { FileText, Plus } from "lucide-react";
import type { ChatTemplate } from "./chat-templates";

type ChatTemplateSidebarProps = {
  templates: ChatTemplate[];
  onInsert: (templateBody: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function TemplateList({
  templates,
  onInsert,
}: {
  templates: ChatTemplate[];
  onInsert: (templateBody: string) => void;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 pb-2">
        {templates.map((template) => (
          <div
            key={template.id}
            className="bg-muted/40 border-border/60 rounded-lg border p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="font-medium leading-tight">
                  {template.title}
                </div>
                {template.description ? (
                  <p className="text-muted-foreground text-sm">
                    {template.description}
                  </p>
                ) : null}
              </div>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={() => onInsert(template.body)}
                aria-label={`Vorlage "${template.title}" einfügen`}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function SidebarPanel({
  templates,
  onInsert,
  showHeading = true,
}: {
  templates: ChatTemplate[];
  onInsert: (templateBody: string) => void;
  showHeading?: boolean;
}) {
  return (
    <div className="flex h-full flex-col gap-4">
      {showHeading ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">Vorlagen</span>
          </div>
          <p className="text-muted-foreground text-sm">
            Füge einen Vorschlag in das Eingabefeld ein und passe ihn an.
          </p>
        </div>
      ) : null}
      <TemplateList templates={templates} onInsert={onInsert} />
    </div>
  );
}

export function ChatTemplateSidebar({
  templates,
  onInsert,
  open,
  onOpenChange,
}: ChatTemplateSidebarProps) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)");
    const handleChange = () => setIsMobile(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const showSheet = open && isMobile;

  return (
    <>
      <div className="hidden h-full lg:block">
        {open ? (
          <Card className="h-full w-80 border-muted shadow-sm">
            <CardContent className="flex h-full flex-col">
              <SidebarPanel
                templates={templates}
                onInsert={onInsert}
                showHeading={false}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Sheet open={showSheet} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="p-4 lg:hidden"
          aria-label="Vorlagen"
        >
          <SidebarPanel templates={templates} onInsert={onInsert} />
        </SheetContent>
      </Sheet>
    </>
  );
}
