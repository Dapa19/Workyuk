import { spawn } from 'node:child_process';

const jobs = [
  ['server', 'npm', ['run', 'dev', '--workspace', 'server']],
  ['client', 'npm', ['run', 'dev', '--workspace', 'client']],
];
const children = jobs.map(([name, command, args]) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      children.forEach((other) => {
        if (other !== child) other.kill('SIGTERM');
      });
    }
  });
  return child;
});
const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
