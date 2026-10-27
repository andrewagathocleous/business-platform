export type Phase = 'initial' | 'after-restart';

export function parsePhase(argv: readonly string[]): Phase {
  const inline = argv.find((arg) => arg.startsWith('--phase='));
  const index = argv.indexOf('--phase');
  const value = index >= 0 ? argv[index + 1] : inline?.slice('--phase='.length);
  if (value === 'initial' || value === 'after-restart') {
    return value;
  }
  throw new Error('usage: pnpm milestone:verify --phase=initial|after-restart');
}
