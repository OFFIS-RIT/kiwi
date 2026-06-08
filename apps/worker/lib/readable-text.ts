import { stripPageFences } from "@kiwi/graph/lib/page-fence";

export function requireReadableContentText(text: string): string {
    const contentText = stripPageFences(text);
    if (contentText.trim() === "") {
        throw new Error("No readable text found in file");
    }

    return contentText;
}
