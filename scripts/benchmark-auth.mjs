#!/usr/bin/env node
// Optional interactive launcher: receive FAL_KEY on stdin, never in argv or a file.
// Use a terminal with echo disabled. `node ... -- command args` runs an upstream stage.
import { spawn } from 'node:child_process';
const key = await new Promise((resolve, reject) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0].trim()); });
  process.stdin.on('error', reject);
});
process.stdin.pause();
if (!key) throw new Error('No API credential received');
process.env.FAL_KEY = key;
const args = process.argv.slice(2);
if (args[0] === '--') {
  const child = spawn(args[1], args.slice(2), { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', () => { console.error('Could not launch benchmark subprocess'); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
} else await import('./benchmark.mjs');
