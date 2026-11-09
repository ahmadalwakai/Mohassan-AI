/**
 * Brain B: Goal Integrity. A goal contract compiled in code from the request,
 * progress tracking and stagnation detection. It never acts by itself; it only
 * withholds a premature answer, question or guessed address once, with a
 * concrete warning, so the model changes strategy. Every nudge kind has a
 * fixed budget, so a model that insists always gets its way and the run ends.
 *
 * Brain A (the default) never calls this module.
 */
import type { AgentPage } from '@mohassan/browser';

export type BrainVersion = 'A' | 'B';

export interface GoalState {
  /** Origins the request names; reaching them is part of the goal. */
  sites: string[];
  /** Every page URL (without fragment) the agent has seen with a successful status. */
  visited: string[];
  /** Same-origin link targets seen on any page, with their labels. */
  links: { url: string; label: string }[];
  /** URLs whose last observation was a transient failure (5xx or 429). */
  transient: string[];
  /** Origins of every link seen on any page, including other sites. */
  seenOrigins: string[];
  /** Page content hashes already seen. */
  hashes: string[];
  /** Consecutive steps that revealed no new page. */
  stagnant: number;
  /** URLs a stagnation warning was already given for. */
  stagnationWarned: string[];
  nudges: { ground: number; giveUp: number; guess: number };
  /** The one escalation to answer with what was found has been given. */
  escalated?: boolean;
}

const NUDGE_LIMIT = { ground: 1, giveUp: 2, guess: 1 } as const;
const STAGNATION_STEPS = 2;
/** After this many steps without a new page, exploring further is unlikely to help. */
const ESCALATION_STEPS = 6;
const MAX_LINKS = 200;
const LISTED_LINKS = 8;
/** Steps that look again at the same page instead of going somewhere new. */
const SAME_PAGE_TOOLS = new Set(['scroll', 'read_more', 'wait']);

function bare(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return url; }
}

function origin(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null; } catch { return null; }
}

/** Addresses written in the request itself, with or without a scheme. */
export function requestedSites(request: string): string[] {
  const found = new Set<string>();
  for (const match of request.matchAll(/\bhttps?:\/\/[^\s"'<>«»()]+/giu)) {
    const site = origin(match[0].replace(/[.,،؛:!?]+$/u, ''));
    if (site) found.add(site);
  }
  return [...found];
}

export function newGoalState(request: string): GoalState {
  return { sites: requestedSites(request), visited: [], links: [], seenOrigins: [], hashes: [], transient: [], stagnant: 0, stagnationWarned: [], nudges: { ground: 0, giveUp: 0, guess: 0 } };
}

function transientStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

/**
 * Records what a successful step showed. Returns true when it revealed a page
 * not seen before, which is the progress signal.
 */
export function observeStep(goal: GoalState, tool: string, page: AgentPage | null): boolean {
  if (!page) {
    goal.stagnant += 1;
    return false;
  }
  const url = bare(page.url);
  const pageOrigin = origin(url);
  if (transientStatus(page.documentStatus)) {
    if (!goal.transient.includes(url)) goal.transient.push(url);
    goal.stagnant += 1;
    return false;
  }
  goal.transient = goal.transient.filter(entry => entry !== url);
  const fresh = (page.documentStatus ?? 200) < 400 && !goal.visited.includes(url);
  if (fresh) goal.visited.push(url);
  for (const element of page.elements) {
    if (!element.href || element.disabled) continue;
    const target = bare(element.href);
    const targetOrigin = origin(target);
    if (targetOrigin && !goal.seenOrigins.includes(targetOrigin) && goal.seenOrigins.length < MAX_LINKS) goal.seenOrigins.push(targetOrigin);
    if (targetOrigin !== pageOrigin || goal.links.some(link => link.url === target)) continue;
    goal.links.push({ url: target, label: element.label.trim().slice(0, 80) });
  }
  if (goal.links.length > MAX_LINKS) goal.links.splice(0, goal.links.length - MAX_LINKS);
  // A new page is progress. So is new content on the same address after an action
  // other than looking again, as on pages that update in place.
  const changed = !SAME_PAGE_TOOLS.has(tool) && !goal.hashes.includes(page.hash);
  if (!goal.hashes.includes(page.hash)) goal.hashes.push(page.hash);
  if (goal.hashes.length > MAX_LINKS) goal.hashes.splice(0, goal.hashes.length - MAX_LINKS);
  goal.stagnant = fresh || changed ? 0 : goal.stagnant + 1;
  return fresh || changed;
}

/** A failed step makes no progress either. */
export function observeFailure(goal: GoalState): void {
  goal.stagnant += 1;
}

/**
 * Any finished step. Browser steps report their page; other tools (search,
 * memory) progress when they returned something new, except reading more of
 * the same page, which only looks again.
 */
export function observeOutcome(goal: GoalState, tool: string, page: AgentPage | undefined, changed: boolean | null): void {
  if (page) observeStep(goal, tool, page);
  else if (changed && !SAME_PAGE_TOOLS.has(tool)) goal.stagnant = 0;
  else goal.stagnant += 1;
}

function unvisited(goal: GoalState, page: AgentPage | null): { url: string; label: string }[] {
  const here = page ? origin(page.url) : null;
  const scope = new Set([...goal.sites, ...(here ? [here] : [])]);
  return goal.links.filter(link => !goal.visited.includes(link.url) && scope.has(origin(link.url) ?? ''))
    // Links on the current page come first: they are one click away.
    .sort((a, b) => Number(Boolean(page?.elements.some(element => element.href && bare(element.href) === b.url))) - Number(Boolean(page?.elements.some(element => element.href && bare(element.href) === a.url))));
}

function listLinks(links: { label: string }[]): string {
  return links.slice(0, LISTED_LINKS).map(link => `«${link.label || 'link'}»`).join('، ');
}

/**
 * Stagnation: after STAGNATION_STEPS steps without a new page, name the links
 * not opened yet, once per page. Returns undefined when there is nothing better to say.
 */
export function stagnationWarning(goal: GoalState, page: AgentPage | null): string | undefined {
  if (goal.stagnant >= ESCALATION_STEPS && !goal.escalated) {
    goal.escalated = true;
    return `Progress check: ${goal.stagnant} steps in a row showed nothing new, so more of the same will not help. Answer now with what the pages you opened actually show, and say plainly which part you could not find.`;
  }
  if (goal.stagnant < STAGNATION_STEPS || !page) return undefined;
  const url = bare(page.url);
  if (goal.stagnationWarned.includes(url)) return undefined;
  const options = unvisited(goal, page);
  if (!options.length) return undefined;
  goal.stagnationWarned.push(url);
  return `Progress check: your last ${goal.stagnant} steps showed no new page. Looking at this page again will not add information. Act instead: open one of the links you have not opened yet, such as ${listLinks(options)}, using its element reference.`;
}

function reachedRequestedSite(goal: GoalState): boolean {
  return goal.sites.some(site => goal.visited.some(url => origin(url) === site) || goal.transient.some(url => origin(url) === site));
}

/**
 * Checks a final answer or a question to the user against the goal contract.
 * Returns a warning when the move is premature and the budget allows one more nudge.
 */
export function reviewStop(goal: GoalState, move: { tool: 'answer' | 'ask_user'; outcome?: string | null }, page: AgentPage | null): string | undefined {
  if (goal.sites.length && !reachedRequestedSite(goal) && goal.nudges.ground < NUDGE_LIMIT.ground) {
    goal.nudges.ground += 1;
    return `Goal check: the request gives the address ${goal.sites.join(', ')}, and you have not opened it yet. It is reachable from your browser. Open it with the open tool and base the reply on what it shows, not on general knowledge.`;
  }
  const givingUp = move.tool === 'ask_user' || move.outcome === 'blocked' || move.outcome === 'partial';
  if (!givingUp || goal.nudges.giveUp >= NUDGE_LIMIT.giveUp) return undefined;
  const retry = goal.transient.at(-1);
  if (retry) {
    goal.nudges.giveUp += 1;
    return `Goal check: ${retry} failed with a temporary server error. Such errors often clear on a second request. Open that address again with the open tool before giving up.`;
  }
  const options = unvisited(goal, page);
  if (options.length) {
    goal.nudges.giveUp += 1;
    return `Goal check: the goal is not met yet, and there are links on this site you have not opened: ${listLinks(options)}. Open the most relevant one before giving up.`;
  }
  return undefined;
}

/**
 * An address that appears in neither the request, any page, nor any search
 * result is a guess. The first guess is withheld with a warning; a repeat proceeds.
 */
export function reviewOpen(goal: GoalState, url: string, request: string, searchResults: readonly string[]): string | undefined {
  const target = origin(url);
  if (!target || goal.nudges.guess >= NUDGE_LIMIT.guess) return undefined;
  const known = new Set([...goal.sites, ...goal.visited.map(origin), ...goal.seenOrigins, ...searchResults.map(origin)]);
  if (known.has(target) || request.toLowerCase().includes(new URL(url).hostname.toLowerCase())) return undefined;
  goal.nudges.guess += 1;
  return `Scope check: ${target} appears nowhere in the request, the pages you opened or the search results, so it is a guess. Use an address you have actually seen, such as a search result or a link on a page.`;
}
