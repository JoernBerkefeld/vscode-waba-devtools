# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/).

## [0.0.1] - unreleased

### Added

- Templates view with the status of each template in the target stage.
- Commands for check, discover, list, retrieve, CSV import, deploy (template files, source stage,
  CSV, backup set), prune, restore points and compare, driven through the bundled `waba` CLI.
- Preview and confirmation before every deploy, which then sends exactly the confirmed preview
  (`--expect`); prune only from the Command Palette.
- Access tokens from the environment, `.env` or VS Code secret storage.
- Discover optionally asks for the business portfolio ID, shows when the token expires and, when
  Meta cannot list the WABAs, offers to retry with the portfolio ID or to enter the WABA IDs by
  hand.
- Check Access warns when Meta has disabled a WABA, in the output and as a notification.
- `.wabadevrc.json`, `.env` and backup manifests saved with a UTF-8 byte-order mark are read
  correctly.
