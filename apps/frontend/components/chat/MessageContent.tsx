"use client";

import { Button } from "@/components/ui/button";
import { downloadProjectFile } from "@/lib/api/projects";
import { normalizeLatexDelimitersForMarkdown } from "@/lib/latex-math";
import { useLanguage } from "@/providers/LanguageProvider";
import { isResolvedCitationFence, splitTextWithCitationFences, type ResolvedCitationFence } from "@kiwi/ai/citation";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { AlertTriangle, Check, FileText, Loader2, Wrench } from "lucide-react";
import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { TextReferenceBadge, TextReferenceDialog } from "./TextReferenceBadge";
import { ThinkingDropdown } from "./ThinkingDropdown";

type MessageContentProps = {
    parts: ChatUIMessage["parts"];
    projectId?: string;
    /** Set to true for the currently-streaming assistant message to enable
     *  the pre-text UI phases (inline "thinking..." label, tool-call label). */
    isStreaming?: boolean;
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

function ToolCallChip({ part }: { part: ToolPart }) {
    const { t } = useLanguage();
    const name = toolNameOf(part);
    const label = t(`step.${name}`);

    const isRunning = part.state === "input-streaming" || part.state === "input-available";
    const isError = part.state === "output-error";
    const isDone = part.state === "output-available";

    const tone = isError
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border/60 bg-muted/30 text-muted-foreground";

    return (
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${tone}`} title={name}>
            {isError ? (
                <AlertTriangle className="h-3 w-3" />
            ) : isRunning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
            ) : isDone ? (
                <Check className="h-3 w-3" />
            ) : (
                <Wrench className="h-3 w-3" />
            )}
            <span>{label}</span>
        </span>
    );
}

type ThinkingItem = { kind: "reasoning"; key: string; text: string } | { kind: "tool"; key: string; part: ToolPart };

export function MessageContent({ parts, projectId, isStreaming = false }: MessageContentProps) {
    const { t } = useLanguage();
    const [activeCitationSourceId, setActiveCitationSourceId] = React.useState<string | null>(null);

    const { markdownContent, citations, thinkingItems } = React.useMemo(() => {
        const citationOrder: ResolvedCitationFence[] = [];
        const seenCitationIds = new Set<string>();
        const items: ThinkingItem[] = [];
        let markdown = "";
        let reasoningIndex = 0;

        for (const part of parts) {
            if (isToolPart(part)) {
                // Clarification tool parts are rendered by ClarificationBlock
                // outside of the thinking dropdown, so skip them here.
                if (toolNameOf(part) === "ask_clarifying_questions") continue;
                items.push({ kind: "tool", key: part.toolCallId, part });
                continue;
            }

            switch (part.type) {
                case "text": {
                    for (const segment of splitTextWithCitationFences(part.text)) {
                        if (segment.type === "text") {
                            markdown += segment.text;
                            continue;
                        }

                        if (!isResolvedCitationFence(segment.citation)) {
                            markdown += segment.raw;
                            continue;
                        }

                        if (!seenCitationIds.has(segment.citation.sourceId)) {
                            seenCitationIds.add(segment.citation.sourceId);
                            citationOrder.push(segment.citation);
                        }
                        markdown += `[[cite:${segment.citation.sourceId}]]`;
                    }
                    break;
                }
                case "reasoning":
                    items.push({
                        kind: "reasoning",
                        key: `reasoning-${reasoningIndex++}`,
                        text: part.text,
                    });
                    break;
            }
        }

        return {
            markdownContent: normalizeLatexDelimitersForMarkdown(markdown),
            citations: citationOrder,
            thinkingItems: items,
        };
    }, [parts]);

    const citationIndexMap = React.useMemo(() => {
        return new Map(citations.map((citation, index) => [citation.sourceId, index]));
    }, [citations]);

    const activeCitationIndex = activeCitationSourceId ? citationIndexMap.get(activeCitationSourceId) : undefined;
    const activeCitation = activeCitationIndex === undefined ? undefined : citations[activeCitationIndex];

    React.useEffect(() => {
        if (activeCitationSourceId && activeCitationIndex === undefined) {
            setActiveCitationSourceId(null);
        }
    }, [activeCitationIndex, activeCitationSourceId]);

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
                    const citationIndex = citationIndexMap.get(sourceId);
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

    const handleFileDownload = async (fileKey: string) => {
        if (!projectId) return;

        try {
            const downloadUrl = await downloadProjectFile(projectId, fileKey);
            window.open(downloadUrl, "_blank");
        } catch (error) {
            console.error("Error opening file:", error);
        }
    };

    const uniqueSourceFiles = citations.reduce((unique, citation) => {
        const existingFile = unique.find((file) => file.fileKey === citation.fileKey);
        if (!existingFile) {
            unique.push(citation);
        }
        return unique;
    }, [] as ResolvedCitationFence[]);

    const hasText = markdownContent.trim().length > 0;
    const toolThinkingItems = thinkingItems.filter(
        (item): item is Extract<ThinkingItem, { kind: "tool" }> => item.kind === "tool"
    );
    // Surface the most recent tool as the live label – even once it has
    // completed – so the indicator stays anchored on that tool until the next
    // one starts instead of flickering back to a generic "thinking" label
    // between calls. While the model is deciding the next step, the spinner
    // still correctly conveys "working", and the label names the most recent
    // concrete action.
    const liveToolItem = toolThinkingItems.at(-1);
    const liveToolLabel = liveToolItem ? t(`step.${toolNameOf(liveToolItem.part)}`) : undefined;

    const renderThinkingBody = () =>
        thinkingItems.map((item) =>
            item.kind === "reasoning" ? (
                <p key={item.key} className="whitespace-pre-wrap italic">
                    {item.text}
                </p>
            ) : (
                <div key={item.key}>
                    <ToolCallChip part={item.part} />
                </div>
            )
        );

    // Live phase: still streaming, no assistant text yet → collapsible dropdown.
    //   Label falls back from the running tool's name to a generic "thinking"
    //   message so the control is present from the first frame after send.
    // Settled phase: message has text OR is historical → default reasoning dropdown.
    //   Only rendered when there's actually something to reveal.
    let thinkingSlot: React.ReactNode = null;
    if (isStreaming && !hasText) {
        thinkingSlot = (
            <ThinkingDropdown isLive label={liveToolLabel ?? t("thinking.processing")}>
                {renderThinkingBody()}
            </ThinkingDropdown>
        );
    } else if (thinkingItems.length > 0) {
        thinkingSlot = <ThinkingDropdown>{renderThinkingBody()}</ThinkingDropdown>;
    }

    return (
        <div className="flex flex-col gap-3 leading-relaxed">
            {thinkingSlot}
            {hasText && (
                <div className="max-w-none overflow-x-auto prose prose-sm dark:prose-invert [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
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
                        {markdownContent}
                    </ReactMarkdown>
                </div>
            )}

            {uniqueSourceFiles.length > 0 && (
                <div className="border-t border-border/50 pt-3">
                    <div className="mb-2 text-sm text-muted-foreground">Quellen:</div>
                    <div className="flex flex-wrap gap-2">
                        {uniqueSourceFiles.map((citation) => (
                            <Button
                                key={citation.sourceId}
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 py-1 text-xs"
                                onClick={() => handleFileDownload(citation.fileKey)}
                            >
                                <FileText className="mr-1 h-3 w-3" />
                                {citation.fileName}
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
