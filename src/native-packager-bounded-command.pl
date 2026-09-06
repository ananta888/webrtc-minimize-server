# Local verified maintenance commands only. No shell eval and no network policy.
use strict;
use warnings;
use POSIX qw(setpgid _exit sigprocmask SIG_BLOCK SIG_SETMASK SIGALRM SIGTERM SIGINT);
use Errno qw(EINTR);
my $seconds = shift @ARGV;
die "Invalid command deadline\n" unless defined($seconds) && $seconds =~ /\A[1-9][0-9]?\z/ && $seconds <= 30 && @ARGV;
my $blocked = POSIX::SigSet->new(SIGALRM, SIGTERM, SIGINT);
my $previous = POSIX::SigSet->new();
defined(sigprocmask(SIG_BLOCK, $blocked, $previous)) or die "Cannot protect command startup\n";
my $child = fork();
die "Cannot start bounded command\n" unless defined($child);
if ($child == 0) {
    setpgid(0, 0) == 0 or _exit(125);
    $SIG{ALRM} = $SIG{TERM} = $SIG{INT} = "DEFAULT";
    defined(sigprocmask(SIG_SETMASK, $previous)) or _exit(125);
    exec { $ARGV[0] } @ARGV or _exit(127);
}
# The child also sets its group before exec; the parent closes the scheduling gap.
setpgid($child, $child);
my $interrupted = 0;
my $terminate = sub {
    $interrupted = 1;
    alarm 0;
    $SIG{ALRM} = $SIG{TERM} = $SIG{INT} = "IGNORE";
    kill "TERM", -$child;
    select undef, undef, undef, 1;
    kill "KILL", -$child;
};
$SIG{ALRM} = $SIG{TERM} = $SIG{INT} = $terminate;
alarm $seconds;
defined(sigprocmask(SIG_SETMASK, $previous)) or $terminate->();
my $waited;
do { $waited = waitpid($child, 0); } while ($waited < 0 && $! == EINTR);
my $status = $?;
alarm 0;
exit 124 if $interrupted;
exit 125 if $waited < 0;
exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
