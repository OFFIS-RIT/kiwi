"use client";

import Mention from "@tiptap/extension-mention";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { RefObject } from "react";
import { FileBadge } from "./FileBadge";
import type { FileMentionItem, FileMentionListHandle } from "./FileMentionList";

export type FileMentionAttrs = {
    id: string | null;
    label: string | null;
};

export type SuggestionData = {
    open: boolean;
    items: FileMentionItem[];
    command: (attrs: { id: string; label: string }) => void;
    clientRect: (() => DOMRect | null) | null;
};

export const closedSuggestionData: SuggestionData = {
    open: false,
    items: [],
    command: () => {},
    clientRect: null,
};

export type CreateFileMentionOptions = {
    /** Returns the filtered file list for the given query string. */
    getItems: (query: string) => FileMentionItem[];
    /** Updates the popover state in the parent React tree. */
    setSuggestionData: (data: SuggestionData) => void;
    /** Ref to the popover so we can forward keyboard events into it. */
    listRef: RefObject<FileMentionListHandle | null>;
};

type MentionAttrs = { id: string; label: string };
type MentionSuggestionProps = SuggestionProps<FileMentionItem, MentionAttrs>;

/**
 * Renders a single mention node as an inline `Badge` (icon + filename).
 * The node is atomic, so the caret navigates over it as a single unit and
 * Backspace right after it deletes it whole.
 */
function FileMentionView({ node }: ReactNodeViewProps) {
    const label = (node.attrs as FileMentionAttrs).label ?? "";

    return (
        <NodeViewWrapper as="span" className="inline-flex align-middle" data-mention="file">
            <FileBadge label={label} />
        </NodeViewWrapper>
    );
}

/**
 * Build the configured Mention extension. The suggestion lifecycle pushes
 * popover state into the parent React tree (so providers like LanguageProvider
 * remain accessible), and forwards keyboard events to the popover via
 * `options.listRef`.
 */
export function createFileMention(options: CreateFileMentionOptions) {
    return Mention.extend({
        name: "fileMention",
        // The default Mention extension's `renderText()` produces "@label" — we
        // only want the bare filename to flow into the message body.
        renderText({ node }) {
            return (node.attrs as FileMentionAttrs).label ?? "";
        },
        // React-rendered NodeView so the inline atom is a styled <Badge>.
        addNodeView() {
            return ReactNodeViewRenderer(FileMentionView);
        },
    }).configure({
        HTMLAttributes: {
            "data-mention": "file",
        },
        deleteTriggerWithBackspace: false,
        suggestion: {
            char: "@",
            allowSpaces: false,
            items: ({ query }) => options.getItems(query),
            command: ({ editor, range, props }) => {
                editor
                    .chain()
                    .focus()
                    .insertContentAt(range, [
                        {
                            type: "fileMention",
                            attrs: { id: props.id, label: props.label },
                        },
                        { type: "text", text: " " },
                    ])
                    .run();
            },
            render: () => ({
                onStart: (props: MentionSuggestionProps) => {
                    options.setSuggestionData({
                        open: true,
                        items: props.items,
                        command: props.command,
                        clientRect: props.clientRect ?? null,
                    });
                },
                onUpdate: (props: MentionSuggestionProps) => {
                    options.setSuggestionData({
                        open: true,
                        items: props.items,
                        command: props.command,
                        clientRect: props.clientRect ?? null,
                    });
                },
                onKeyDown: (props: SuggestionKeyDownProps) => {
                    if (props.event.key === "Escape") {
                        options.setSuggestionData(closedSuggestionData);
                        return true;
                    }
                    return options.listRef.current?.onKeyDown(props.event) ?? false;
                },
                onExit: () => {
                    options.setSuggestionData(closedSuggestionData);
                },
            }),
        },
    });
}

export type { FileMentionItem };
