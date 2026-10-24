export type PageInput = { limit: number; offset: number; q?: string | undefined };
export type Page<T> = { items: T[]; nextOffset: number | null };
export function page<T>(rows: T[], input: PageInput): Page<T> {
  return { items: rows.slice(0, input.limit), nextOffset: rows.length > input.limit ? input.offset + input.limit : null };
}
// Search is a literal substring, not a user-supplied LIKE pattern.
export function searchPattern(q: string) { return `%${q.replace(/[\\%_]/g, '\\$&')}%`; }
