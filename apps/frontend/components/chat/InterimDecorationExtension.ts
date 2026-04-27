import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
// `@tiptap/core` is not a direct dep but is re-exported from `@tiptap/react`.
import { Extension } from "@tiptap/react";

/**
 * Plugin key used to push interim-transcript text into the decoration plugin
 * via `editor.view.dispatch(tr.setMeta(interimDecorationKey, text))`. Pass an
 * empty string to clear the decoration.
 */
export const interimDecorationKey = new PluginKey<DecorationSet>("interim-decoration");

/**
 * Renders a transient, italic muted widget at the end of the document — used
 * to preview live (non-final) speech-to-text transcripts without mutating the
 * document itself, so file-mention atom nodes are preserved while recording.
 */
export const InterimDecoration = Extension.create({
    name: "interimDecoration",

    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key: interimDecorationKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply(tr, decorations, _oldState, newState) {
                        const meta = tr.getMeta(interimDecorationKey);
                        if (typeof meta === "string") {
                            if (meta.length === 0) return DecorationSet.empty;
                            const widget = document.createElement("span");
                            widget.className = "interim-decoration";
                            widget.textContent = meta;
                            const pos = Math.max(newState.doc.content.size - 1, 0);
                            return DecorationSet.create(newState.doc, [
                                Decoration.widget(pos, widget, { side: 1 }),
                            ]);
                        }
                        return decorations.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations(state) {
                        return interimDecorationKey.getState(state) ?? DecorationSet.empty;
                    },
                },
            }),
        ];
    },
});
