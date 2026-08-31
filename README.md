# llama.cpp Studio — standalone app

The same manager as the DeepSeek Harness plugin, running on its own: install
official llama.cpp builds, manage GGUF models and their launch flags, start
`llama-server` with a health-checked lifecycle, watch logs and metrics, and use
the local OpenAI-compatible API.

No harness. No npm install. Nothing to install at all, in fact — double-click
**`llama-studio.exe`** and it opens in its own window.

```powershell
.\install.cmd                 # Start menu, uninstall entry, .gguf association
```

It runs perfectly well without installing: the folder is the application, and
you can carry it on a USB stick. See **Desktop app** below for what the window
adds, and **Self-contained / portable** for what moving the folder does.

To run it as a plain local server instead — headless box, remote machine,
anything where a browser tab is the right answer — `start.cmd` does that:

```
  llama.cpp Studio 1.0.0
  URL           http://127.0.0.1:8770/
  Data          C:\Users\you\llama-studio\data
  Runtime       b10632 (CUDA)
  Models        2 registered

  Press Ctrl+C to stop.
```

## Desktop app

`llama-studio.exe` is a native Win32 shell around the same UI: a real window
with the app's icon, a taskbar button you can pin, a tray icon, and the system's
own title bar following your light/dark setting.

It hosts **WebView2** rather than bundling a browser. Windows 11 ships that
runtime as an OS component and patches it through Windows Update, so the shell
is a 320KB executable with no DLL beside it — bundling Chromium would have added
150MB and ended the "copy the folder anywhere" story for a window.

Three things it is careful about:

- **The server's lifetime is the window's.** The Node process is started with a
  pipe on its stdin and placed in a job object. Closing the window closes the
  pipe, which asks for a clean stop so `llama-server` releases its VRAM
  properly; the job object guarantees that even a crash of the shell takes the
  whole tree with it rather than leaving a model resident.
- **The port is never guessed.** The server is told `--port 0` and the name of a
  file to write its URL into, and the shell waits for that file. Picking a port
  and hoping is how a desktop shell ends up showing a blank window.
- **Nothing escapes the data folder** — including WebView2's own user-data
  directory, which defaults to `%LOCALAPPDATA%` and would quietly break a
  portable copy. It lives in `data\desktop\` with the rest.

Right-click the tray icon for *Keep running when the window is closed* — worth
turning on when a model takes minutes to load and closing the window should not
throw that away.

Building the shell needs Visual Studio Build Tools with the C++ workload; the
WebView2 SDK is vendored, so nothing is fetched:

```powershell
native\build.cmd              # -> llama-studio.exe
native\build-installer.cmd    # -> llama-cpp-studio-setup.exe (builds the app first)
node native\make-icon.js      # re-render the icon after editing its geometry
```

## Setup program

`native\build-installer.cmd` produces **`llama-cpp-studio-setup.exe`** — a single
33 MB file that installs the application on any Windows machine. Copy it to a USB
stick, a phone, a share; it needs nothing on the target but Windows.

It carries the whole application as a linked-in resource, unpacks it to a
temporary folder with `tar.exe` — in System32 since Windows 10 1803, and the same
tool the app uses for llama.cpp releases — and then runs `install.ps1` from it.

That last part is the design. Everything an install *does* already lives in
`install.ps1`, is tested, and has to keep working for anyone who unpacks the
folder and installs it by hand. Reimplementing it in C++ would give two
implementations of one install, drifting apart, creating the shortcut one way
from Setup and another from the script. So the setup program owns what a script
cannot do — a real dialog, a progress bar, no console flashing past — and
delegates the rest.

It asks about the desktop shortcut, starting at sign-in, and taking over `.gguf`,
then installs per-user with **no UAC prompt**. That last point needs the manifest:
Windows auto-elevates any unmanifested executable whose name looks like *setup*,
so an explicit `requestedExecutionLevel` is what keeps a per-user install from
demanding administrator for no reason. It also warns, without blocking, if the
WebView2 runtime is missing — that only happens on Windows older than 11.

`make-payload.js` stages the distribution from this tree: whole `src\`, `web\`
and `runtime\` (minus the harness loader the standalone app never uses), the
executable, the icon, `install.ps1`, the distribution README from
`native\dist\`, and a `package.json` trimmed to what the app actually reads. The
staging is what keeps the setup program reproducible — there is no hand-curated
folder anyone has to remember to update.

## Installing

```powershell
.\install.cmd                       # per-user, with a desktop shortcut
.\install.ps1                       # same, without the desktop shortcut
.\install.ps1 -RunAtLogin           # start it when you sign in
.\install.ps1 -DefaultForGguf       # .gguf files open here by default
.\install.ps1 -Uninstall            # remove it again
```

It installs **per user**, into `%LOCALAPPDATA%\Programs\llama.cpp Studio` — no
administrator, no UAC prompt. That is not laziness: the app keeps its models,
builds and logs in a `data` folder beside itself, and under Program Files that
folder would not be writable without either elevating or scattering the data
somewhere else. Per-user keeps the layout identical to the portable folder, so
the two really are the same application.

You get a Start menu entry, an optional desktop shortcut, a proper **Add or
remove programs** entry that uninstalls cleanly, and `.gguf` files listed under
*Open with*. Uninstalling asks before deleting your models — answer no and the
data folder is moved aside rather than removed.

An installed copy has its own empty `data` folder. To bring an existing library
across, copy your `data` folder into the install location, or point the app at
the old one with `--data`.

## How it works

The plugin was already written as plain modules over three injected services —
`fs`, `subprocess`, `timer` — plus a React UI that talks to the host through one
RPC channel. The app supplies those from Node instead of from the harness:

```
standalone/
├── src/
│   ├── main.js              boot order: manager → server → router → banner
│   ├── host.js              loads ../src/host/**  →  Manager on local services
│   ├── server.js            binds the socket, assembles the routes below
│   ├── lib/
│   │   ├── layout.js        every path, and packed-vs-in-place detection
│   │   ├── fsx.js           norm/isInside/readJson/copyDir and friends
│   │   └── args.js          table-driven option parsing for both CLIs
│   ├── cli/
│   │   ├── options.js       the llama-studio option table and --help
│   │   ├── banner.js        the startup block, formatted from `status`
│   │   ├── endpoint.js      the {url, port, pid} file a desktop shell reads
│   │   └── browser.js       hands the URL to the desktop
│   ├── http/
│   │   ├── routes.js        /, /assets/*, /api/rpc, /api/health
│   │   ├── origin.js        the remote-access allow-list (CORS)
│   │   └── respond.js       sendJson/sendText/sendFile/readBody
│   ├── repair/
│   │   ├── config.js        the seven managed directories
│   │   ├── versions.js      installed_versions.json
│   │   └── models.js        models.json
│   └── services/
│       ├── fs.js            resolve/readText/writeText/stat over node:fs
│       ├── subprocess.js    spawn + collected output + tree-scoped terminate
│       └── timer.js         timeout/interval with tracked disposal
├── web/
│   ├── index.html           app shell
│   ├── app.js               styles/host/ctx shims, mounts the plugin UI
│   ├── theme.css            the --dsw-* design tokens, light + dark
│   └── vendor/              React 18 UMD (copied by build.js, MIT)
├── native/                  the desktop shell and the setup program
│   ├── llama-studio.cpp     Win32 window + WebView2 + tray + backend lifetime
│   ├── build.cmd            compiles it with MSVC; no network, no packages
│   ├── make-icon.js         renders llama-studio.ico at every size Windows asks for
│   ├── llama-studio.rc      icon, manifest and version block
│   ├── installer.cpp        setup: dialog, unpack, delegate to install.ps1
│   ├── make-payload.js      stages the distribution and zips it for the installer
│   ├── build-installer.cmd  -> llama-cpp-studio-setup.exe
│   ├── dist/README.md       the README that ships to users
│   └── vendor/webview2/     the four SDK files build.cmd needs
├── install.ps1  install.cmd per-user install, shortcuts, uninstall entry
├── build.js                 rebuilds plugin bundles, vendors React
├── pack.js                  builds a movable, self-contained copy
├── repair-paths.js          re-points an older data directory at its new home
├── start.cmd                tray launcher; `start.cmd --console` for a console
└── tests/
    ├── smoke.js             boots the real app and drives it over RPC
    ├── paths.test.js        the folder stays self-contained when it moves
    ├── vision.test.js       the per-model vision toggle, end to end
    └── router.test.js       router mode: presets, model ids, load/unload
```

The browser half is the plugin's **own** `dist/client.bundle.js`, served
unmodified — the app and the harness plugin can never drift apart. Because the
UI paints from `--dsw-alias-*` tokens, `web/theme.css` simply defines that same
contract, and the header's Theme button switches light / dark / system.

## Self-contained / portable

```powershell
node standalone\pack.js
```

That vendors everything the app needs into the folder itself:

```
standalone\
├── llama-studio.exe     the desktop app — double-click this
├── install.cmd          optional: Start menu, uninstall entry, .gguf
├── start.cmd            the same app in a console, opening your browser
├── runtime\
│   ├── node.exe         the Node runtime (~87 MB)
│   ├── host\            the plugin's host modules
│   └── client.bundle.js the UI
├── src\  web\  tests\  native\
├── PORTABLE.md
└── data\                created on first run once the folder is moved out
```

Now **move the folder anywhere** — another drive, a USB stick, another PC — and
run `llama-studio.exe`. Nothing needs to be installed; on Windows 11 the
WebView2 runtime the window uses is already part of the OS.

### Moving a folder that already holds data

`config.json` records the managed directories as absolute paths, so a folder
that is renamed or copied elsewhere arrives carrying the old machine's layout.
The app resolves that on **every** start, not just the first: a managed
directory is either *default* — `<data>/bin`, `<data>/models`, wherever the
folder happens to be right now — or *custom*, somewhere you pointed it on
purpose. Only the custom ones are recorded (`customPaths` in `config.json`);
the rest are re-derived from the folder's real location, and every one that
moves is written to the log.

Recorded intent rather than inspection, because inspection cannot work here:
the moment the app writes a helper script or a metadata file it recreates the
very directories a "did this folder move?" test was supposed to notice were
gone, and the leftover then looks alive enough that nothing can tell it from a
real data directory. That is the failure this replaced — a folder moved to a
new drive quietly rebuilding half its tree back on the old one, forever.

So:

- **you moved the folder** — everything follows it, including builds and models
  recorded inside `data\bin` and `data\models`;
- **you pointed models at a bigger drive** — it stays there across every move,
  and is the only place outside the folder the app will write;
- **you want two folders to share one set of models** — that is `--data <dir>`,
  said out loud, rather than a copy quietly reaching back at its original.

Installed builds and registered models carry absolute paths too. The app
re-points those as it reads them, so a moved folder works straight away, but the
metadata files are only rewritten on the next install or import. To write the
repair back now, and to see what cannot be repaired:

```powershell
node repair-paths.js --dry-run    # show what would change
node repair-paths.js              # rewrite the recorded paths
node repair-paths.js --all        # also pull back directories you moved yourself
```

Models imported *by reference* point at files outside this folder, which the app
never moved: on a machine that does not have them you either put the file where
the entry expects it or re-import the model. Those are listed, not guessed at.

- `--out <dir>` also writes a copy to `<dir>` instead of moving this one.
- `--no-node` packs without the Node runtime (~2 MB; needs Node 18+ on PATH).

Data follows the folder: a packed folder always uses its own `.\data`, and an
unpacked checkout still sitting inside the plugin shares the plugin's directory
(same builds and models as the harness plugin). `--data <dir>` overrides either
default.

A packed folder never consults its surroundings — not for host modules, not for
the UI bundle, not for its data directory. `build.js` and `pack.js` read the
plugin repository, so both detect a packed folder and decline rather than
reaching one level up for whatever happens to be next to it.

## Options

| Flag | Meaning |
| --- | --- |
| `--port <n>` | UI port (default `8770`; `0` picks a free one) |
| `--host <addr>` | UI bind address (default `127.0.0.1`) |
| `--data <dir>` | managed data directory (default: `.\data` when packed, the plugin's directory when running in place) |
| `--no-open` | don't launch a browser |
| `--status` | print the full status as JSON and exit |
| `--version`, `--help` | as expected |

## Server mode

Server Config → **Mode** picks how `llama-server` is run.

**Single model** (default) is the original behaviour: choose a model on the
Dashboard, start it, and the endpoint serves that one until you stop it.

**Router** hands `llama-server` your whole library at once. It binds the port
itself and spawns a child server per model on demand, so a client selects a
model by name in the request:

```json
{ "model": "qwen3-coder-30b", "messages": [ … ] }
```

The Dashboard lists what the router is offering, each model's load state, and a
Load / Unload button for driving it by hand. The names come from the file names,
and they are shown before you start it too — you need them to configure a client.

Two things make this more than `--models-dir`, which llama.cpp also offers:

- **Your launch flags follow the model.** The router is started over a preset
  file that Studio regenerates from the library on every launch, with one
  section per model built by the same command builder the single-model path
  uses. Context size, GPU layers, KV cache types, `--n-cpu-moe`, the vision
  toggle, extra CLI arguments — all of it lands in that model's section.
  `--models-dir` would serve the same files on stock defaults.
- **`--models-dir` is not recursive**, and Studio stores models as
  `data\models\downloaded\<repo>\*.gguf`, so pointing llama.cpp at the models
  directory finds nothing.

| Setting | Meaning |
| --- | --- |
| Models loaded at once (`--models-max`) | Each loaded model holds its weights in memory. Default `1` — llama.cpp's own default is 4, which does not fit two 20GB models on one desktop GPU; at 1 the router swaps. `0` = no limit. |
| Load on demand (`--models-autoload`) | Load a model on the first request that names it. Off means it only loads when you load it from the Dashboard. |

Server-scoped settings — API key, TLS, the built-in web UI — belong to the
router, which is the process actually listening; they are not copied into the
child servers. Router mode needs a llama.cpp build with `--models-preset`;
an older one is refused at launch with a message saying so rather than started
blind. The generated preset is written to `<data>\configs\router-presets.ini`;
it is regenerated every start, so edit Model settings rather than that file.

## Data directory

Defaults to `.\data` inside the app folder — builds, models, per-model settings,
logs and `config.json`, all of it inside the folder you can pick up and move.
An unpacked checkout still sitting inside the plugin instead defaults to the
plugin's runtime directory (`plugins/llama_cpp`), so it sees the builds and
models you already have there, and anything you do shows up in the harness
plugin too. Point `--data` at a directory for a separate installation, or to
share one set of models between two copies of the app:

```powershell
node src\main.js --data D:\llama-studio
```

Everything the app writes on its own — `config.json`, the metadata registries,
per-model settings, the helper PowerShell scripts, the logs — stays inside the
data directory. That is enforced, not merely intended: the filesystem service
the manager runs on refuses writes outside it, and the only exception is a
directory you pointed elsewhere yourself in Settings. Reads are not fenced,
because a model imported by reference lives wherever you keep it.

Run one manager at a time against a directory: two instances would fight over
`config.json` and the server port. The plugin refuses to start a second server
on a port that is already in use, so the failure is loud rather than silent.

## Security

- The HTTP server binds `127.0.0.1` only.
- Every RPC call needs a random per-run token that is embedded in the page it
  serves, and the `Origin` header must be local — a random website in another
  tab cannot drive the app.
- The API is *not* authenticated beyond that; treat it as a local desktop app,
  not a service to expose. Binding `--host 0.0.0.0` is not supported.
- `llama-server` itself still binds whatever you set in Server Config
  (localhost by default).

## Testing

```powershell
node tests\smoke.js                # boots the app in a scratch data dir
node tests\smoke.js --data D:\llama-studio
node tests\paths.test.js           # the folder stays self-contained when it moves
node tests\vision.test.js          # the per-model vision toggle, end to end
node tests\router.test.js          # router mode: presets, ids, load/unload
npm test                           # all four
```

`smoke.js` checks the server, the token gate, the served bundle, and drives real
commands (`status`, `settings.get/update`, `diagnostics`, `hardware`) against
your machine. `paths.test.js` moves a data directory out from under the manager
and checks that the managed directories follow the folder, that a directory you
chose yourself does not, and that nothing is written outside either way.
`vision.test.js` plans real launches against a stub build and checks that
turning vision off actually drops `--mmproj`, however the projector was found.
`router.test.js` checks that every model reaches the generated preset with its
own flags and that the router's address and API key are not copied into the
children; if a llama.cpp build with router support is installed in `.\data` it
also starts the real router and drives its load/unload API, and otherwise says
it skipped that part.

They keep their scratch data in a `.tmp` directory inside the app folder and
remove it afterwards — the suite that proves the folder is self-contained has no
business writing to the system temp directory either.

The plugin's own suite still covers the logic underneath:

```powershell
node tests\run-all.js
```

## Platform

Windows-first, like the plugin: hardware detection, file operations and the
GGUF scanner run through PowerShell helpers, and the release selector picks
Windows assets. The service layer is portable; adding another platform means
providing equivalents for those helpers in `src/host/modules/exec.js`.
