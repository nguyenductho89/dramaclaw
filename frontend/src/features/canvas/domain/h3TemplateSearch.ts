import type { H3PromptTemplate } from "./h3PromptTemplates";

/** Lowercase and strip accents so "khoanh khac" finds "Khoảnh khắc". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Templates whose title, description, id or prompt contain every word of
 * `query` (accent- and case-insensitive). An empty query matches everything.
 */
export function searchH3Templates(
  items: readonly H3PromptTemplate[],
  query: string,
): H3PromptTemplate[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = fold(
      [
        item.id,
        item.title.en,
        item.title.vi,
        item.description.en,
        item.description.vi,
        item.prompt,
      ].join("\n"),
    );
    return words.every((word) => haystack.includes(word));
  });
}
