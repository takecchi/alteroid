import process from 'node:process';

export function log(text) {
  process.stdout.write(text + '\n');
}

export function logError(text) {
  process.stderr.write(text + '\n');
}
