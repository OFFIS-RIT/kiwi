"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";

type ThinkingDropdownProps = {
    children: React.ReactNode;
    /** Total assistant message duration in ms, populated from metadata once the stream finishes. */
    durationMs?: number;
    /** True while the assistant message is still streaming. Drives the live counter and auto-open. */
    isStreaming?: boolean;
    /**
     *  Wall-clock ms when the message started — must be a stable value (e.g. derived
     *  from message metadata) so the timer keeps counting from the same anchor when
     *  the component remounts (chat switch, hydration).
     */
    startedAtMs?: number;
};

function computeElapsedSeconds(startedAtMs: number | undefined): number {
    if (startedAtMs === undefined) return 0;
    return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
}

export function ThinkingDropdown({
    children,
    durationMs,
    isStreaming = false,
    startedAtMs,
}: ThinkingDropdownProps) {
    const t = useAppTranslations();
    const [isOpen, setIsOpen] = useState(isStreaming);
    const [elapsedSeconds, setElapsedSeconds] = useState(() =>
        isStreaming ? computeElapsedSeconds(startedAtMs) : 0
    );
    const previousStreamingRef = useRef(isStreaming);

    useEffect(() => {
        if (!isStreaming) return;
        const tick = () => setElapsedSeconds(computeElapsedSeconds(startedAtMs));
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [isStreaming, startedAtMs]);

    // Auto-collapse exactly once when the stream finishes so the final answer
    // can read cleanly. The user can still toggle the dropdown manually
    // before or after — we only force the state on the streaming→idle edge.
    useEffect(() => {
        if (previousStreamingRef.current && !isStreaming) {
            setIsOpen(false);
        }
        previousStreamingRef.current = isStreaming;
    }, [isStreaming]);

    const displaySeconds =
        durationMs !== undefined ? Math.max(0, Math.round(durationMs / 1000)) : elapsedSeconds;

    const showLiveLabel = isStreaming && durationMs === undefined && displaySeconds === 0;
    const labelText = showLiveLabel
        ? t("worked.live")
        : t("worked.label", { seconds: displaySeconds.toString() });

    const hasBody = React.Children.count(children) > 0;

    if (!hasBody) {
        return <div className="text-sm text-muted-foreground">{labelText}</div>;
    }

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="flex cursor-pointer items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                    <span>{labelText}</span>
                    {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                    )}
                </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="mt-3 space-y-2 border-t border-border/40 pt-3 text-sm text-muted-foreground">
                    {children}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}
