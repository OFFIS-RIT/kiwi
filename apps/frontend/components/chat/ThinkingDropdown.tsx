"use client";

import React, { useEffect, useState } from "react";
import { Brain, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/providers/LanguageProvider";

type ThinkingDropdownProps = {
    children: React.ReactNode;
    thinkingDuration?: number;
    isLive?: boolean;
    startTime?: number;
    /** Overrides the default "Thought for Xs" / "Show reasoning" label. */
    label?: string;
};

export function ThinkingDropdown({
    children,
    thinkingDuration,
    isLive = false,
    startTime,
    label,
}: ThinkingDropdownProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const { t } = useLanguage();

    useEffect(() => {
        if (!isLive || !startTime) return;

        const updateElapsed = () => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            setElapsedSeconds(elapsed);
        };

        updateElapsed();
        const interval = setInterval(updateElapsed, 1000);

        return () => clearInterval(interval);
    }, [isLive, startTime]);

    const displaySeconds = isLive
        ? elapsedSeconds.toString()
        : thinkingDuration
          ? (thinkingDuration / 1000).toFixed(1)
          : undefined;

    const labelText =
        label ?? (displaySeconds ? t("thinking.collapsed", { seconds: displaySeconds }) : t("thinking.show"));
    const hasBody = React.Children.count(children) > 0;

    if (!hasBody) {
        // Render a non-interactive header (same visual rhythm as the expanded
        // version) so the UI doesn't lie about being expandable when there is
        // nothing to reveal yet.
        return (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {isLive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
                <span>{labelText}</span>
            </div>
        );
    }

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2 w-full justify-between cursor-pointer"
                    )}
                >
                    <div className="flex items-center gap-2">
                        {isLive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
                        <span>{labelText}</span>
                    </div>
                    {isOpen ? (
                        <ChevronUp className="h-4 w-4 transition-transform" />
                    ) : (
                        <ChevronDown className="h-4 w-4 transition-transform" />
                    )}
                </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="mt-2 space-y-2 rounded-md border border-border/30 bg-muted/20 p-3 text-sm text-muted-foreground">
                    {children}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}
