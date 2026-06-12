"use client";

import { Button } from "@/components/ui/button";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { Check, Copy } from "lucide-react";
import React from "react";

/** Collects the plain text of the rendered code tree so copying yields the
 *  raw code instead of the highlight.js span markup. */
function extractText(node: React.ReactNode): string {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(extractText).join("");
    if (React.isValidElement(node)) {
        return extractText((node.props as { children?: React.ReactNode }).children);
    }
    return "";
}

/**
 * Fenced code block in chat messages: styled <pre> with a floating copy
 * button. The button is hover-revealed on pointer devices and permanently
 * visible on devices without hover (touch).
 */
export function MessageCodeBlock({ children }: { children: React.ReactNode }) {
    const t = useAppTranslations();
    const [copied, setCopied] = React.useState(false);
    const resetTimer = React.useRef<number | undefined>(undefined);

    React.useEffect(() => () => window.clearTimeout(resetTimer.current), []);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(extractText(children).replace(/\n$/, ""));
        } catch {
            return;
        }
        setCopied(true);
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="group/code relative my-3">
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-sm leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-mono">
                {children}
            </pre>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                aria-label={copied ? t("copied.code") : t("copy.code")}
                className="absolute right-1.5 top-1.5 size-7 bg-muted/80 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/code:opacity-100 [@media(hover:none)]:opacity-100"
            >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
        </div>
    );
}
