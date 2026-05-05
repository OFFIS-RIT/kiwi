"use client";

import { fetchProjectFiles } from "@/lib/api/projects";
import { cn } from "@/lib/utils";
import type { ApiProjectFile } from "@/types/api";
import { useQuery } from "@tanstack/react-query";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isMentionableFile } from "./FileBadge";
import { FileMentionList, type FileMentionItem, type FileMentionListHandle } from "./FileMentionList";
import { closedSuggestionData, createFileMention, type SuggestionData } from "./FileMentionNode";
import { InterimDecoration, interimDecorationKey } from "./InterimDecorationExtension";

export type ChatInputHandle = {
    /** Replace the editor content with `text`. By default this fires `onChange`; pass `silent` to skip. */
    setText: (text: string, options?: { silent?: boolean }) => void;
    /**
     * Append `text` to the end of the editor's content without touching any
     * existing nodes. Use this to commit speech transcripts so file-mention
     * badges aren't replaced by a plain-text re-parse.
     */
    appendText: (text: string, options?: { withSpace?: boolean }) => void;
    /** Move keyboard focus into the editor. */
    focus: () => void;
};

export type ChatInputProps = {
    /** Plain-text value mirrored back from the editor (mentions serialize to their label). */
    value: string;
    /** Fires on every document change with the current plain text. */
    onChange: (text: string) => void;
    /** Fires on Enter (without Shift) when no mention popover is open. */
    onSubmit: () => void;
    /** Disables editing (e.g. while recording or while a clarification is pending). */
    disabled?: boolean;
    /** Placeholder text shown when the editor is empty. */
    placeholder: string;
    /** Project whose files back the @-mention picker. */
    projectId: string;
    /**
     * Live (non-final) speech-to-text preview. Rendered as a muted overlay
     * below the editor — the editor document itself is never mutated, so
     * mention-badge nodes are preserved while recording.
     */
    interimTranscript?: string;
};

export const projectFilesQueryKey = (projectId: string) => ["projectFiles", projectId] as const;

/**
 * Single-line chat input backed by TipTap. Renders @-file mentions as inline
 * `Badge` nodes (icon + filename) that the caret navigates over as a single
 * unit and that Backspace deletes whole. `editor.getText()` serializes those
 * nodes back to their bare filename, so the message body that flows to the
 * backend remains plain text.
 *
 * The mention suggestion popover is rendered inside this component's own
 * React tree (via `createPortal` to `document.body`) so it inherits all
 * surrounding providers — `LanguageProvider`, query client, theme, etc.
 */
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
    { value, onChange, onSubmit, disabled = false, placeholder, projectId, interimTranscript },
    ref
) {
    // Keep the latest file list and loading flag accessible to the mention
    // extension's closures without recreating the editor on every render.
    const filesRef = useRef<ApiProjectFile[]>([]);
    const lastEmittedRef = useRef("");
    const suggestionOpenRef = useRef(false);
    const onSubmitRef = useRef(onSubmit);
    const onChangeRef = useRef(onChange);
    const listRef = useRef<FileMentionListHandle | null>(null);
    const [suggestion, setSuggestion] = useState<SuggestionData>(closedSuggestionData);
    /**
     * Position of the popover anchored above the caret. We use `bottom`
     * (distance from viewport bottom to popover bottom) so the popover always
     * sits above the caret regardless of its own height — no measurement of
     * the popover after render is required.
     */
    const [popoverPos, setPopoverPos] = useState<{ bottom: number; left: number } | null>(null);

    useEffect(() => {
        onSubmitRef.current = onSubmit;
    }, [onSubmit]);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        suggestionOpenRef.current = suggestion.open;
    }, [suggestion.open]);

    const { data: files, isLoading } = useQuery({
        queryKey: projectFilesQueryKey(projectId),
        queryFn: () => fetchProjectFiles(projectId),
        staleTime: 30_000,
    });

    useEffect(() => {
        filesRef.current = files ?? [];
    }, [files]);

    // Build the configured Mention extension once. The closures read from refs
    // and from React state setters so the extension always sees current data
    // without being recreated.
    const fileMention = useMemo(
        () =>
            createFileMention({
                getItems: (query) => {
                    const haystack = filesRef.current.filter(isMentionableFile);
                    const trimmed = query.trim().toLowerCase();
                    const filtered = trimmed
                        ? haystack.filter((file) => file.name.toLowerCase().includes(trimmed))
                        : haystack;
                    return filtered.map<FileMentionItem>((file) => ({
                        id: file.id,
                        label: file.name,
                        file,
                    }));
                },
                setSuggestionData: setSuggestion,
                listRef,
            }),
        []
    );

    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                heading: false,
                blockquote: false,
                bulletList: false,
                orderedList: false,
                listItem: false,
                codeBlock: false,
                code: false,
                horizontalRule: false,
                strike: false,
                hardBreak: false,
            }),
            Placeholder.configure({ placeholder }),
            InterimDecoration,
            fileMention,
        ],
        editorProps: {
            attributes: {
                class: cn(
                    "tiptap-chat-input flex-1 resize-none overflow-y-auto border-input min-h-10 max-h-[15lh] w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
                    disabled && "pointer-events-none cursor-not-allowed opacity-50"
                ),
            },
            handleKeyDown: (_view, event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                    if (suggestionOpenRef.current) return false;
                    event.preventDefault();
                    onSubmitRef.current();
                    return true;
                }
                return false;
            },
        },
        onUpdate: ({ editor: ed }) => {
            const text = ed.getText({ blockSeparator: "\n" });
            lastEmittedRef.current = text;
            onChangeRef.current(text);
        },
        immediatelyRender: false,
        editable: !disabled,
        content: value,
    });

    // Toggle editability whenever `disabled` changes.
    useEffect(() => {
        if (!editor) return;
        if (editor.isEditable === !disabled) return;
        editor.setEditable(!disabled);
    }, [editor, disabled]);

    // Push the live (non-final) speech transcript into the decoration plugin
    // so it renders as a transient widget at the end of the doc — without
    // mutating the document, so mention badges stay intact.
    useEffect(() => {
        if (!editor) return;
        const text = interimTranscript ?? "";
        editor.view.dispatch(editor.state.tr.setMeta(interimDecorationKey, text));
    }, [editor, interimTranscript]);

    // Sync external `value` changes into the editor. We compare against the
    // last emission so the round-trip (editor → onChange → state → value prop)
    // doesn't trigger a redundant setContent that would clobber mention nodes.
    useEffect(() => {
        if (!editor) return;
        if (value === lastEmittedRef.current) return;
        // emitUpdate=false so we don't bounce back through onChange.
        editor.commands.setContent(value, { emitUpdate: false });
        lastEmittedRef.current = value;
    }, [editor, value]);

    // Recompute popover position whenever the suggestion state changes (caret
    // moves, query updates) and on scroll/resize while open. The popover
    // always opens upward — its bottom edge is anchored just above the caret.
    const { open: suggestionOpen, clientRect: suggestionClientRect, items: suggestionItems } = suggestion;
    useEffect(() => {
        if (!suggestionOpen || !suggestionClientRect) {
            setPopoverPos(null);
            return;
        }
        const recompute = () => {
            const rect = suggestionClientRect();
            if (!rect) return;
            setPopoverPos({ bottom: window.innerHeight - rect.top + 12, left: rect.left });
        };
        recompute();
        window.addEventListener("scroll", recompute, true);
        window.addEventListener("resize", recompute);
        return () => {
            window.removeEventListener("scroll", recompute, true);
            window.removeEventListener("resize", recompute);
        };
    }, [suggestionOpen, suggestionClientRect, suggestionItems]);

    useImperativeHandle(ref, () => ({
        setText: (text, options) => {
            if (!editor) return;
            const shouldEmit = !options?.silent;
            editor.commands.setContent(text, { emitUpdate: shouldEmit });
            if (!shouldEmit) {
                // Keep our internal mirror in sync so the next external `value`
                // change is detected correctly.
                lastEmittedRef.current = text;
            }
        },
        appendText: (text, options) => {
            if (!editor) return;
            // Insert at the end of the last block so existing structure
            // (paragraphs, mention atoms) stays untouched. content.size is the
            // doc-end position; subtracting 1 lands inside the final block.
            const docSize = editor.state.doc.content.size;
            const insertPos = Math.max(docSize - 1, 0);
            let insertion = text;
            if (options?.withSpace) {
                const current = editor.getText({ blockSeparator: "\n" });
                if (current && !/\s$/.test(current)) {
                    insertion = ` ${text}`;
                }
            }
            editor.commands.insertContentAt(insertPos, insertion);
        },
        focus: () => {
            editor?.commands.focus();
        },
    }));

    return (
        <>
            <EditorContent editor={editor} className="flex-1 min-w-0" />
            {suggestion.open &&
                popoverPos &&
                typeof window !== "undefined" &&
                createPortal(
                    <div
                        style={{
                            position: "fixed",
                            bottom: popoverPos.bottom,
                            left: popoverPos.left,
                            zIndex: 50,
                        }}
                    >
                        <FileMentionList
                            ref={listRef}
                            items={suggestion.items}
                            loading={isLoading && suggestion.items.length === 0}
                            command={suggestion.command}
                        />
                    </div>,
                    document.body
                )}
        </>
    );
});

export type { Editor };
