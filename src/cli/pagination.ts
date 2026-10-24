import type { Command } from 'commander';
import type { Page } from '../domain/pagination.js';

type ListOptions = { limit?: string; offset?: string; search?: string };
export function listOptions(command: Command, search = true) {
  command.option('--limit <number>', 'page size (default 25, maximum 100)')
    .option('--offset <number>', 'start at this offset (default 0)');
  if (search) command.option('--search <text>', 'literal substring in names/usernames');
  return command;
}
export function query(opts: ListOptions) {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', opts.limit);
  if (opts.offset !== undefined) params.set('offset', opts.offset);
  if (opts.search !== undefined) params.set('q', opts.search);
  return `?${params}`;
}
export function listing<T>(page: Page<T>, row: (item: T) => string) {
  return `${page.items.length ? page.items.map(row).join('\n') : 'No records.'}${page.nextOffset === null ? '' : `\nMore results: repeat with --offset ${page.nextOffset}.`}`;
}
