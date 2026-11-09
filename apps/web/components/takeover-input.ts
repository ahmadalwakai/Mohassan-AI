/** One request keeps the order: the server types the text, then presses Enter. */
export const takeoverInput = (typed: string): { text?: string; key: "Enter" } => typed ? { text: typed, key: "Enter" } : { key: "Enter" };
