/**
 * Converts LaTeX-style `\\(...\\)` and `\\[...\\]` delimiters to remark-math
 * `$...$` / `$$...$$` syntax.
 *
 * Block math is extracted first so nested `\\(` inside `\\[...\\]` is not
 * incorrectly treated as inline math.
 */
export function normalizeLatexDelimitersForMarkdown(text: string): string {
  const blocks: string[] = [];
  let result = text.replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => {
    const placeholder = `__MATH_BLOCK_${blocks.length}__`;
    blocks.push(math.trim());
    return placeholder;
  });

  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => {
    return `$${math}$`;
  });

  blocks.forEach((math, idx) => {
    result = result.replace(`__MATH_BLOCK_${idx}__`, `$$\n${math}\n$$`);
  });

  return result;
}
