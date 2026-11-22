# ai-space-apps

The app catalog of [ai-space](https://github.com/ericz-lab/ai-space): apps anyone can install on their own Space, from the panel or with one command.

```sh
space app catalog                 # what is listed, what is installed, what has an update
space app install task-shelf      # the signed package: nothing cloned, no dependency fetched, no script run
space app install task-shelf --source            # cloned to <workspace>/app-src/task-shelf at the release tag and built on your machine
space app install task-shelf --source --ref main # the same, following main: a development version
space app upgrade task-shelf
```

Every Space reads this repository's `catalog.json` unless `SPACE_APP_CATALOG` says otherwise (ai-space `docs/app-catalog.md`): as `https://ai-space.me/store/index.json`, where each merge to `main` publishes it, or, a Space released before that address existed, from this repository directly. The catalog is a list: the apps themselves live in their own repositories and publish their packages as GitHub release assets; the packages the catalog names are copied to the store, so that installing needs no route to GitHub ([The store](#the-store)).

## What is in this repository

| Path | What |
| --- | --- |
| `catalog.json` | What Spaces read. Made by `bun scripts/build.ts` from the two directories below; never edit it by hand. |
| `publishers/<id>.json` | A publisher: name, optional URL, and the public half of their Ed25519 signing key with its key ID. |
| `apps/<name>.json` | An app: title and description (English, optional Chinese), icon, repository, license, what it needs, what only works online, and its latest release. |
| `icons/` | Icons the entries point to by relative path. |
| `schema/catalog.schema.json` | The format as JSON Schema. `scripts/lib.ts` holds the same rules and the checks a schema cannot make. |
| `scripts/` | `build.ts` (`--check` in CI), `validate.ts` (`--fetch` downloads every release and checks checksum, app, version and signature), `release-entry.ts` (point an app at a new release), `add-publisher.ts`. |

## The store

What Spaces download is served from one object store (a Cloudflare R2 bucket) at `https://bucket.ai-space.me`; `https://ai-space.me/store/…` is the same files.

| Object | What | Cache |
| --- | --- | --- |
| `store/index.json` | `catalog.json`, byte for byte | 5 minutes |
| `store/icons/…` | `icons/`, which entries name by relative path | 5 minutes |
| `store/packages/<app>/<version>/<file>.spaceapp` | a release's package and its source package | a year, immutable: a released version is never replaced |

- **The catalog and icons**: the `publish` job of `.github/workflows/validate.yml` uploads them after every merge to `main` that passes the checks. Nothing to do by hand.
- **A release's packages**: run the `store-release` workflow (Actions → store-release → Run workflow) with the app's name and its release tag. It downloads the packages from the app's GitHub release, checks the app, version and publisher's signature, uploads them under `store/packages/<app>/<version>/`, and opens the pull request that points `apps/<app>.json` at them. A pull request that an app's own release workflow opened with GitHub download URLs is replaced by that one.
- **By hand**, with credentials for the bucket: `aws s3 cp <file> s3://ai-space-store/store/packages/<app>/<version>/ --endpoint-url https://<account id>.r2.cloudflarestorage.com --cache-control "public, max-age=31536000, immutable"`, then `scripts/release-entry.ts` with `--base-url https://bucket.ai-space.me/store/packages/<app>/<version>`.

The workflows read three Actions secrets, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: an R2 API token allowed to read and write objects in this one bucket. The store adds no trust: a Space checks every package against the catalog's checksum and the publisher's signature wherever it came from.

## Trust

A package installs only when it is signed. A Space trusts the publishers ai-space ships with and the keys its owner adds (`SPACE_PACKAGE_TRUST_KEYS`); any other publisher listed here needs the owner's yes once, in the panel or with `--trust`, and is then remembered. A package that does not match the checksum here, or is signed by another key than its publisher's, never installs. Installing from source runs the app's own build commands on the owner's machine, so it asks for the same trust.

## Add your app

1. Make it a spec-2 app (ai-space `docs/app-packages.md`): a `space.release.yaml` (or a spec-2 `space.yaml`) with `version`, `requires`, `launch`, `offline`, and a `build:` section saying how a checkout becomes the package (`install`, `run`, `include`). `space app release .` must build it on a clean checkout.
2. Make a signing key once: `space app keygen --out ~/keys/<you>.pem`. Keep the private key out of every repository; put it in your app repository's Actions secret `SPACE_SIGN_KEY`.
3. Copy ai-space's release workflow (`skills/space-app/package-template/.github/workflows/release.yml`) into your repository. A `v<version>` tag then builds, signs and publishes the release.
4. Open a pull request here with `publishers/<you>.json` (`bun scripts/add-publisher.ts <you> "Your Name" ~/keys/<you>.pem.pub --url https://...`), `apps/<app>.json`, its icon, and `catalog.json` rebuilt. CI checks the entry and downloads the release.

Later releases: the workflow runs `scripts/release-entry.ts` and proposes the change here, and a maintainer then copies the packages to [the store](#the-store); or run it yourself:

```sh
bun scripts/release-entry.ts <app> --tag v1.2.0 --package <app>-1.2.0.spaceapp --source-package <app>-1.2.0-source.spaceapp \
  --base-url https://github.com/<owner>/<app>/releases/download/v1.2.0
bun scripts/build.ts
```

## An entry

```json
{
  "name": "task-shelf",
  "publisher": "ericz-lab",
  "title": { "en": "Task Shelf", "zh": "定时任务收纳" },
  "description": { "en": "…", "zh": "…" },
  "icon": "icons/task-shelf.png",
  "repo": "https://github.com/ericz-lab/task-shelf",
  "license": "MIT",
  "recommended": true,
  "needs": ["operator", "model"],
  "online": [{ "en": "The AI assistant and AI jobs need a model", "zh": "AI 助手和 AI 任务需要模型" }],
  "latest": {
    "version": "0.2.0",
    "tag": "v0.2.0",
    "package": { "url": "https://github.com/…/task-shelf-0.2.0.spaceapp", "sha256": "…" },
    "sourcePackage": { "url": "https://github.com/…/task-shelf-0.2.0-source.spaceapp", "sha256": "…" },
    "requires": { "spaceApi": 1, "bun": "1.3.0" }
  }
}
```

`package` is the built release; `sourcePackage`, when there is one, is the same release with its source included: the owner chooses at install time. An entry without `latest` is listed but installs only from source.

`needs` says what the app wants from the Space, so the panel can say it before installing:

| Need | Meaning |
| --- | --- |
| `model` | an AI runtime the Space can call (Claude Code, Codex, …) |
| `agent-logs` | the session logs of Claude Code, Codex or DeepSeek Harness on the machine |
| `operator` | the operator credential, to change the Space's own tasks or settings |
| `s3` | an object store; without one the app keeps its files in its data directory |
| `git` | git on the machine |

## License

MIT. Each app has its own license, named in its entry.
