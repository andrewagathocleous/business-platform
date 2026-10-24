#!/usr/bin/perl
# run-locked.pl <lock file> <wait|nowait> [--busy <message>] [--on-busy <command...> --] <command> [args...]
#
# Runs <command> while holding an exclusive kernel lock (flock) on <lock file>. The lock
# belongs to the process: it is released when the command ends, crashes or the laptop
# loses power, so it is never left behind. The command replaces this process (exec), so
# signals reach it directly. With nowait, when another process holds the lock, prints the
# --busy message (if given) to standard error, then runs the --on-busy command (if given)
# in its place, or exits 75.
# macOS ships /usr/bin/perl; it has no flock(1) command.
use strict;
use warnings;
use Fcntl qw(:flock);

my ($file, $mode, @command) = @ARGV;
my $busy;
my @on_busy;
if (@command >= 2 && $command[0] eq '--busy') {
  (undef, $busy, @command) = @command;
}
if (@command && $command[0] eq '--on-busy') {
  shift @command;
  push @on_busy, shift @command while @command && $command[0] ne '--';
  shift @command;
}
if (!defined $file || !defined $mode || ($mode ne 'wait' && $mode ne 'nowait') || !@command) {
  print STDERR "usage: run-locked.pl <lock file> <wait|nowait> [--busy <message>] [--on-busy <command...> --] <command> [args...]\n";
  exit 2;
}

# Keep the lock's file descriptor open across exec, so the command holds the lock.
$^F = 1024;
open(my $handle, '>>', $file) or die "run-locked: cannot open $file: $!\n";
my $flags = LOCK_EX;
$flags |= LOCK_NB if $mode eq 'nowait';
if (!flock($handle, $flags)) {
  print STDERR "$busy\n" if defined $busy;
  close($handle);
  if (@on_busy) {
    exec { $on_busy[0] } @on_busy or die "run-locked: cannot run $on_busy[0]: $!\n";
  }
  exit 75;
}
exec { $command[0] } @command or die "run-locked: cannot run $command[0]: $!\n";
