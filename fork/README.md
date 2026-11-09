# Personal fork of T3 Code

Branch `custom-nightly` of `baptisteArno/t3code` is the newest upstream nightly tag plus a short
series of commits. Each release of this fork is a signed, notarized macOS arm64 desktop app with
**the exact version of the upstream nightly it is based on**, published as a prerelease of
`baptisteArno/t3code`.

## Why the version stays upstream's

The installed app updates itself from this fork's releases: the build bakes
`T3CODE_DESKTOP_UPDATE_REPOSITORY=baptisteArno/t3code` into `app-update.yml`. **Update** in the app
then asks every server it reaches to move to the app's version, and each server downloads that
version from `pingdotgg/t3code`. Because the fork reuses upstream's version, the home server and
any other host stay on the official build, and the official iOS app keeps talking to them.

So the fork changes only what runs in the desktop renderer, and stores new preferences in client
settings (`ClientSettingsSchema`), never in server settings: a server running the official build
would not know a new server key. A change that needs the server is out of scope for this fork.

## Fork commits

Keep this list in step with `git log <upstream tag>..custom-nightly`.

| Commit                                               | Upstream                                                 | Drop when                                |
| ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `build(desktop): sign macOS builds without passkeys` | none                                                     | upstream signs without a passkey profile |
| `chore(fork): nightly release` (this folder)         | fork only                                                | never                                    |
| `feat(sidebar): Oldest first …`                      | [#26380](https://github.com/pingdotgg/t3code/pull/26380) | #26380 is merged                         |

## Nightly release

`fork/nightly.sh` on the Macbook, from this checkout (`~/Dev/forks/t3code-nightly`):

1. Exits if the fork already has a release for the newest upstream nightly tag.
2. Rebases `custom-nightly` onto that tag. On a conflict it stops with exit code 2.
3. Runs `vp i` and `vp run check:changed <tag>`.
4. Builds with `--signed`, `T3CODE_MACOS_SIGN_WITHOUT_PASSKEYS=1` and the signing env at
   `~/.config/t3code-fork/signing.env` (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_PATH`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; never commit it).
5. Verifies the signature, notarization and update feed, force-pushes the branch, and publishes the
   DMG, ZIP, blockmaps and `nightly-mac.yml` with upstream's release notes.

`fork/nightly.sh --no-publish` builds and verifies without pushing or publishing.

### Resolving a rebase conflict

Keep upstream's code and reapply the fork commit's intent on top of it. If upstream now contains a
change this fork carries (see the table), drop the fork commit with `git rebase --skip` and remove
its row. Then `git rebase --continue` and rerun `fork/nightly.sh`; its `check:changed` must pass
before anything is published.

## Trade-offs

- In-app passkeys are off: they need this app ID's Apple team in T3's Clerk configuration. Other
  sign-in methods work.
- Switching from the official app needs one manual install, since an app signed by another team
  cannot update into this one.
