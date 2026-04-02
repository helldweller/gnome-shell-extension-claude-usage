Claude Usage
====================================

Claude Usage is a GNOME Shell extension for displaying your [Claude AI](https://claude.ai) usage limits in the GNOME Shell top bar. It shows your 5-hour and 7-day usage percentages along with time remaining until your quota resets. Uses asynchronous polling for a smooth experience.

![Screenshot](https://raw.githubusercontent.com/stfnRO/gnome-shell-extension-claude-usage/main/screenshot.png)

## Features

- **5-hour window usage** — your short-term rate limit utilization
- **7-day window usage** — your weekly rolling limit utilization
- **Reset countdown** — time remaining until your 5-hour quota resets
- **Color-coded** — white (normal), yellow (>50%), red (>80%)
- **Click for details** — dropdown menu with detailed stats, refresh button, and quick link to claude.ai
- **Auto-detect credentials** — reads your OAuth token from Claude Code automatically
- **Configurable** — refresh interval, panel position, manual token override

## Installation

### 1) Install the extension

#### From source

    git clone https://github.com/stfnRO/gnome-shell-extension-claude-usage.git
    cd gnome-shell-extension-claude-usage
    bash install.sh

#### Manual

    mkdir -p ~/.local/share/gnome-shell/extensions
    cp -r . ~/.local/share/gnome-shell/extensions/claude-usage@stefanfluit.com
    glib-compile-schemas ~/.local/share/gnome-shell/extensions/claude-usage@stefanfluit.com/schemas/

### 2) Restart GNOME Shell

On Wayland, log out and log back in. On X11, press `Alt+F2`, type `r` and press Enter.

### 3) Enable the extension

    gnome-extensions enable claude-usage@stefanfluit.com

Or use the Extensions app / Extension Manager to toggle it on.

## Authentication

The extension needs an OAuth token to fetch your usage data from the Anthropic API.

### Automatic (recommended)

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in, the extension automatically reads your token from `~/.claude/.credentials.json`. No configuration needed.

### Manual

If you don't use Claude Code:

1. Open [claude.ai](https://claude.ai) in your browser and log in
2. Open DevTools (`F12`) → Application → Cookies → `claude.ai`
3. Find the cookie named `sessionKey` (starts with `sk-ant-`)
4. Copy the value
5. Open extension preferences and paste it in the "Manual token" field

To open preferences:

    gnome-extensions prefs claude-usage@stefanfluit.com

## Supported GNOME versions

- GNOME Shell 45, 46, 47, 48, 49

## How it works

The extension polls the Anthropic OAuth usage API (`https://api.anthropic.com/api/oauth/usage`) at a configurable interval (default: 3 minutes). The API returns utilization percentages for different rate limit windows:

| Field | Description |
| --- | --- |
| `five_hour` | Short-term rate limit (resets every 5 hours) |
| `seven_day` | Weekly rolling rate limit |
| `seven_day_sonnet` | Separate Sonnet model limit (shown in dropdown if available) |

## Development Commands

| Description | Command |
| --- | --- |
| Enable extension | `gnome-extensions enable claude-usage@stefanfluit.com` |
| Disable extension | `gnome-extensions disable claude-usage@stefanfluit.com` |
| Open preferences | `gnome-extensions prefs claude-usage@stefanfluit.com` |
| View logs | ``journalctl --since="`date '+%Y-%m-%d %H:%M'`" -f \| grep "Claude Usage"`` |
| Compile schemas | `glib-compile-schemas --strict schemas/` |
| Launch nested Wayland session | `dbus-run-session -- gnome-shell --nested --wayland` |
| Read settings | `dconf dump /org/gnome/shell/extensions/claude-usage/` |

## Disclaimer

This extension is not affiliated with or endorsed by Anthropic. Usage data is obtained from the Anthropic API. The authors are not responsible for improperly represented data. No warranty expressed or implied.

## License

MIT
