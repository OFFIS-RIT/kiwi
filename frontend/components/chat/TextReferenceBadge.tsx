"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchProjectFiles, fetchTextUnit } from "@/lib/api/projects";
import type { ApiTextUnit } from "@/types";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import React, { useState } from "react";

type TextReferenceBadgeProps = {
  referenceId: string;
  index: number;
  projectId?: string;
};

export function TextReferenceBadge({
  referenceId,
  index,
  projectId,
}: TextReferenceBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [textReference, setTextReference] = useState<ApiTextUnit | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTextReference = async () => {
    if (textReference) return;

    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchTextUnit(referenceId);
      setTextReference(data);

      if (projectId) {
        try {
          const projectFiles = await fetchProjectFiles(projectId);
          const file = projectFiles.find((f) => f.id === data.project_file_id);
          if (file) {
            setFileName(file.name);
          }
        } catch (fileError) {
          console.warn("Could not fetch filename:", fileError);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unbekannter Fehler");
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      fetchTextReference();
    }
  };

  const copyToClipboard = () => {
    if (textReference?.text) {
      navigator.clipboard.writeText(textReference.text);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Badge
          variant="outline"
          className="mx-0.5 inline-flex cursor-pointer items-center border-2 text-xs transition-colors hover:border-primary/40 hover:bg-primary/10"
          title={`Referenz ${index + 1}: ${referenceId}`}
        >
          {index + 1}
        </Badge>
      </DialogTrigger>
      <DialogContent className="w-full max-w-6xl sm:max-w-[60vw] max-h-[80vh] overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              Text-Referenz #{index + 1}
            </DialogTitle>
            <DialogDescription>Referenz-ID: {referenceId}</DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1 pr-1">
            <div className="space-y-4">
              {isLoading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="ml-2">Lade Textinhalt...</span>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                  <p className="font-medium text-destructive">
                    Fehler beim Laden:
                  </p>
                  <p className="text-sm text-destructive/80">{error}</p>
                </div>
              )}

              {textReference && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Textinhalt:</h4>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={copyToClipboard}
                      className="flex items-center gap-2"
                    >
                      <Copy className="h-3 w-3" />
                      Kopieren
                    </Button>
                  </div>

                  <div className="max-h-[50vh] w-full overflow-auto rounded-md border">
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed p-4">
                      {textReference.text.replace(/\s+/g, " ").trim()}
                    </div>
                  </div>

                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p>
                      Erstellt:{" "}
                      {new Date(textReference.created_at).toLocaleString()}
                    </p>
                    <p>
                      {fileName
                        ? `Datei: ${fileName}`
                        : `Datei-ID: ${textReference.project_file_id}`}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
