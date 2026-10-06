# Skill directories

Owners and admins can connect external skill directories (marketplaces) and import skills from
them into the Conclavix skill library. The first supported provider is
[Skills Directory](https://www.skillsdirectory.com) (`skillsdirectory`); further providers plug in
through the adapter interface described below.

## Setting up a directory

**Administration → Skill directories** lists the configured sources. Each source has:

| Field    | Meaning                                                                                    |
| -------- | ------------------------------------------------------------------------------------------ |
| Name     | Display name, unique (case-insensitive).                                                   |
| Provider | Which adapter talks to it (`skillsdirectory`). Fixed after creation.                       |
| Base URL | API endpoint; empty means the provider default (`https://www.skillsdirectory.com/api/v1`). |
| API key  | Write-only. Stored encrypted, never returned; the API only reports `hasApiKey`.            |
| Enabled  | Disabled sources cannot be browsed or imported from.                                       |

**Test connection** calls the provider's status endpoint (`GET /stats` for Skills Directory) and
shows the plan (tier) and the remaining daily requests. It is not cached, so every click spends one
request.

### API keys

API keys are sealed with the same AES-256-GCM `SecretBox` as the SMTP password (key derived from
`AUTH_SECRET`). Changing `AUTH_SECRET` makes stored keys unreadable; browsing then fails with
`api_key_unreadable` until the key is entered again. Keys never appear in API responses, audit
entries or logs. In the edit form an empty key field keeps the stored key; "Remove the stored API
key" deletes it. Changing the base URL also deletes the stored key unless a new one is entered in
the same save, so a key is never sent to an endpoint it was not entered for.

### Network rules (SSRF guard)

Directory requests are made by the API server, so base URLs are restricted:

- only `https://`, no credentials in the URL;
- no IP literals or host names in private, loopback, link-local, shared, reserved, documentation
  or multicast ranges (IPv4 and IPv6), no `localhost`, `*.local`, `*.internal`, `*.home.arpa` or
  single-label hosts;
- the DNS answer used for the actual connection is checked again (covers DNS rebinding);
- redirects are not followed, responses are capped at 4 MB, requests time out after 10 s.

`SKILL_SOURCES_ALLOW_PRIVATE=true` lifts the https and private-address rules. It exists for local
tests against a mock directory and must not be set in production; the API logs a warning when it
is.

## Browsing and importing

The **Directory** tab on `/skills` (owners and admins) offers a source selector, search, category
filter, sort (recent, votes, GitHub stars) and paging. Cards show name, description, author and
avatar, tags, stars, the verified badge, the security grade when the directory sends one, and
whether the skill is already in the library. The detail dialog shows a plain-text content preview
when content is available.

**Import** creates a library skill:

- name: derived from the directory slug (editable, must be a valid skill name);
- description: the directory description, else the `description` of the SKILL.md frontmatter;
- body: the SKILL.md text without its frontmatter (Conclavix generates frontmatter at run time);
- provenance `source`: `{sourceId, provider, externalId, slug, url, importedAt, contentHash}`
  (`contentHash` is the sha256 of the imported text). The skill editor shows "Imported from ...".

Imported text is untrusted: it becomes part of agent prompts. The import dialog says so and the
request requires `confirmUntrusted: true`. Imported skills are never assigned to agents
automatically. Importing the same directory entry again returns `409 already_imported` with the
existing skill id; the UI then offers **Update**, which replaces name, description, body and
provenance of that skill (`replaceExisting: true`) and keeps its supporting files and agent
assignments. Every import is audited as `skill.imported`.

### Free tier: no content

Skills Directory only sends skill content on paid plans. On the free tier the detail answer has
`content: {available: false, reason: "tier"}`, the Import button is disabled with "This directory
only provides skill content on a paid plan" and a link to the skill page on the directory.

## Request budget and caching

Skills Directory's free tier allows 100 requests per day (reset at midnight UTC). To respect it:

- search pages and skill details are cached for 5 minutes, categories for 1 hour, in Redis
  (`REDIS_URL`, keys `conclavix:skilldir:*`); without Redis the cache simply misses;
- cache keys include the source's `updatedAt`, so editing a source starts fresh;
- a `429` answer is remembered until its `resetAt` (body, `X-RateLimit-Reset`, `Retry-After`, else
  next midnight UTC); later calls fail fast with `429 directory_rate_limited` without contacting
  the provider;
- the last reported quota (`meta.requestsRemaining`, tier) is kept and shown above the results.

Searching starts on an explicit submit (Enter or the Search button), not on every keystroke.

## API

| Route                                     | Capability | Purpose                                                           |
| ----------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `GET /api/skill-sources`                  | agents     | Sources (without keys) and providers                              |
| `POST /api/skill-sources`                 | settings   | Create                                                            |
| `PATCH /api/skill-sources/:id`            | settings   | Update (`apiKey`: `""` keeps, `null` removes)                     |
| `DELETE /api/skill-sources/:id`           | settings   | Delete (imported skills stay)                                     |
| `POST /api/skill-sources/:id/test`        | settings   | Provider status, tier, quota                                      |
| `GET /api/skill-sources/:id/categories`   | agents     | Categories                                                        |
| `GET /api/skill-sources/:id/skills`       | agents     | Search: `q`, `category`, `sort`, `page`, `limit` (max 50)         |
| `GET /api/skill-sources/:id/skills/:slug` | agents     | Detail with content or the reason it is unavailable               |
| `POST /api/skill-sources/:id/import`      | agents     | Import: `{slug, name?, confirmUntrusted: true, replaceExisting?}` |

Owners and admins hold both capabilities. Changes to sources are audited as
`skill_source.created`, `skill_source.updated` (changed field names; the key only as `set` or
`removed`) and `skill_source.deleted`.

Provider errors map to: `502 directory_auth_failed` (401/403 from the provider),
`429 directory_rate_limited` (with `details.resetAt`), `502 directory_unavailable` (5xx or network),
`504 directory_timeout`, `502 directory_invalid_response`, `404` for unknown slugs,
`422 directory_address_blocked` / `directory_url_invalid` for the network rules.

## Adding a provider

1. Add the id to `SKILL_SOURCE_PROVIDERS` and its label, default base URL and docs URL to
   `SKILL_SOURCE_PROVIDER_INFO` in `packages/core/src/domain/skill-source.ts`.
2. Implement `DirectoryAdapter` (`apps/api/src/modules/skill-sources/adapter.ts`): `search`, `get`,
   `categories`, `status`, `fetchContent`. Use the injected `HttpTransport` (it enforces the network
   rules), validate responses with zod and throw the `directory*` errors from `adapter.ts`. Return
   content as `{available: false, reason}` when the provider does not hand it out.
3. Register the factory in `ADAPTERS` (`service.ts`) and add a label in
   `apps/web/src/skills/directory.ts`.
4. Unit-test the mapping with a mocked transport; tests must never call the real provider.

## Skills Directory field mapping

Verified against the free tier: `id`, `name`, `slug`, `description`, `category`, `authorName`,
`authorUrl`, `authorAvatar`, `githubStars`, `isVerified`, `tags`, `voteCount`, `viewCount`,
`updatedAt`, `pagination.*`, `meta.requestsRemaining`, `meta.tier`, and `/stats`
`data.key.{tier,status}` / `data.usage.{remaining,limit,resetAt}`.

**Unverified (paid plans):** the API docs list full content, security grade and score and GitHub
metadata for Pro and above, but not their field names. The adapter looks for `content`,
`skillContent` or `skillMd`; `securityGrade` / `securityScore` or `security.{grade,score}`;
`githubUrl`, `repoUrl` or `repositoryUrl` (only `https://github.com/...`). Missing fields read as
"not provided". The link to a skill's web page (`<origin>/skills/<slug>`) mirrors the API path and
is also unverified. Check these names against a paid key before relying on them.
