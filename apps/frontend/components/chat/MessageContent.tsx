"use client";

import { Button } from "@/components/ui/button";
import { downloadProjectFile } from "@/lib/api/projects";
import { normalizeLatexDelimitersForMarkdown } from "@/lib/latex-math";
import type { ChatUIMessage, CitationPartData } from "@kiwi/ai/ui";
import { FileText } from "lucide-react";
import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { TextReferenceBadge } from "./TextReferenceBadge";
import { ThinkingDropdown } from "./ThinkingDropdown";

type MessageContentProps = {
    parts: ChatUIMessage["parts"];
    projectId?: string;
};

export function MessageContent({ parts, projectId }: MessageContentProps) {
    const referencePattern = React.useMemo(() => /\[\[cite:([a-zA-Z0-9_-]+)\]\]/g, []);

    const { markdownContent, reasoning, citations } = React.useMemo(() => {
        const citationOrder: CitationPartData[] = [];
        const citationMap = new Map<string, number>();
        let markdown = "";
        let reasoningText = "";

        for (const part of parts) {
            switch (part.type) {
                case "text":
                    markdown += part.text;
                    break;
                case "reasoning":
                    reasoningText += part.text;
                    break;
                case "data-citation": {
                    const existingIndex = citationMap.get(part.data.sourceId);
                    if (existingIndex === undefined) {
                        citationMap.set(part.data.sourceId, citationOrder.length);
                        citationOrder.push(part.data);
                    }
                    markdown += `[[cite:${part.data.sourceId}]]`;
                    break;
                }
            }
        }

        return {
            markdownContent: normalizeLatexDelimitersForMarkdown(markdown),
            reasoning: reasoningText || undefined,
            citations: citationOrder,
        };
    }, [parts]);

    const citationIndexMap = React.useMemo(() => {
        return new Map(citations.map((citation, index) => [citation.sourceId, index]));
    }, [citations]);

    const shouldSkipBadgeRecursion = (node: React.ReactElement): boolean => {
        const type = node.type as unknown as string;
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
                const regex = new RegExp(referencePattern);

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
                                projectId={projectId}
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
    }, [] as CitationPartData[]);

    return (
        <div className="leading-relaxed">
            {reasoning && (
                <div className="mb-3">
                    <ThinkingDropdown reasoning={reasoning} />
                </div>
            )}
            <div className="mb-3 max-w-none overflow-x-auto prose prose-sm dark:prose-invert [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
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

            {uniqueSourceFiles.length > 0 && (
                <div className="mt-3 border-t border-border/50 pt-3">
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
        </div>
    );
}
