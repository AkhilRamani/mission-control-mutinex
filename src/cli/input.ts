import password from '@inquirer/password';
import { CliError } from './errors.js';

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
