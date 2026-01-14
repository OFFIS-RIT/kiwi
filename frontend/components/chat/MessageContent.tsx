"use client";

import { Button } from "@/components/ui/button";
import { downloadProjectFile } from "@/lib/api/projects";
import { FileText } from "lucide-react";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TextReferenceBadge } from "./TextReferenceBadge";
import { ThinkingDropdown } from "./ThinkingDropdown";

type MessageContentProps = {
  content: string;
  reasoning?: string;
  projectId?: string;
  sourceFiles?: { id: string; name: string; key: string }[];
};

export function MessageContent({
  content,
  reasoning,
  projectId,
  sourceFiles = [],
}: MessageContentProps) {
  const referencePattern = React.useMemo(() => /\[\[([a-zA-Z0-9_-]+)\]\]/g, []);

  const createReferenceMapping = React.useMemo(() => {
    const foundReferences: string[] = [];
    const matches = content.matchAll(new RegExp(referencePattern, "g"));

    for (const match of matches) {
      const id = match[1];
      if (!foundReferences.includes(id)) {
        foundReferences.push(id);
      }
    }

    const mapping = new Map<string, number>();
    foundReferences.forEach((id, index) => {
      mapping.set(id, index);
    });

    return mapping;
  }, [content, referencePattern]);

  const injectBadges = (children: React.ReactNode): React.ReactNode => {
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
          const id = match[1];
          const idx = createReferenceMapping.get(id) ?? 0;
          parts.push(
            <TextReferenceBadge
              key={`ref-${id}-${idx}`}
              referenceId={id}
              index={idx}
              projectId={projectId}
            />
          );
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < node.length) {
          parts.push(node.slice(lastIndex));
        }
        return parts.length ? parts : node;
      }
      if (React.isValidElement(node)) {
        const type = node.type as unknown as string;
        if (type === "code" || type === "pre") return node;
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

  const handleFileDownload = async (fileName: string, fileKey: string) => {
    if (!projectId) return;

    try {
      const downloadUrl = await downloadProjectFile(projectId, fileKey);
      window.open(downloadUrl, "_blank");
    } catch (error) {
      console.error("Fehler beim Öffnen der Datei:", error);
    }
  };

  const uniqueSourceFiles = sourceFiles.reduce(
    (unique, file) => {
      const existingFile = unique.find((f) => f.key === file.key);
      if (!existingFile) {
        unique.push(file);
      }
      return unique;
    },
    [] as typeof sourceFiles
  );

  return (
    <div className="leading-relaxed">
      {reasoning && (
        <div className="mb-3">
          <ThinkingDropdown reasoning={reasoning} />
        </div>
      )}
      <div className="mb-3 prose prose-sm dark:prose-invert max-w-none overflow-x-auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p>{injectBadges(children)}</p>,
            ul: ({ children }) => (
              <ul className="list-disc pl-6 my-2">{injectBadges(children)}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal pl-6 my-2">
                {injectBadges(children)}
              </ol>
            ),
            li: ({ children }) => (
              <li className="my-1">{injectBadges(children)}</li>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 pl-3 my-3 text-muted-foreground">
                {injectBadges(children)}
              </blockquote>
            ),
            strong: ({ children }) => <strong>{injectBadges(children)}</strong>,
            em: ({ children }) => (
              <em className="italic">{injectBadges(children)}</em>
            ),
            del: ({ children }) => <del>{injectBadges(children)}</del>,
            a: ({ children }) => <>{injectBadges(children)}</>,
            h1: ({ children }) => (
              <h1 className="mt-4 mb-2 text-2xl font-semibold">
                {injectBadges(children)}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mt-4 mb-2 text-xl font-semibold">
                {injectBadges(children)}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mt-3 mb-1.5 text-lg font-medium">
                {injectBadges(children)}
              </h3>
            ),
            h4: ({ children }) => (
              <h4 className="mt-3 mb-1.5 text-base font-medium">
                {injectBadges(children)}
              </h4>
            ),
            h5: ({ children }) => (
              <h5 className="mt-2 mb-1 text-sm font-medium">
                {injectBadges(children)}
              </h5>
            ),
            h6: ({ children }) => (
              <h6 className="mt-2 mb-1 text-xs font-medium uppercase tracking-wide">
                {injectBadges(children)}
              </h6>
            ),
            hr: () => null,
            table: ({ children }) => (
              <table className="not-prose w-full border-collapse table-fixed">
                {children}
              </table>
            ),
            thead: ({ children }) => (
              <thead className="bg-muted/30">{children}</thead>
            ),
            tbody: ({ children }) => <tbody>{children}</tbody>,
            tr: ({ children }) => <tr className="">{children}</tr>,
            td: ({ children }) => (
              <td className="border border-border px-3 py-2 align-top">
                {injectBadges(children)}
              </td>
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

      {uniqueSourceFiles.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/50">
          <div className="text-sm text-muted-foreground mb-2">Quellen:</div>
          <div className="flex flex-wrap gap-2">
            {uniqueSourceFiles.map((file) => (
              <Button
                key={file.id}
                variant="outline"
                size="sm"
                className="h-7 px-2 py-1 text-xs"
                onClick={() => handleFileDownload(file.name, file.key)}
              >
                <FileText className="h-3 w-3 mr-1" />
                {file.name}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
