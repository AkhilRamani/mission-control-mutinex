import password from '@inquirer/password';
import { createInterface } from 'node:readline/promises';

import { CliError } from './errors.js';
import { InvalidArgumentError } from 'commander';

export function parseVersion(value: string) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) throw new InvalidArgumentError('Expected a positive integer version.');
  return Number(value);
}

export async function confirmAction(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new CliError('Confirmation required.', 'CONFIRMATION_REQUIRED', 'Review the target and repeat with --yes.');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if ((await prompt.question(`${message} [y/N] `)).trim().toLowerCase() !== 'y') throw new CliError('Cancelled.', 'CANCELLED');
  } finally { prompt.close(); }
}

export async function readPasswords(labels: string[], fromStdin: boolean): Promise<string[]> {
  if (!fromStdin) {
    if (!process.stdin.isTTY) throw new CliError('An interactive terminal is required.', 'INPUT_REQUIRED', 'Use --password-stdin to read secrets from a secure pipe.');
    const values = [];
    for (const label of labels) values.push(await password({ message: label, mask: '*' }, { output: process.stderr }));
    return values;
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 2048) throw new CliError('Password input is too large.');
  }

  const lines = input.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length !== labels.length || lines.some((line) => !line || line.length > 128)) {
    throw new CliError(`Provide ${labels.length} password line(s), each 1–128 characters, on stdin.`);
  }
  return lines;
}
