# WABA DevTools for VS Code

Retrieve, deploy, back up and compare **WhatsApp Business message templates** across WhatsApp
Business Accounts (WABAs) without leaving VS Code — for example one WABA per pipeline stage
(dev → qa → prod).

The extension runs the [`waba`](https://github.com/JoernBerkefeld/waba-devtools) CLI, which it
bundles: there is nothing else to install.

## Features

- **Templates view** in the activity bar: your template files grouped by name and language, with
  each template's status in the target stage (APPROVED, PENDING, …) and what a deploy would do
  (create, update, unchanged). Templates that exist only in the target WABA are listed separately.
- **Retrieve** templates from a stage into `templates/<name>/<language>.json`.
- **Deploy** template files, another stage's WABA, a CSV file or a backup set to a stage — always
  with a preview first and a confirmation that lists every template that will be created, updated
  or deleted.
- **Import CSV** (Google Sheets export) into template files.
- **Restore points**: create them, restore them into a WABA, compare them with each other or with
  what is live right now, or compare two WABAs live.
- **Check access** and **discover** the WABAs a token can reach.
- **Access tokens** from the environment, the project's `.env` file, or stored in VS Code's secret
  storage.
- Right-click menus on template files and folders, `.csv` files and backup-set folders.

## Requirements

- **Node.js** `^22.22.2 || >=24.15.0` on your `PATH` (the bundled CLI runs on it).
- A project folder with a `.wabadevrc.json` — see the
  [waba README](https://github.com/JoernBerkefeld/waba-devtools#configuration--wabadevrcjson)
  for the format.
- A Meta system-user access token — the
  [waba-devtools README: Access tokens](https://github.com/JoernBerkefeld/waba-devtools#access-tokens)
  walks through Meta's screens.

## Getting started

1. Open the folder that contains `.wabadevrc.json`.
2. Enter the **WABA IDs** in `.wabadevrc.json`: [Business settings → Accounts → Messaging accounts](https://business.facebook.com/latest/settings/whatsapp_account) shows each one as "ID: …" under the account name (add `&locale=en_US` to the address for English).
   **Discover WABAs for a Token…** can list them too: for tokens that Meta describes, or, with the
   portfolio ID, for tokens that have the `business_management` permission (see
   [Access tokens](https://github.com/JoernBerkefeld/waba-devtools#access-tokens)). When neither
   works, Discover offers to let you enter them by hand.
3. Provide the tokens named in `tokenEnv`: as environment variables, in a `.env` file next to
   `.wabadevrc.json` (add it to `.gitignore`), or with **WABA DevTools: Set Access Token…**. A
   system user only reaches the WABAs of its own business portfolio, so WABAs in different
   portfolios need different tokens (different `tokenEnv` names).
4. Run **WABA DevTools: Check Access**.
5. Click the `WABA: … → …` status bar item to select the **source** and **target** stage.
6. **Retrieve from Source Stage**, edit, then **Deploy Template Files to Target Stage…**.

## Commands

| Command                                     | What it does                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check Access                                | Tests every WABA's token and access, and shows where each token comes from.                                                                                                                                                                                       |
| Discover WABAs for a Token…                 | Lists the WABAs (with names and phone numbers) a token can reach, and when the token expires. Optionally asks for the business portfolio ID (the number after `business_id=` in the Business settings address bar), which Meta needs for most system-user tokens. |
| List Templates in a Stage…                  | Lists name, language, category and status of every template.                                                                                                                                                                                                      |
| Retrieve from Source Stage                  | Downloads templates into files (only the selected ones when run on a selection).                                                                                                                                                                                  |
| Import CSV into Template Files              | Turns a Google Sheets CSV export into template files. Sends nothing.                                                                                                                                                                                              |
| Deploy Preview (dry run)                    | Shows what a deploy would do. Sends nothing.                                                                                                                                                                                                                      |
| Deploy Template Files to Target Stage…      | Preview → confirm → deploy the files (or the selected templates).                                                                                                                                                                                                 |
| Deploy Source Stage to Target Stage…        | Copies the source stage's WABA to the target stage, WABA to WABA.                                                                                                                                                                                                 |
| Deploy CSV to Target Stage…                 | Deploys straight from a CSV file.                                                                                                                                                                                                                                 |
| Deploy with Prune (delete extra templates)… | Makes the target match the source exactly, deleting templates only in the target.                                                                                                                                                                                 |
| Restore Backup Set to a WABA…               | Deploys a backup set back into a WABA.                                                                                                                                                                                                                            |
| Create Restore Point…                       | Saves the templates of a stage's WABAs as backup sets, without deploying.                                                                                                                                                                                         |
| Compare Backup Sets… / with Live WABA…      | Opens a report of added, removed and changed templates.                                                                                                                                                                                                           |
| Compare Two WABAs (live)…                   | Same, for two WABAs as they are right now.                                                                                                                                                                                                                        |
| Select Source Stage / Select Target Stage   | Chooses the stages used by retrieve and deploy.                                                                                                                                                                                                                   |
| Set Access Token… / Remove Stored Token…    | Manages tokens in VS Code's secret storage.                                                                                                                                                                                                                       |

## Safety

- Every deploy shows a **preview first** (`--dry-run`). Nothing is sent until you confirm the
  dialog, which lists each template that will be created, updated or deleted per WABA.
- The deploy then sends **exactly what the preview showed** (the CLI's `--expect`). A WABA that
  changed in the meantime gets nothing and is reported as "changed since preview" — run the
  deploy again to see the new plan.
- **Prune** (deleting templates) is only available from the Command Palette, never from a context
  menu, and only for full-set deploys (template files or a whole stage).
- By default every WABA that is about to change is **backed up first** (setting
  `waba-devtools.deployBackup`). Restore points can be deployed back with **Restore Backup Set to a
  WABA…**.
- Created and updated templates are reviewed by Meta again and show `PENDING` for a while.

## Access tokens

How to create a token in Meta's Business settings:
[waba-devtools README: Access tokens](https://github.com/JoernBerkefeld/waba-devtools#access-tokens).

The CLI needs one token per `tokenEnv` name in `.wabadevrc.json`. Where it comes from, in order:

1. an environment variable of that name (e.g. set in your shell before starting VS Code),
2. the project's `.env` file,
3. a token stored with **Set Access Token…** (VS Code secret storage).

A stored token is passed to the CLI only as that environment variable — never on the command line
and never written to the output. **Check Access** shows which source each name uses.

## Settings

| Setting                       | Default   | Meaning                                                                                                         |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `waba-devtools.cliSource`     | `auto`    | `auto`: the project's own `node_modules/waba-devtools` if installed, else the bundled CLI. `bundled`. `custom`. |
| `waba-devtools.customCliPath` | —         | Absolute path of a `bin/waba.js`, used with `cliSource: custom`.                                             |
| `waba-devtools.backupFolder`  | `backups` | Folder for backup sets (relative to the project).                                                               |
| `waba-devtools.deployBackup`  | `before`  | `none`, `before` (back up each changed WABA first), or `beforeAndAfter`.                                        |

## Development

```bash
npm ci --no-workspaces
npm run compile
npm run lint
npm test
```

Press F5 in VS Code to start the Extension Development Host. `npm run bundle:cli` stages the CLI
version pinned in `package.json`. To try an unreleased CLI, stage it from a local checkout instead:

```bash
WABADEV_BUNDLE_SOURCE=../waba-devtools npm run bundle:cli
```

or set `waba-devtools.cliSource` to `custom` and `waba-devtools.customCliPath` to the checkout's
`bin/waba.js`.

## License

MIT © Jörn Berkefeld
