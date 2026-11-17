import { z } from "zod";
import type { ForgeRepository } from "../shared/forges";
import type { PullRequestState } from "../shared/pull-request";
import type { PullRequestRecord } from "../shared/tasks";
import type { BitbucketAuth, Http, ToolCommand, ToolRunner } from "./forge-tools";
import { bitbucketError, toolError } from "./forge-tools";

const text = z.string().min(1);
const id = z.number().int().positive();
const githubRow = z.object({ number: id, state: text, headRefName: text, baseRefName: text, isCrossRepository: z.boolean(), headRefOid: text, createdAt: text });
const azureRow = z.object({ pullRequestId: id, status: text, sourceRefName: text, targetRefName: text, creationDate: text, forkSource: z.unknown().optional(), repository: z.object({ name: text, project: z.object({ name: text }) }), lastMergeSourceCommit: z.object({ commitId: text }).nullish() });
const side = z.object({ branch: z.object({ name: text }), repository: z.object({ full_name: text }).nullish(), commit: z.object({ hash: text }).nullish() });
const bitbucketRow = z.object({ id, state: text, source: side, destination: side, created_on: text });

type ForgeTools = { gh: ToolCommand | null; az: ToolCommand | null; auth: BitbucketAuth | null };
type Candidate = { number: number; source: string; target: string; state: string; head?: string; createdAt: string; sameRepo: boolean };
type Lookup = { repo: ForgeRepository; branch: string; target: string; since: string; recorded?: PullRequestRecord; tools: ForgeTools; run: ToolRunner; http: Http; bitbucketApi: string };
const maxMatches = 20;

const forgeStates: Record<ForgeRepository['forge'], Record<string, 'open' | 'closed' | 'merged'>> = {
  github: { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' },
  'azure-devops': { ACTIVE: 'open', ABANDONED: 'closed', COMPLETED: 'merged' },
  bitbucket: { OPEN: 'open', DECLINED: 'closed', SUPERSEDED: 'closed', MERGED: 'merged' },
};
export function mapState(forge: ForgeRepository['forge'], value: { state?: unknown; status?: unknown; isDraft?: unknown; draft?: unknown }): PullRequestState | null {
  const state = forgeStates[forge][String(value.state ?? value.status ?? '').toUpperCase()];
  return state === 'open' && (value.isDraft === true || value.draft === true) ? 'draft' : state ?? null;
}

/** Return immutable PR evidence only when the current delivery has one unambiguous match. */
export async function findTaskPullRequest(input: Lookup): Promise<{ record: PullRequestRecord; state: 'open' | 'closed' | 'merged' } | null> {
  const { repo, branch, target, since, recorded, tools } = input;
  if (!branch || branch === target || !Number.isFinite(Date.parse(since))) return null;
  if (recorded && (recorded.forge !== repo.forge || recorded.repository !== repo.slug || recorded.taskBranch !== branch || recorded.targetBranch !== target)) return null;
  const read = async (tool: ToolCommand, args: string[]) => {
    const result = await input.run(tool, args, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(toolError(result, 'Pull request lookup failed'));
    return JSON.parse(result.stdout) as unknown;
  };
  let candidates: Candidate[];
  let urlPath: string;
  if (repo.forge === 'github') {
    if (!tools.gh) return null;
    const query = recorded ? ['view', String(recorded.number)] : ['list', '--head', branch, '--base', target, '--state', 'all', '--limit', String(maxMatches + 1)];
    const data = await read(tools.gh, ['pr', ...query, '--repo', repo.slug, '--json', 'number,state,headRefName,baseRefName,isCrossRepository,headRefOid,createdAt']);
    candidates = githubRow.array().parse(recorded ? [data] : data).map(row => ({
      number: row.number, source: row.headRefName, target: row.baseRefName, state: row.state,
      head: row.headRefOid, createdAt: row.createdAt, sameRepo: !row.isCrossRepository,
    }));
    urlPath = 'pull';
  } else if (repo.forge === 'azure-devops') {
    if (!tools.az) return null;
    const query = recorded ? ['show', '--id', String(recorded.number)] : ['list', '--project', repo.project, '--repository', repo.repo, '--source-branch', branch, '--target-branch', target, '--status', 'all', '--top', String(maxMatches + 1)];
    const data = await read(tools.az, ['repos', 'pr', ...query, '--organization', repo.organizationUrl, '--detect', 'false', '--output', 'json']);
    candidates = azureRow.array().parse(recorded ? [data] : data).map(row => ({
      number: row.pullRequestId, source: row.sourceRefName.replace(/^refs\/heads\//, ''), target: row.targetRefName.replace(/^refs\/heads\//, ''),
      state: row.status, head: row.lastMergeSourceCommit?.commitId, createdAt: row.creationDate,
      sameRepo: !row.forkSource && row.repository.name.toLowerCase() === repo.repo.toLowerCase() && row.repository.project.name.toLowerCase() === repo.project.toLowerCase(),
    }));
    urlPath = 'pullrequest';
  } else {
    if (!tools.auth) return null;
    const url = new URL(`${input.bitbucketApi}/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repo)}/pullrequests${recorded ? `/${recorded.number}` : ''}`);
    if (!recorded) {
      for (const state of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']) url.searchParams.append('state', state);
      url.searchParams.set('q', `source.branch.name = ${JSON.stringify(branch)} AND destination.branch.name = ${JSON.stringify(target)}`);
      url.searchParams.set('pagelen', String(maxMatches + 1));
    }
    const response = await input.http({ method: 'GET', url: url.href, headers: { Authorization: tools.auth.header, Accept: 'application/json' } });
    if (response.status !== 200) throw new Error(bitbucketError(response));
    const data = JSON.parse(response.text);
    if (!recorded && data.next) return null;
    candidates = bitbucketRow.array().parse(recorded ? [data] : data.values).map(row => ({
      number: row.id, source: row.source.branch.name, target: row.destination.branch.name, state: row.state,
      head: row.source.commit?.hash, createdAt: row.created_on,
      sameRepo: [row.source, row.destination].every(s => s.repository?.full_name.toLowerCase() === repo.slug.toLowerCase()),
    }));
    urlPath = 'pull-requests';
  }
  if (candidates.length > maxMatches) return null;
  const matches = candidates.filter(row => row.sameRepo && row.source === branch && row.target === target && (recorded ? row.number === recorded.number : Date.parse(row.createdAt) >= Date.parse(since)));
  if (matches.length !== 1) return null;
  const match = matches[0];
  const state = mapState(repo.forge, match);
  if (state === null || state === 'draft') return null;
  const head = match.head ?? recorded?.head;
  if (!head || !/^[a-f0-9]{40}$/.test(head)) return null;
  const record = recorded ?? { forge: repo.forge, repository: repo.slug, url: `${repo.webUrl}/${urlPath}/${match.number}`, number: match.number, taskBranch: branch, targetBranch: target, createdAt: match.createdAt, head, ...(repo.forge === 'azure-devops' ? { organizationUrl: repo.organizationUrl } : {}) };
  return { record, state };
}
