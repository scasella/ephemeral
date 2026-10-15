/** A point-in-time observation. remoteCheckedAt is a verification time, never a push time. */
export interface WorkStatus {
  state: 'known' | 'unknown' | 'unavailable';
  checkedAt: string;
  dirtyFiles: number | null;
  untrackedFiles: number | null;
  /** Assigned HEAD commits absent from the observed assigned remote; other branches can make state unknown. */
  aheadCommits: number | null;
  headSha: string | null;
  remoteSha: string | null;
  remoteCheckedAt: string | null;
  branch: string | null;
  branchMatches: boolean | null;
  remoteExists: boolean | null;
  reason: string | null;
}

export function unavailableWorkStatus(reason: string): WorkStatus {
  return { state: 'unavailable', checkedAt: new Date().toISOString(), dirtyFiles: null,
    untrackedFiles: null, aheadCommits: null, headSha: null, remoteSha: null,
    remoteCheckedAt: null, branch: null, branchMatches: null, remoteExists: null, reason };
}

export interface GitInspectionResult { exitCode: number; stdout: string }
/** The runner must reject on timeout, output overflow, or incomplete transport output. */
export type GitInspectionRunner = (args: string[], timeoutMs: number) => Promise<GitInspectionResult>;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const COUNT = /^(?:0|[1-9][0-9]*)\n$/;
const LOCAL_MS = 5_000;
const REMOTE_MS = 15_000;

/** Parse NUL-separated porcelain, including the second path of a rename or copy. */
export function parsePorcelainStatus(output: string): { dirtyFiles: number; untrackedFiles: number } {
  if (!output) return { dirtyFiles: 0, untrackedFiles: 0 };
  if (!output.endsWith('\0')) throw new Error('Incomplete status');
  const entries = output.slice(0, -1).split('\0');
  let dirtyFiles = 0, untrackedFiles = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Invalid status');
    const code = entry.slice(0, 2);
    if (code === '??') { untrackedFiles++; continue; }
    if (!/^[ MADRCUT]{2}$/.test(code) || code === '  ') throw new Error('Invalid status');
    if (code.includes('R') || code.includes('C')) {
      if (!entries[++i]) throw new Error('Incomplete rename');
    }
    dirtyFiles++;
  }
  return { dirtyFiles, untrackedFiles };
}

/** Inspect working files and reachable local branches only; orphaned/reflog-only commits are outside this observation.
 * No fetch, index refresh, staging, commit, or push.
 */
export async function inspectGitWorkspace(input: {
  workspace: string; expectedBranch: string; expectedRemoteUrl: string; run: GitInspectionRunner;
}): Promise<WorkStatus> {
  const status: WorkStatus = { ...unavailableWorkStatus('Workspace inspection has not completed.'), state: 'unknown' };
  let failureReason = 'Could not inspect the workspace. Retry while the session is running.';
  const git = async (args: string[], timeoutMs = LOCAL_MS) => {
    const result = await input.run(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', input.workspace, ...args], timeoutMs);
    if (!Number.isInteger(result.exitCode) || typeof result.stdout !== 'string') throw new Error('Invalid result');
    return result;
  };
  const required = async (args: string[]) => {
    const result = await git(args);
    if (result.exitCode !== 0) throw new Error('Git inspection failed');
    return result.stdout;
  };
  const branch = async () => {
    const result = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (result.exitCode === 1 && !result.stdout) return null;
    if (result.exitCode !== 0 || !/^[^\r\n\0]+\n$/.test(result.stdout)) throw new Error('Invalid branch');
    return result.stdout.slice(0, -1);
  };
  const head = async () => {
    const output = await required(['rev-parse', '--verify', 'HEAD']);
    if (!output.endsWith('\n') || !SHA.test(output.slice(0, -1))) throw new Error('Invalid HEAD');
    return output.slice(0, -1);
  };
  const remotesMatch = async () => {
    const [fetch, push] = await Promise.all([
      required(['remote', 'get-url', '--all', 'origin']),
      required(['remote', 'get-url', '--push', '--all', 'origin']),
    ]);
    return fetch === `${input.expectedRemoteUrl}\n` && push === `${input.expectedRemoteUrl}\n`;
  };
  try {
    const ref = `refs/heads/${input.expectedBranch}`;
    if ((await git(['check-ref-format', ref])).exitCode !== 0) throw new Error('Invalid assigned branch');
    failureReason = 'Could not read workspace files or Git history. Retry status before ending the session.';
    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'];
    const branchRefsArgs = ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads/'];
    const [porcelain, currentBranch, currentHead, branchRefs] = await Promise.all([
      required(statusArgs),
      branch(), head(), required(branchRefsArgs),
    ]);
    if (!branchRefs.endsWith('\n') || !branchRefs.slice(0, -1).split('\n').every(line => {
      const [refname, sha, extra] = line.split('\t');
      return refname?.startsWith('refs/heads/') && SHA.test(sha ?? '') && extra === undefined;
    })) throw new Error('Invalid local branch refs');
    const files = parsePorcelainStatus(porcelain);
    Object.assign(status, files, { branch: currentBranch, branchMatches: currentBranch === input.expectedBranch, headSha: currentHead });
    if (!status.branchMatches) {
      status.reason = 'The workspace is not on the assigned session branch. Switch back to that branch and refresh status.';
      return status;
    }
    failureReason = 'Could not verify the configured Git remote. Restore the assigned session gateway remote and refresh status.';
    if (!await remotesMatch()) {
      status.reason = 'The Git remote does not match this session gateway. Restore the assigned remote and refresh status.';
      return status;
    }
    failureReason = 'Could not verify the assigned upstream branch. Check the connection and refresh status before ending the session.';
    const remote = await git(['-c', 'http.followRedirects=false', 'ls-remote', '--refs', '--', input.expectedRemoteUrl, ref], REMOTE_MS);
    if (remote.exitCode !== 0) throw new Error('Remote lookup failed');
    if (remote.stdout === '') {
      status.remoteExists = false;
      status.remoteCheckedAt = new Date().toISOString();
      status.reason = 'The assigned branch does not exist upstream. Push your session branch and refresh status before ending the session.';
      return status;
    }
    const match = /^(?<sha>[a-f0-9]{40}|[a-f0-9]{64})\t(?<ref>[^\r\n\0]+)\n$/.exec(remote.stdout);
    if (!match?.groups || match.groups.ref !== ref) throw new Error('Invalid remote result');
    Object.assign(status, { remoteExists: true, remoteSha: match.groups.sha, remoteCheckedAt: new Date().toISOString() });
    failureReason = 'The upstream commit is not available in local history. Inspect the branch history and refresh status before ending the session.';
    if ((await git(['cat-file', '-e', `${status.remoteSha}^{commit}`])).exitCode !== 0) throw new Error('Missing remote commit');
    const shallow = await required(['rev-parse', '--is-shallow-repository']);
    if (shallow !== 'true\n' && shallow !== 'false\n') throw new Error('Invalid history status');
    if (shallow === 'true\n' && branchRefs.slice(0, -1).split('\n').some(line => line.split('\t')[1] !== status.remoteSha)) {
      status.reason = 'The workspace has incomplete Git history. Inspect the branch history and refresh status before ending the session.';
      return status;
    }
    const count = await required(['rev-list', '--count', `${status.remoteSha}..${status.headSha}`]);
    if (!COUNT.test(count) || !Number.isSafeInteger(Number(count))) throw new Error('Invalid commit count');
    const allBranchCount = await required(['rev-list', '--count', '--branches', '--not', status.remoteSha!]);
    if (!COUNT.test(allBranchCount) || !Number.isSafeInteger(Number(allBranchCount)) || Number(allBranchCount) < Number(count)) throw new Error('Invalid branch commit count');
    failureReason = 'The workspace changed while status was checked. Refresh status before ending the session.';
    const [lastHead, lastBranch, remoteMatches, lastPorcelain, lastBranchRefs] = await Promise.all([head(), branch(), remotesMatch(), required(statusArgs), required(branchRefsArgs)]);
    if (lastHead !== status.headSha || lastBranch !== status.branch || !remoteMatches || lastPorcelain !== porcelain || lastBranchRefs !== branchRefs) throw new Error('Workspace changed');
    status.aheadCommits = Number(count);
    if (Number(allBranchCount) > status.aheadCommits) {
      status.reason = 'Other local branches contain commits not confirmed on the assigned upstream branch. Review and preserve those branches before ending the session.';
      return status;
    }
    status.state = 'known';
    status.reason = null;
    return status;
  } catch {
    status.reason = failureReason;
    return status;
  } finally {
    status.checkedAt = new Date().toISOString();
  }
}
