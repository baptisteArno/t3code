# Personal fork of T3 Code

Branch `custom-nightly` of `baptisteArno/t3code` is the newest upstream nightly tag plus a short
series of commits. Each release of this fork is published as a prerelease of `baptisteArno/t3code`
with **the version of the upstream nightly it is based on**, or that version's next build number
for a release that cannot wait (see below), and holds:

- the signed, notarized macOS arm64 desktop app, its blockmaps and `nightly-mac.yml`;
- the linux-x64 server archive `t3-<version>-linux-x64.tar.gz` and its `SHA256SUMS`, for the home
  server.

The same run uploads the iOS app to TestFlight (see [iOS app](#ios-app)).

## How updates reach the app and the home server

The installed app updates itself from this fork's releases: the build bakes
`T3CODE_DESKTOP_UPDATE_REPOSITORY=baptisteArno/t3code` into `app-update.yml`. **Update** in the app
then asks every server it reaches to move to the app's version. A server downloads that version from
`T3CODE_RELEASE_BASE_URL` when set, otherwise from `pingdotgg/t3code`. The home server sets it to
this fork's releases (see [Home server](#home-server)), so it runs the fork's build; any other host
keeps the official build of the same version.

The version stays upstream's so both kinds of server keep the official version order, and the
official iOS app and hosted web app keep talking to them.

## Rules for fork changes

A client running the official build (the iOS app, app.t3.codes) and a server running the official
build (any host but the home server) must keep working with the fork. So a fork change:

- stores new preferences in client settings (`ClientSettingsSchema`), never in server settings;
- adds to what crosses the wire only optional fields that older peers may omit or ignore; it never
  renames, removes or makes a field required, and adds no RPC method a client depends on;
- adds no database migration, persisted event or projection column: a database that has one refuses
  every official build, so the home server could never go back to upstream;
- leaves the service launcher protocol and the release download code alone.

## Fork commits

Keep this list in step with `git log <upstream tag>..custom-nightly`: one commit per divergence from
upstream, each covering every surface it touches.

| Commit                                               | Upstream                                                 | Drop when                                |
| ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `build(desktop): sign macOS builds without passkeys` | none                                                     | upstream signs without a passkey profile |
| `chore(fork): nightly release` (this folder)         | fork only                                                | never                                    |
| `feat(sidebar): Oldest first …`                      | [#26380](https://github.com/pingdotgg/t3code/pull/26380) | #26380 is merged                         |
| `feat: dark code surfaces use Catppuccin …`          | none                                                     | the user wants the default theme back    |
| `feat: Next thread after sending …`                  | none                                                     | upstream ships an equivalent             |
| `feat(web): right panel keeps one width …`           | none                                                     | upstream ships an equivalent             |
| `feat: a file the agent mentions opens its diff …`   | none                                                     | upstream ships an equivalent             |
| `build(mobile): build the iOS app under another …`   | none                                                     | upstream supports another Apple team     |
| `feat(web): the update button waits for a T3 Code …` | none                                                     | upstream ships an equivalent             |
| `feat(sidebar): Oldest first lifts threads …`        | none                                                     | upstream ships an equivalent             |
| `fix: a thread its agent settles no longer …`        | none                                                     | upstream no longer notifies for it       |
| `feat: t3.json hides and orders files in diffs`      | none                                                     | upstream ships an equivalent             |
| `test(web): keyboard menu and right panel …`         | none                                                     | upstream's tests pass on macOS           |
| `feat: a focused thread opens on its latest prompt`  | none                                                     | upstream ships an equivalent             |
| `feat: Catppuccin built-in theme`                    | none                                                     | the user wants the default theme back    |
| `feat(mobile): diff file tree with git status`       | none                                                     | upstream ships an equivalent             |
| `fix(mobile): builds with T3 Connect no longer …`    | none                                                     | upstream fixes the early import          |
| `fix(mobile): a forced dark theme gets a light …`    | none                                                     | upstream fixes the iOS status bar        |
| `feat(web): Mod+Enter keeps you on the thread`       | none                                                     | upstream ships an equivalent             |
| `feat(web): notifications can wait until a thread …` | none                                                     | upstream ships an equivalent             |
| `fix(web): a diff file you open no longer waits …`   | none                                                     | upstream prioritizes opened diff files   |
| `feat: wakes from a response's own work fold …`      | none                                                     | upstream ships an equivalent             |
| `feat: the app is called Cadence`                    | none                                                     | the user wants the T3 Code name back     |
| `feat(mobile): thread header has Diff, Settle …`     | none                                                     | upstream ships an equivalent             |
| `feat(mobile): navigation tabs can be hidden …`      | none                                                     | upstream ships an equivalent             |
| `feat(mobile): the unfolded Duo's New task sits …`   | none                                                     | upstream ships an equivalent             |
| `feat: a settled response folds the text …`          | none                                                     | upstream ships an equivalent             |
| `fix: a thread that finished while a device slept …` | none                                                     | upstream ships an equivalent             |
| `feat(web): Enter on an effort level closes …`       | none                                                     | upstream ships an equivalent             |
| `fix: Changes no longer counts base commits …`       | none                                                     | upstream ships an equivalent             |
| `feat: a push service on the home server …`          | none                                                     | upstream signs pushes for another team   |
| `test(server): the background Git lane test …`       | none                                                     | upstream's test passes on macOS          |

## Adding a change

The T3 project `t3code-fork` exists on the Macbook and the home server, both at
`~/Dev/forks/t3code-fork` with `origin` = `baptisteArno/t3code` and `upstream` = `pingdotgg/t3code`.
`custom-nightly` is the fork's default branch and the source of truth, so a change can start on
either machine. Work in a worktree from `origin/custom-nightly`, never in a project's main checkout:
on the Macbook it is the nightly job's builder and must stay clean on `custom-nightly`. Follow
[Rules for fork changes](#rules-for-fork-changes) and run `vp run check:changed <upstream tag>`.

The history of `custom-nightly` is meant to be rewritten: it exists to show what the fork changes,
one commit per divergence, and nothing else builds on it.

- A new divergence is one new commit.
- A change to an existing one (bringing a web feature to mobile, fixing it, dropping part of it) is
  folded into that commit (`git commit --fixup=<commit>`, then `git rebase -i --autosquash`), and
  the commit message is updated to describe the result.
- `fork/` belongs to the `chore(fork): nightly release` commit only, the table above included: add or
  edit a row there, never in the feature commit, so rewrites never conflict on the table.

A change is done only once it is on `origin/custom-nightly`; [AGENTS.md](AGENTS.md) holds what that
means for agents. To land a change, fetch, rebase onto `origin/custom-nightly`, then push with a
lease on the commit you rebased onto, so a change landed meanwhile is refused instead of erased:
`git push --force-with-lease=custom-nightly:<that commit> origin HEAD:custom-nightly`. The nightly job
follows a rewritten `origin/custom-nightly` when its own checkout holds nothing unpushed, and stops
otherwise.

A version is released only once, so a landed change ships with the next upstream nightly at the
06:00 run, or at once with `fork/nightly.sh --next`. That run releases the newest upstream nightly's
next build number, `0.1.11-nightly.20261117.4826` on `…4825`: the same form, so clients still read
it as Nightly, and ordered after its base and before upstream's next nightly, which servers then
accept as newer. Only fork builds know that version, so update to it only hosts that run the fork.
If upstream later tags that exact number, the scheduled run finds it released and waits for the
next nightly.

Start a run by hand from a T3 Code thread on the Macbook, not over SSH: its iOS step signs with the
login keychain, which only the GUI session reaches (`errSecInternalComponent` otherwise).

## Nightly release

`fork/nightly.sh` on the Macbook works on the main checkout `~/Dev/forks/t3code-fork`, even when
started from one of its worktrees:

1. Exits if the fork already published a release for the newest upstream nightly tag. A leftover
   draft from a run that died mid-publish is deleted and rebuilt.
2. Rebases `custom-nightly` onto that tag. On a conflict it stops with exit code 2.
3. Runs `vp i` and `vp run check:changed <tag>`.
4. Builds with `--signed`, `T3CODE_MACOS_SIGN_WITHOUT_PASSKEYS=1` and the signing env at
   `~/.config/t3code-fork/signing.env` (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_PATH`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; never commit it).
5. Verifies the signature, notarization and update feed, and force-pushes the branch.
6. Pipes `fork/linux-cli-archive.sh` over SSH to the Linux builder (`nuc`, or
   `T3CODE_FORK_LINUX_BUILDER`). It builds the pushed commit's linux-x64 server archive with
   upstream's release steps and smoke-tests it. The script copies the archive back, checks its hash
   and writes `SHA256SUMS`.
7. Creates the release as a draft with every asset and upstream's release notes, then publishes it,
   so the desktop updater and servers never see a release with missing files.
8. Runs `fork/ios-testflight.sh`. A failure there exits with code 4, after the release is out.

`fork/nightly.sh --no-publish` builds and verifies the macOS app without pushing or publishing; the
Linux archive needs a pushed commit, so it is skipped.

## iOS app

`fork/ios-testflight.sh` builds the production variant as `com.baptistearno.t3code`, signed by team
`YJ5SMWX927`, and uploads it to the App Store Connect app **T3 Code (fork)**; TestFlight installs it
on the iPhone. `T3CODE_IOS_TEAM_ID` and `T3CODE_IOS_BUNDLE_ID` (`apps/mobile/app.config.ts`) switch
the app to that team. Xcode's automatic signing, with the API key of the signing env, registers the
App IDs, the App Group and the profiles itself. That key needs the Admin role: Apple's cloud signing
refuses App Manager and Developer keys. The script never relies on the Apple account signed in to
Xcode, whose session Apple expires every few days. `--no-upload` only writes a signed `.ipa` to
`release/ios`.

Lost against the official app, because T3's services only trust apps of T3's team: `app.t3.codes`
links opening the app, in-app passkeys and Sign in with Apple, and OTA updates (the Expo project is
T3's; each change ships as a new TestFlight build). Notifications and Live Activities go through the
[push service](#push-service) instead of the relay, which signs APNs with T3's key.

## Home server

The home server (`nuc`, Linux x64) both builds the Linux archive and runs it.

- Builder: `fork/linux-cli-archive.sh` keeps a detached worktree at `~/Dev/forks/t3code-fork-linux`
  (created on first run from `~/Dev/forks/t3code-fork`) and the two newest archives in
  `~/Dev/forks/t3code-fork-linux-releases`. It needs `node`, `vp`, `cargo` (rustup, minimal
  profile) and `patchelf` (the official static build in `~/.local/bin`); the Macbook reaches it with
  `ssh nuc` over Tailscale.
- Update source: `~/.t3/service.env` holds
  `T3CODE_RELEASE_BASE_URL=https://github.com/baptisteArno/t3code/releases/download`, read when the
  service starts (`t3 service restart` after a change). `~/.config/nuc-dev/env.sh` exports the same
  variable, so a `t3 update` typed in a shell downloads from the fork too.

Traps:

- A server never reinstalls a version it already has, and only accepts a newer one. A version first
  installed from upstream stays upstream's build until the next version.
- `t3 update` without a version picks upstream's newest nightly, which fails until the fork has
  released it. Update the home server with **Update** in the app, or `t3 update <exact version>`.
- To go back to upstream, remove the variable from both files and restart the service; the current
  version stays the fork's build until the next one.

### Push service

T3's relay signs APNs with T3's key, which Apple refuses for this app's bundle. A build that sets
`T3CODE_PUSH_SERVICE_URL` and `T3CODE_PUSH_SERVICE_TOKEN` (in the Macbook checkout's `.env.local`,
since `fork/nightly.sh` resets `.env` from `.env.example`) sends
its device and Live Activity registrations to `infra/relay/scripts/push-service.ts` on the home
server instead. That service connects to each listed environment as a read-only client, works out
each thread's activity as the server would publish it to the relay, merges every environment into
one Live Activity, and calls APNs with the fork team's own key. No T3 server is changed; the app
still signs in to T3 Connect, which gates the notification settings.

- Files, all `0600` in `~/.config/t3code-push/`: `config.json` (shape in `push-service.ts`), the
  APNs key `AuthKey_<key id>.p8` (team `YJ5SMWX927`, Sandbox & Production), `app-token` (the same
  value as `T3CODE_PUSH_SERVICE_TOKEN`), and one token per environment from
  `t3 auth session issue --scope orchestration:read --ttl 365d --label "Push service" --token-only`
  run on that host. Device state lives at the config's `stateFile`.
- The Macbook's desktop server must be reachable from the NUC over Tailscale (its network access
  setting); its `wsUrl` is its tailnet address plus `/ws`.
- It runs from a detached worktree `~/Dev/forks/t3code-fork-push` at the released commit, as the user
  unit `t3code-push.service` (`node infra/relay/scripts/push-service.ts --config …`), listening on
  loopback `4460`. `tailscale serve --https=8460` publishes it to the tailnet as
  `T3CODE_PUSH_SERVICE_URL` (`https://nuc.taild38c89.ts.net:8460`).
- Logs: `journalctl --user -u t3code-push`. Each delivery logs its APNs status; `BadDeviceToken`
  with a real key means the key is right and the token is stale, `InvalidProviderToken` means the
  key, its id or the team is wrong.
- An environment token expires after its TTL; the service then logs a reconnect every 5 s. Issue a
  new one and restart the unit.

### Rebasing onto upstream

Whoever rebases `custom-nightly` onto a newer upstream nightly, by hand or after `fork/nightly.sh`
stopped on a conflict, reviews every fork commit against what upstream changed since the previous
base, not only the commits that conflict:

- **Drop it** when upstream fixed the bug or shipped the feature, even in another shape that covers
  the same need, or merged the PR in its Upstream column: `git rebase --skip`, or drop it from the
  todo list, and remove its row.
- **Adapt it** when upstream added something the commit can reuse (a setting, a helper, a
  component, a rule) or reworked the code it builds on, so the commit now duplicates or works around
  upstream. Rewrite it on upstream's way, smaller where it can be, and update its message.
- Otherwise keep it as is.

`git log --oneline <previous tag>..<new tag> -- $(git show --name-only --format= <fork commit>)`
lists the upstream commits that touched the same files, the first place to look. Name the commits
dropped or adapted, and why, in the reply or PR that reports the rebase.

On a conflict, keep upstream's code and reapply the fork commit's intent on top of it. Then
`git rebase --continue` and rerun `fork/nightly.sh`; its `check:changed` must pass before anything
is published. A nightly rebase that applies cleanly runs unattended and skips this review, so do it
at the next hand rebase or fork change.

## Trade-offs

- In-app passkeys are off: they need this app ID's Apple team in T3's Clerk configuration. Other
  sign-in methods work.
- Switching from the official app needs one manual install, since an app signed by another team
  cannot update into this one.
