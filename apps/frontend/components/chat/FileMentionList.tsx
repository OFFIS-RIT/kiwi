"use client";

import { useLanguage } from "@/providers/LanguageProvider";
import type { ApiProjectFile } from "@/types/api";
import { FileText } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type FileMentionItem = {
    id: string;
    label: string;
    file: ApiProjectFile;
};

export type FileMentionListProps = {
    items: FileMentionItem[];
    loading: boolean;
    command: (attrs: { id: string; label: string }) => void;
};

export type FileMentionListHandle = {
    onKeyDown: (event: KeyboardEvent) => boolean;
};

/**
 * Popover list rendered inside the TipTap mention `suggestion.render()` lifecycle.
 *
 * The suggestion plugin forwards the editor's keydown events to this component
 * via the imperative `onKeyDown` handle. Returning `true` consumes the event so
 * the editor doesn't handle it (e.g. inserting a newline on Enter).
 */
export const FileMentionList = forwardRef<FileMentionListHandle, FileMentionListProps>(function FileMentionList(
    { items, loading, command },
    ref
) {
    const { t } = useLanguage();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        setSelectedIndex(0);
        // Trim trailing slots from the previous render so the array length
        // tracks the current list length. React clears unmounted slots to
        // null via the callback refs, so this is hygiene rather than a leak
        // fix — but it makes the intent obvious to future readers.
        itemRefs.current.length = items.length;
    }, [items]);

    useEffect(() => {
        const node = itemRefs.current[selectedIndex];
        node?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const selectItem = (index: number) => {
        const item = items[index];
        if (!item) return;
        command({ id: item.id, label: item.label });
    };

    useImperativeHandle(ref, () => ({
        onKeyDown: (event: KeyboardEvent) => {
            if (event.key === "ArrowUp") {
                setSelectedIndex((current) => (items.length === 0 ? 0 : (current - 1 + items.length) % items.length));
                return true;
            }
            if (event.key === "ArrowDown") {
                setSelectedIndex((current) => (items.length === 0 ? 0 : (current + 1) % items.length));
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                if (items.length === 0) return false;
                selectItem(selectedIndex);
                return true;
            }
            return false;
        },
    }));

    return (
        <div className="z-50 w-max max-w-[min(90vw,32rem)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
            <div className="max-h-[16.5rem] overflow-y-auto p-1" style={{ scrollbarWidth: "thin" }}>
                {loading && <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("mention.loading")}</div>}
                {!loading && items.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("mention.no.files")}</div>
                )}
                {!loading &&
                    items.map((item, index) => (
                        <button
                            key={item.id}
                            type="button"
                            ref={(node) => {
                                itemRefs.current[index] = node;
                            }}
                            onMouseEnter={() => setSelectedIndex(index)}
                            onMouseDown={(event) => {
                                // Use mousedown so the editor never loses focus before the
                                // selection is dispatched.
                                event.preventDefault();
                                selectItem(index);
                            }}
                            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors ${
                                index === selectedIndex
                                    ? "bg-accent text-accent-foreground"
                                    : "hover:bg-accent hover:text-accent-foreground"
                            }`}
                        >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="whitespace-nowrap">{item.label}</span>
                        </button>
                    ))}
            </div>
        </div>
    );
});
