// Text read from a file, quoted, and anything outside printable ASCII written as an escape, so it cannot hide or
// forge a line.
export const show = (text: string) =>
  JSON.stringify(text).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
