"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchSourceReferences } from "@/lib/api/projects";
import { normalizeLatexDelimitersForMarkdown } from "@/lib/latex-math";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useQueryClient } from "@tanstack/react-query";
import { isResolvedCitationFence, splitTextWithCitationFences, type ResolvedCitationFence } from "@kiwi/ai/citation";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { AlertTriangle, FileText, Loader2, Search } from "lucide-react";
import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openCitationSourceFile } from "./citation-file";
import { buildSourceFileCitations, citationReferenceKey } from "./source-file-citations";
import {
    TextReferenceBadge,
    TextReferenceDialog,
    sourceReferenceQueryKey,
} from "./TextReferenceBadge";
import { ThinkingDropdown } from "./ThinkingDropdown";

type MessageContentProps = {
    parts: ChatUIMessage["parts"];
    projectId?: string;
    /** Set to true for the currently-streaming assistant message so the
     *  "Worked for" header counts up live and stays expanded until final text arrives. */
    isStreaming?: boolean;
    /** Final total duration in ms, populated once the stream finishes. */
    durationMs?: number;
    /** Stable wall-clock ms when the message started — keeps the live timer
     *  anchored across component remounts (chat switch, hydration). */
    startedAtMs?: number;
};

type ChatMessagePart = ChatUIMessage["parts"][number];
type ToolPart = ChatMessagePart & { toolCallId: string; state: string };

const REFERENCE_PATTERN = /\[\[cite:([a-zA-Z0-9_-]+)\]\]/g;

function isToolPart(part: ChatMessagePart): part is ToolPart {
    return "toolCallId" in part && "state" in part;
}

function toolNameOf(part: ToolPart): string {
    return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

function ToolRunSummary({ tools }: { tools: ToolPart[] }) {
    const t = useAppTranslations();

    type Group = { count: number; running: boolean; errored: boolean };
    const groups = new Map<string, Group>();
    for (const tool of tools) {
        const name = toolNameOf(tool);
        const current = groups.get(name) ?? { count: 0, running: false, errored: false };
        current.count += 1;
        if (tool.state === "input-streaming" || tool.state === "input-available") {
            current.running = true;
        }
        if (tool.state === "output-error") {
            current.errored = true;
        }
        groups.set(name, current);
    }

    const summary = Array.from(groups.values());
    const anyRunning = summary.some((g) => g.running);
    const anyErrored = summary.some((g) => g.errored);

    const Icon = anyErrored ? AlertTriangle : anyRunning ? Loader2 : Search;
    const iconTone = anyErrored ? "text-destructive" : "text-muted-foreground";

    const labels = Array.from(groups.entries()).map(([name, group]) => {
        const rawLabel = t(`step.${name}`);
        const cleanLabel = rawLabel.replace(/[.…]+$/u, "").trim();
        return group.count > 1 ? `${group.count}× ${cleanLabel}` : cleanLabel;
    });

    return (
        <div className="flex items-center gap-1.5 py-2 text-sm text-muted-foreground">
            <Icon className={`h-3.5 w-3.5 shrink-0 ${iconTone} ${anyRunning ? "animate-spin" : ""}`} />
            <span>{labels.join(" · ")}</span>
        </div>
    );
}

type ThinkingItem =
    | { kind: "interim-text"; key: string; markdown: string }
    | { kind: "tool-run"; key: string; tools: ToolPart[] };

export function MessageContent({
    parts,
    projectId,
    isStreaming = false,
    durationMs,
    startedAtMs,
}: MessageContentProps) {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const [activeCitationSourceId, setActiveCitationSourceId] = React.useState<string | null>(null);

    const {
        markdownContent,
        citations,
        citationBySourceId,
        citationIndexBySourceId,
        thinkingItems,
    } = React.useMemo(() => {
        // Find the last "real" tool index, ignoring the client-side
        // clarification tool which is rendered separately by ClarificationBlock.
        let lastToolIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
            const candidate = parts[i];
            if (candidate && isToolPart(candidate) && toolNameOf(candidate) !== "ask_clarifying_questions") {
                lastToolIdx = i;
                break;
            }
        }

        // While streaming we cannot know yet which text part will be the final
        // answer, so we keep everything inside the dropdown. Only once the
        // stream finishes do we promote the trailing text (everything after
        // the last tool) to the final answer.
        const partitionIdx = isStreaming ? parts.length : lastToolIdx;

        const citationOrder: ResolvedCitationFence[] = [];
        const citationIndexByReferenceKey = new Map<string, number>();
        const citationBySourceId = new Map<string, ResolvedCitationFence>();
        const sourceIndexMap = new Map<string, number>();
        type RawItem =
            | { kind: "interim-text"; key: string; markdown: string }
            | { kind: "tool"; key: string; part: ToolPart };
        const rawItems: RawItem[] = [];

        // Reference key of the citation we last emitted, kept only while no
        // meaningful text has appeared since. Lets us collapse directly
        // adjacent duplicate citations into a single inline badge. It is shared
        // across consecutive final-answer text parts (which render as one
        // contiguous block) and reset at block boundaries below.
        let adjacentReferenceKey: string | null = null;

        // Convert a single text part into markdown, registering any citation
        // fences in the shared citation maps so badge numbers stay stable
        // across interim and final blocks.
        const textPartToMarkdown = (text: string): string => {
            let md = "";
            for (const segment of splitTextWithCitationFences(text)) {
                if (segment.type === "text") {
                    md += segment.text;
                    // Whitespace between two fences still counts as "adjacent";
                    // any non-whitespace text breaks the run.
                    if (segment.text.trim().length > 0) {
                        adjacentReferenceKey = null;
                    }
                    continue;
                }
                if (!isResolvedCitationFence(segment.citation)) continue;

                const referenceKey = citationReferenceKey(segment.citation);
                let citationIndex = citationIndexByReferenceKey.get(referenceKey);
                if (citationIndex === undefined) {
                    citationIndex = citationOrder.length;
                    citationIndexByReferenceKey.set(referenceKey, citationIndex);
                    citationOrder.push(segment.citation);
                }
                citationBySourceId.set(segment.citation.sourceId, segment.citation);
                sourceIndexMap.set(segment.citation.sourceId, citationIndex);

                // Skip directly adjacent duplicates of the same resolved
                // reference so they collapse into one badge; repeated citations
                // separated by meaningful text still render distinct badges.
                if (referenceKey === adjacentReferenceKey) continue;
                adjacentReferenceKey = referenceKey;
                md += `[[cite:${segment.citation.sourceId}]]`;
            }
            return md;
        };

        let markdown = "";
        let interimTextIndex = 0;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part) continue;

            if (part.type === "reasoning") continue;

            if (isToolPart(part)) {
                // A tool block renders separately, breaking visual adjacency.
                adjacentReferenceKey = null;
                if (toolNameOf(part) === "ask_clarifying_questions") continue;
                rawItems.push({ kind: "tool", key: part.toolCallId, part });
                continue;
            }

            if (part.type !== "text") continue;

            if (i > partitionIdx) {
                markdown += textPartToMarkdown(part.text);
                continue;
            }

            // Each interim block renders in its own container, so adjacency
            // must not carry across separate interim parts.
            adjacentReferenceKey = null;
            const interimMarkdown = textPartToMarkdown(part.text).trim();
            if (interimMarkdown.length === 0) continue;

            rawItems.push({
                kind: "interim-text",
                key: `interim-${interimTextIndex++}`,
                markdown: normalizeLatexDelimitersForMarkdown(interimMarkdown),
            });
        }

        // Collapse runs of consecutive tool calls into a single summary
        // so the dropdown shows one compact line per "thinking burst"
        // instead of one chip per call.
        const compactedItems: ThinkingItem[] = [];
        let toolRun: ToolPart[] = [];
        let toolRunKey: string | null = null;
        const flushToolRun = () => {
            if (toolRun.length === 0) return;
            compactedItems.push({
                kind: "tool-run",
                key: toolRunKey ?? `tool-run-${compactedItems.length}`,
                tools: toolRun,
            });
            toolRun = [];
            toolRunKey = null;
        };
        for (const raw of rawItems) {
            if (raw.kind === "tool") {
                toolRunKey ??= `tool-run-${raw.key}`;
                toolRun.push(raw.part);
                continue;
            }
            flushToolRun();
            compactedItems.push(raw);
        }
        flushToolRun();

        return {
            markdownContent: normalizeLatexDelimitersForMarkdown(markdown),
            citations: citationOrder,
            citationBySourceId,
            citationIndexBySourceId: sourceIndexMap,
            thinkingItems: compactedItems,
        };
    }, [parts, isStreaming]);

    const activeCitationIndex = activeCitationSourceId
        ? citationIndexBySourceId.get(activeCitationSourceId)
        : undefined;
    const activeCitation = activeCitationSourceId ? citationBySourceId.get(activeCitationSourceId) : undefined;
    const citationSourceIds = React.useMemo(() => [...citationBySourceId.keys()], [citationBySourceId]);

    React.useEffect(() => {
        if (!projectId || citationSourceIds.length <= 1) {
            return;
        }

        const uncachedSourceIds = citationSourceIds.filter(
            (sourceId) => !queryClient.getQueryData(sourceReferenceQueryKey(projectId, sourceId))
        );
        if (uncachedSourceIds.length === 0) {
            return;
        }

        let cancelled = false;
        void fetchSourceReferences(apiClient, projectId, uncachedSourceIds)
            .then((references) => {
                if (cancelled) {
                    return;
                }

                for (const reference of references.items) {
                    queryClient.setQueryData(sourceReferenceQueryKey(projectId, reference.source_id), reference, {
                        updatedAt: Date.now(),
                    });
                }
            })
            .catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [apiClient, citationSourceIds, projectId, queryClient]);

    React.useEffect(() => {
        if (activeCitationSourceId && (activeCitationIndex === undefined || !activeCitation)) {
            setActiveCitationSourceId(null);
        }
    }, [activeCitation, activeCitationIndex, activeCitationSourceId]);

    const shouldSkipBadgeRecursion = (node: React.ReactElement): boolean => {
        const type = typeof node.type === "string" ? node.type : undefined;
        if (type === "code" || type === "pre") return true;
        const props = node.props as { className?: string };
        const className = props.className;
        return typeof className === "string" && className.includes("katex");
    };

    const injectBadges = (children: React.ReactNode): React.ReactNode => {
        let matchCounter = 0;

        const processNode = (node: React.ReactNode): React.ReactNode => {
            if (typeof node === "string") {
                const parts: React.ReactNode[] = [];
                let lastIndex = 0;
                let match: RegExpExecArray | null;
                const regex = new RegExp(REFERENCE_PATTERN);

                while ((match = regex.exec(node)) !== null) {
                    if (match.index > lastIndex) {
                        parts.push(node.slice(lastIndex, match.index));
                    }

                    const sourceId = match[1]!;
                    const citationIndex = citationIndexBySourceId.get(sourceId);
                    const citation = citationIndex === undefined ? undefined : citations[citationIndex];

                    if (citation && citationIndex !== undefined) {
                        parts.push(
                            <TextReferenceBadge
                                key={`ref-${sourceId}-${matchCounter++}`}
                                citation={citation}
                                index={citationIndex}
                                onSelect={() => setActiveCitationSourceId(sourceId)}
                            />
                        );
                    } else {
                        parts.push(match[0]);
                    }

                    lastIndex = match.index + match[0].length;
                }

                if (lastIndex < node.length) {
                    parts.push(node.slice(lastIndex));
                }

                return parts.length ? parts : node;
            }

            if (React.isValidElement(node)) {
                if (shouldSkipBadgeRecursion(node)) return node;
                const childProps = (node.props ?? {}) as { children?: React.ReactNode };
                if (!childProps.children) return node;
                return React.cloneElement(
                    node as React.ReactElement,
                    undefined,
                    React.Children.map(childProps.children, processNode)
                );
            }

            if (Array.isArray(node)) {
                return node.map(processNode);
            }

            return node;
        };

        return React.Children.map(children, processNode);
    };

    const handleFileDownload = async (citation: ResolvedCitationFence) => {
        if (!projectId) return;

        try {
            await openCitationSourceFile(apiClient, projectId, citation);
        } catch (error) {
            console.error("Error opening file:", error);
        }
    };

    const sourceFileCitations = React.useMemo(() => buildSourceFileCitations(citations), [citations]);

    const hasText = markdownContent.trim().length > 0;

    const renderMarkdown = (content: string) => (
        <div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto text-sm text-foreground [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[
                    [
                        rehypeKatex,
                        {
                            strict: false,
                            throwOnError: false,
                        },
                    ],
                ]}
                components={{
                    p: ({ children }) => <p>{injectBadges(children)}</p>,
                    ul: ({ children }) => <ul className="my-2 list-disc pl-6">{injectBadges(children)}</ul>,
                    ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{injectBadges(children)}</ol>,
                    li: ({ children }) => <li className="my-1">{injectBadges(children)}</li>,
                    blockquote: ({ children }) => (
                        <blockquote className="my-3 border-l-4 pl-3 text-muted-foreground">
                            {injectBadges(children)}
                        </blockquote>
                    ),
                    strong: ({ children }) => <strong>{injectBadges(children)}</strong>,
                    em: ({ children }) => <em className="italic">{injectBadges(children)}</em>,
                    del: ({ children }) => <del>{injectBadges(children)}</del>,
                    a: ({ children }) => <>{injectBadges(children)}</>,
                    h1: ({ children }) => (
                        <h1 className="mb-2 mt-4 text-2xl font-semibold">{injectBadges(children)}</h1>
                    ),
                    h2: ({ children }) => (
                        <h2 className="mb-2 mt-4 text-xl font-semibold">{injectBadges(children)}</h2>
                    ),
                    h3: ({ children }) => (
                        <h3 className="mb-1.5 mt-3 text-lg font-medium">{injectBadges(children)}</h3>
                    ),
                    h4: ({ children }) => (
                        <h4 className="mb-1.5 mt-3 text-base font-medium">{injectBadges(children)}</h4>
                    ),
                    h5: ({ children }) => (
                        <h5 className="mb-1 mt-2 text-sm font-medium">{injectBadges(children)}</h5>
                    ),
                    h6: ({ children }) => (
                        <h6 className="mb-1 mt-2 text-xs font-medium uppercase tracking-wide">
                            {injectBadges(children)}
                        </h6>
                    ),
                    hr: () => null,
                    table: ({ children }) => (
                        <table className="not-prose w-full table-fixed border-collapse">{children}</table>
                    ),
                    thead: ({ children }) => <thead className="bg-muted/30">{children}</thead>,
                    tbody: ({ children }) => <tbody>{children}</tbody>,
                    tr: ({ children }) => <tr>{children}</tr>,
                    td: ({ children }) => (
                        <td className="border border-border px-3 py-2 align-top">{injectBadges(children)}</td>
                    ),
                    th: ({ children }) => (
                        <th className="border border-border px-3 py-2 text-left font-medium">
                            {injectBadges(children)}
                        </th>
                    ),
                    code: ({ children }) => <code>{children}</code>,
                    pre: ({ children }) => <pre>{children}</pre>,
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );

    const renderThinkingBody = () =>
        thinkingItems.map((item) =>
            item.kind === "interim-text" ? (
                <div key={item.key}>{renderMarkdown(item.markdown)}</div>
            ) : (
                <ToolRunSummary key={item.key} tools={item.tools} />
            )
        );

    const hasThinkingBody = thinkingItems.length > 0;
    const thinkingSlot = hasThinkingBody ? (
        <ThinkingDropdown isStreaming={isStreaming} durationMs={durationMs} startedAtMs={startedAtMs}>
            {renderThinkingBody()}
        </ThinkingDropdown>
    ) : isStreaming ? (
        <div className="text-sm text-muted-foreground">{t("step.thinking")}</div>
    ) : null;

    return (
        <div className="flex flex-col gap-3 leading-relaxed">
            {thinkingSlot}
            {hasText && renderMarkdown(markdownContent)}

            {sourceFileCitations.length > 0 && (
                <div className="border-t border-border/50 pt-3">
                    <div className="mb-2 text-sm text-muted-foreground">Quellen:</div>
                    <div className="flex flex-wrap gap-2">
                        {sourceFileCitations.map((sourceFile) => (
                            <Button
                                key={sourceFile.key}
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 px-2 py-1 text-xs"
                                aria-label={sourceFile.accessibleLabel}
                                onClick={() => handleFileDownload(sourceFile.citation)}
                            >
                                <FileText className="h-3 w-3" />
                                <span>{sourceFile.fileName}</span>
                                {sourceFile.pageLabel !== null && (
                                    <Badge
                                        variant="secondary"
                                        aria-hidden="true"
                                        className="px-1 py-0 text-[0.625rem] font-normal"
                                    >
                                        {sourceFile.pageLabel}
                                    </Badge>
                                )}
                            </Button>
                        ))}
                    </div>
                </div>
            )}

            {activeCitation && activeCitationIndex !== undefined && (
                <TextReferenceDialog
                    citation={activeCitation}
                    index={activeCitationIndex}
                    projectId={projectId}
                    open
                    onOpenChange={(open) => {
                        if (!open) {
                            setActiveCitationSourceId(null);
                        }
                    }}
                />
            )}
        </div>
    );
}
