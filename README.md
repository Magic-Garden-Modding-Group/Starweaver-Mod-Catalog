# Starweaver Mod Catalog

Remote catalog index for [Starweaver Mod Manager](https://github.com/Magic-Garden-Modding-Group/Starweaver-Mod-Manager). Tracks the latest versions of curated mods so version bumps don't require an extension release.

## How it works

A scheduled GitHub Action runs every 6 hours (or on manual trigger). For each mod in `tracked-mods.json`, it:

1. Queries the source repo for the latest commit (via release, tag, or branch HEAD).
2. Fetches the script at that commit.
3. Parses the `@version` from the userscript header.
4. Computes an FNV-1a hash of the script content.
5. Writes the result to `index.json`.

The extension fetches `index.json` on a timer and overlays version/URL/hash onto its baked-in catalog baselines. Permission governance (grants, matches, connects, moderation status) stays in the extension — this repo only provides the volatile fields that change per release.

## Files

| File | Purpose |
|------|---------|
| `index.json` | The catalog index. Auto-generated — do not edit by hand. |
| `tracked-mods.json` | Defines which repos to track and how to resolve the latest version. |
| `scripts/update-index.ts` | The update script run by CI. |
| `.github/workflows/update-index.yml` | Scheduled workflow (every 6 hours + manual dispatch). |

## Adding or updating a tracked mod

Edit `tracked-mods.json`. Each entry has:

```jsonc
{
  "id": "curated:example",       // Must match a baseline entry ID in the extension
  "repo": "Owner/RepoName",      // GitHub owner/repo
  "scriptPath": "dist/mod.js",   // Path to the script file in the repo
  "strategy": "latest-release"   // How to resolve the latest commit
}
```

### Strategies

| Strategy | Resolves to |
|----------|-------------|
| `latest-release` | Commit tagged by the most recent GitHub Release |
| `latest-tag` | Commit of the most recent git tag |
| `branch:<name>` | HEAD of the named branch |

`latest-release` is preferred when the repo uses GitHub Releases. Fall back to `branch:<name>` for repos that commit directly without releases or tags.

## Running locally

Requires Node 22+.

```
node --experimental-strip-types scripts/update-index.ts
```

Set `GITHUB_TOKEN` to avoid rate limits (60 req/hr unauthenticated, 5000 authenticated).

## Security model

This repo provides version currency, not permission governance. The extension enforces:

- **Hash verification** — fetched scripts must match the hash in `index.json`.
- **Permission ceiling** — parsed grants/matches/connects from the fetched script must not exceed the baked-in baseline. If they do, the install/update is blocked until a new extension version ships with updated baselines.
- **Offline fallback** — if the index can't be fetched, the extension uses its baked-in baseline values.

An attacker who compromises this repo can only point users at different script versions within the existing permission envelope. They cannot escalate permissions.
