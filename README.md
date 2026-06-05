# Claude Preview Patcher

A zero-dependency macOS command that creates:

```text
/Applications/Claude (Patched).app
```

from the official `/Applications/Claude.app`.

The patched copy keeps insecure HTTP restricted to localhost while allowing
secure HTTPS Preview redirects used by authentication providers such as Clerk
and WorkOS.

This project is unofficial and is not affiliated with Anthropic.

## Requirements

- macOS
- The official Claude Desktop app in `/Applications/Claude.app`
- Node.js 20 or newer, including `npm` and `npx`

No Xcode, Python, Homebrew, global npm package, or third-party runtime
dependency is required. The command verifies the built-in macOS tools it uses:
`codesign`, `ditto`, `plutil`, `ps`, and `xattr`.

The command cannot install Node.js because `npx` itself is provided by
Node.js/npm. If `node --version` is missing or older than 20, install a current
Node.js release from [nodejs.org](https://nodejs.org/) or, if you already use
Homebrew:

```sh
brew install node
```

The patcher never runs Homebrew or `sudo` for you.

## Use

Quit both the official and patched Claude apps, then check compatibility:

```sh
npx github:robinebers/claude-preview-patcher --check
```

Create or replace the patched copy:

```sh
npx github:robinebers/claude-preview-patcher
```

The command asks for confirmation before changing anything. To accept both
npx's download prompt and the patcher's confirmation in automation:

```sh
npx --yes github:robinebers/claude-preview-patcher --yes
```

Open the result after installation:

```sh
npx github:robinebers/claude-preview-patcher --open
```

Run only the dependency check:

```sh
npx github:robinebers/claude-preview-patcher --doctor
```

Use a different destination:

```sh
npx github:robinebers/claude-preview-patcher \
  --destination "$HOME/Applications/Claude (Patched).app"
```

For a reproducible invocation, pin a GitHub release tag:

```sh
npx github:robinebers/claude-preview-patcher#v0.1.0 --check
```

Do not run the command with `sudo`. If `/Applications` is not writable for your
account, use `--destination` with a folder you own.

## How It Works

The patcher does not extract or rebuild Electron's `app.asar`. It:

1. Verifies the official app's deep code signature, Anthropic identifier, and
   Anthropic team identifier.
2. Parses the existing ASAR directory and reads only `.vite/build/index.js`.
3. Requires exactly one known Preview URL restriction with the expected nearby
   context.
4. Copies Claude to a hidden staging location beside the final destination.
5. Re-verifies the staged copy against the source fingerprint.
6. Applies an equal-length byte replacement.
7. Recalculates the affected file and ASAR integrity hashes.
8. Updates Electron's `Info.plist` integrity hash and records the source ASAR
   fingerprint.
9. Removes team-bound entitlements, retains Claude's other runtime
   entitlements, and signs the copied app locally.
10. Verifies the ASAR, plist, entitlements, and deep code signature.
11. Installs the result, verifies it again, and only then deletes the previous
    patched copy.

An unknown, changed, missing, or ambiguous Claude layout fails without
replacing the existing patched app.

## Development

```sh
npm test
npm run check
```

Run the complete pipeline against a disposable copy of the installed Claude
app:

```sh
npm run test:full
```

The integration test writes only to the system temporary directory and removes
the disposable app afterward.

Preview the exact package contents that npx installs:

```sh
npm pack --dry-run
```

## Distribution

Nothing is published to the npm registry. The package is marked `"private"` to
prevent accidental npm publication. `npx` downloads the source directly from
the public GitHub repository and runs the declared command.

Create GitHub tags such as `v0.1.0` for reviewed, reproducible versions. Users
can run the latest default branch or pin a specific tag.

The repository contains only this patcher. It never contains or distributes
Claude itself.
