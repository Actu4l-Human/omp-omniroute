# OmniRoute for OMP

Use a self-hosted OmniRoute gateway as an **extension-registered `omniroute` provider** in Oh My Pi. The extension supplies authenticated model discovery, chat streaming and tools, embedding/image model kinds, diagnostics, and optional usage reporting. It integrates with OMP's normal provider interfaces; it is not an OMP built-in and does not patch or impersonate another provider.

The compatibility baseline is **OMP 18.18.1** and **OmniRoute v3.8.53**. The inspected `release/v3.8.54` development revision shares the reviewed metadata, pricing, health, and usage contracts; it is not the latest published release in this review. See [source revisions and verification limits](docs/compatibility.md).

Package version: **1.2.0**. <!-- x-release-please-version -->

## GitHub Packages

Releases publish `@actu4l-human/omp-omniroute` to `https://npm.pkg.github.com`, linked to this repository. See [release notes](CHANGELOG.md) and [release setup](docs/development.md#releases-and-github-packages). The package becomes available only after the first successful release workflow; the version above is the source version, not proof of publication.

GitHub requires authentication even for public npm packages. After a release is published, authenticate with your GitHub username and a classic token with `read:packages` (enter the token at the password prompt, not in a command):

```sh
npm login --scope=@actu4l-human --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --prefix "$HOME/omp-extensions" --ignore-scripts @actu4l-human/omp-omniroute --registry=https://npm.pkg.github.com
```

With gateway environment variables configured as below, load `$HOME/omp-extensions/node_modules/@actu4l-human/omp-omniroute/index.ts` with `omp --no-extensions -e`. Use `npm.cmd` on Windows. Do not also install a second copy through automatic directory loading.

## Install from this folder

Use a working OMP 18.18.1 installation with its required Bun >=1.4.4. Keep `index.ts`, `package.json`, and the complete `src/` directory together. Runtime installation does **not** need `npm ci` or an extension-local `node_modules`.

Place this source folder at a permanent location, such as `$HOME/omp-extensions/omp-omniroute`. Root `index.ts` is the only entry point; do not load files under `src/` individually.

Set the gateway URL and API key on the machine running OMP. Use the reachable HTTPS API root, optionally ending in `/v1`, and an inference API key rather than a dashboard password.

### Bash

```bash
read -rp 'OmniRoute HTTPS API root: ' OMNIROUTE_BASE_URL
read -rsp 'OmniRoute API key: ' OMNIROUTE_API_KEY; echo
export OMNIROUTE_BASE_URL OMNIROUTE_API_KEY
omp models omniroute --kind all --json --no-extensions -e "$HOME/omp-extensions/omp-omniroute/index.ts"
```

### PowerShell 7.1+

```powershell
$env:OMNIROUTE_BASE_URL = Read-Host 'OmniRoute HTTPS API root'
$env:OMNIROUTE_API_KEY = Read-Host 'OmniRoute API key' -MaskInput
omp models omniroute --kind all --json --no-extensions -e "$HOME/omp-extensions/omp-omniroute/index.ts"
```

These prompts keep the key out of shell history, but OMP still receives it in its process environment. Use your secret manager for persistence. The extension does not source `.env` or [.env.example](.env.example). An absent or invalid key disables provider registration.

### Automatic loading

Alternatively, copy the complete extension folder to `~/.omp/agent/extensions/omniroute/`, or the active profile's `agent/extensions/omniroute/` directory, and restart OMP. For a named profile, the default location is `~/.omp/profiles/<name>/agent/extensions/omniroute/`.

The manifest declares `omp.extensions: ["./index.ts"]`, and the root loader imports `src/extension.ts`. This exact directory layout was exercised in a fresh isolated profile without local dependencies. Do not install multiple copies or also load a different copy with `-e`.

```bash
omp models omniroute --kind all --json
omp
```

## Select a model and check the connection

Choose a chat model in OMP's picker, or pass the exact `selector` returned by the model listing to `omp --model`. Gateway IDs are unchanged: if an ID contains `/`, retain the entire ID after the `omniroute/` provider prefix. Do not use the display name or its pricing label as an ID. Explicit-only installations must also pass `--no-extensions -e /path/to/index.ts` when starting OMP.

In the session:

```text
/omniroute-doctor
/omniroute-status
/omniroute-refresh
```

Doctor performs authenticated **GETs only**. A missing deployment-version header is informational, and a healthy response does not prove inference availability. Use `/omniroute-model` followed by an exact gateway ID to inspect mapping decisions. `/omniroute-usage` requires the key's optional `allowUsageCommand` permission.

## Self-hosted gateway requirements

- Expose the API to the OMP machine, not just a container-internal hostname. Forward Bearer `Authorization` and streaming SSE without redirecting to dashboard login.
- Forward `/v1/*` for catalog, health, and supported inference routes. With a proxy prefix, preserve that prefix consistently.
- Optional usage is a **sibling route**: `/api/usage/om-usage?format=json`. Forward it separately from `/v1/*`, under the same prefix if configured. The extension does not change proxy rules or server permissions.
- Restart OMP after URL/key changes, then confirm a successful `/omniroute-refresh`. Cached catalogs can retain previous configuration during discovery outages.

## Reference

- [Configuration, commands, overrides, pricing, and troubleshooting](docs/configuration.md)
- [Compatibility findings, immutable sources, and observed verification](docs/compatibility.md)
- [Development layout and test commands](docs/development.md)

Real CLI tool execution and SDK embedding/image transports pass against isolated fixtures. Live checks cover authentication, catalog, health, and usage normalization only; live inference, billing, and native usage UI rendering remain unverified.
