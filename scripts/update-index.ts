/**
 * Catalog index updater.
 *
 * Reads tracked-mods.json, queries GitHub for the latest release/tag/branch
 * commit for each entry, fetches the script, computes FNV-1a hash, parses
 * @version from the userscript header, and writes index.json if anything changed.
 *
 * Usage:
 *   node --experimental-strip-types scripts/update-index.ts
 *
 * Environment:
 *   GITHUB_TOKEN — optional, raises rate limits from 60/hr to 5000/hr
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_PATH = resolve(ROOT, "tracked-mods.json");
const INDEX_PATH = resolve(ROOT, "index.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackedMod {
  id: string;
  repo: string;
  scriptPath: string;
  strategy: string; // "latest-release" | "latest-tag" | "branch:<name>"
}

interface IndexEntry {
  version: string;
  scriptUrl: string;
  sourceCommitOrTag: string;
  scriptHash: string;
}

interface CatalogIndex {
  indexVersion: number;
  generatedAt: string;
  entries: Record<string, IndexEntry>;
}

// ---------------------------------------------------------------------------
// FNV-1a (must match extension's src/utils/hash.ts exactly)
// ---------------------------------------------------------------------------

function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Starweaver-Mod-Catalog"
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

async function githubGet(path: string): Promise<unknown> {
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Strategy resolvers — each returns the commit SHA for the latest version
// ---------------------------------------------------------------------------

async function resolveLatestRelease(repo: string): Promise<string> {
  const data = (await githubGet(`/repos/${repo}/releases/latest`)) as {
    tag_name: string;
    target_commitish: string;
  };
  // tag_name is the git tag. Resolve it to a commit SHA.
  const ref = (await githubGet(`/repos/${repo}/git/ref/tags/${data.tag_name}`)) as {
    object: { type: string; sha: string };
  };
  // Annotated tags have type "tag" and need one more dereference.
  if (ref.object.type === "tag") {
    const tag = (await githubGet(`/repos/${repo}/git/tags/${ref.object.sha}`)) as {
      object: { sha: string };
    };
    return tag.object.sha;
  }
  return ref.object.sha;
}

async function resolveLatestTag(repo: string): Promise<string> {
  const tags = (await githubGet(`/repos/${repo}/tags?per_page=1`)) as Array<{
    name: string;
    commit: { sha: string };
  }>;
  if (tags.length === 0) {
    throw new Error(`No tags found for ${repo}`);
  }
  return tags[0]!.commit.sha;
}

async function resolveBranch(repo: string, branch: string): Promise<string> {
  const data = (await githubGet(`/repos/${repo}/branches/${branch}`)) as {
    commit: { sha: string };
  };
  return data.commit.sha;
}

async function resolveCommit(repo: string, strategy: string): Promise<string> {
  if (strategy === "latest-release") {
    return resolveLatestRelease(repo);
  }
  if (strategy === "latest-tag") {
    return resolveLatestTag(repo);
  }
  if (strategy.startsWith("branch:")) {
    return resolveBranch(repo, strategy.slice("branch:".length));
  }
  throw new Error(`Unknown strategy: ${strategy}`);
}

// ---------------------------------------------------------------------------
// Script fetch + parse
// ---------------------------------------------------------------------------

function parseVersion(scriptCode: string): string {
  const blockMatch = scriptCode.match(
    /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i
  );
  if (!blockMatch?.[1]) {
    return "0.0.0";
  }
  for (const line of blockMatch[1].split(/\r?\n/)) {
    const parsed = line.match(/^\s*\/\/\s*@version\s+(.+?)\s*$/);
    if (parsed?.[1]) {
      return parsed[1];
    }
  }
  return "0.0.0";
}

async function fetchScript(repo: string, commit: string, scriptPath: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${scriptPath}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Starweaver-Mod-Catalog" }
  });
  if (!response.ok) {
    throw new Error(`Script fetch failed (${response.status}): ${url}`);
  }
  return (await response.text()).trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tracked: TrackedMod[] = JSON.parse(await readFile(TRACKED_PATH, "utf8"));

  let existing: CatalogIndex;
  try {
    existing = JSON.parse(await readFile(INDEX_PATH, "utf8"));
  } catch {
    existing = { indexVersion: 1, generatedAt: "", entries: {} };
  }

  let changed = false;

  for (const mod of tracked) {
    console.log(`[${mod.id}] Checking ${mod.repo} (${mod.strategy})...`);

    let commit: string;
    try {
      commit = await resolveCommit(mod.repo, mod.strategy);
    } catch (error) {
      console.error(`[${mod.id}] Failed to resolve commit: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const current = existing.entries[mod.id];
    if (current && current.sourceCommitOrTag === commit) {
      console.log(`[${mod.id}] Already up to date (${commit.slice(0, 8)})`);
      continue;
    }

    console.log(`[${mod.id}] New commit: ${commit.slice(0, 8)} (was: ${current?.sourceCommitOrTag?.slice(0, 8) ?? "none"})`);

    let scriptCode: string;
    try {
      scriptCode = await fetchScript(mod.repo, commit, mod.scriptPath);
    } catch (error) {
      console.error(`[${mod.id}] Failed to fetch script: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const version = parseVersion(scriptCode);
    const scriptHash = hashText(scriptCode);
    const scriptUrl = `https://raw.githubusercontent.com/${mod.repo}/${commit}/${mod.scriptPath}`;

    existing.entries[mod.id] = {
      version,
      scriptUrl,
      sourceCommitOrTag: commit,
      scriptHash
    };

    console.log(`[${mod.id}] Updated: v${version}, hash=${scriptHash}`);
    changed = true;
  }

  if (changed) {
    existing.generatedAt = new Date().toISOString();
    await writeFile(INDEX_PATH, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log("\nindex.json updated.");
  } else {
    console.log("\nNo changes detected.");
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exitCode = 1;
});
