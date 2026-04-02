import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

let claudeMenu;

var ClaudeUsageButton = GObject.registerClass({
    GTypeName: 'ClaudeUsageButton',
}, class ClaudeUsageButton extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.5, 'Claude Usage');

        this._extensionObject = extensionObject;
        this._settings = extensionObject.getSettings();
        this._soupSession = new Soup.Session();
        this._refreshTimeoutId = null;
        this._backoffTimeoutId = null;
        this._lastData = null;

        // Top bar layout
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box claude-usage-panel',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Icon (Claude logo)
        let iconFile = Gio.File.new_for_path(
            GLib.build_filenamev([extensionObject.path, 'icons', 'claude-symbolic.svg'])
        );
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({ file: iconFile }),
            style_class: 'system-status-icon',
            icon_size: 16,
        });
        this._panelBox.add_child(this._icon);

        // Labels for each metric
        this._fiveHourLabel = new St.Label({
            style_class: 'claude-usage-label',
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._panelBox.add_child(this._fiveHourLabel);

        this._separatorLabel1 = new St.Label({
            style_class: 'claude-usage-separator',
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._panelBox.add_child(this._separatorLabel1);

        this._sevenDayLabel = new St.Label({
            style_class: 'claude-usage-label',
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._panelBox.add_child(this._sevenDayLabel);

        this._separatorLabel2 = new St.Label({
            style_class: 'claude-usage-separator',
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._panelBox.add_child(this._separatorLabel2);

        this._resetLabel = new St.Label({
            style_class: 'claude-usage-label claude-usage-reset',
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._panelBox.add_child(this._resetLabel);

        this.add_child(this._panelBox);

        // Dropdown menu
        this._buildMenu();

        // Fetch data now and start timer
        this._fetchUsage();
        this._initTimer();

        // Refresh on menu open (skip if backing off from rate limit)
        this.menu.connect('open-state-changed', (_self, isOpen) => {
            if (isOpen && !this._backoffTimeoutId) this._fetchUsage();
        });

        // Listen for settings changes
        this._settingsChangedId = this._settings.connect('changed::refresh-interval', () => {
            this._destroyTimer();
            this._initTimer();
        });
    }

    _buildMenu() {
        // Detail items in the dropdown
        this._menuFiveHour = new PopupMenu.PopupMenuItem('5h window: …');
        this._menuFiveHour.setSensitive(false);
        this.menu.addMenuItem(this._menuFiveHour);

        this._menuSevenDay = new PopupMenu.PopupMenuItem('7d window: …');
        this._menuSevenDay.setSensitive(false);
        this.menu.addMenuItem(this._menuSevenDay);

        this._menuSonnet = new PopupMenu.PopupMenuItem('');
        this._menuSonnet.setSensitive(false);
        this._menuSonnet.actor.hide();
        this.menu.addMenuItem(this._menuSonnet);

        this._menuReset = new PopupMenu.PopupMenuItem('Resets: …');
        this._menuReset.setSensitive(false);
        this.menu.addMenuItem(this._menuReset);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh button
        let refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        refreshItem.connect('activate', () => this._fetchUsage());
        this.menu.addMenuItem(refreshItem);

        // Open claude.ai
        let openItem = new PopupMenu.PopupMenuItem('Open claude.ai/settings/usage');
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://claude.ai/settings/usage', null);
        });
        this.menu.addMenuItem(openItem);

        // Preferences
        let prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => {
            this._extensionObject.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    _initTimer() {
        let interval = this._settings.get_int('refresh-interval');
        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._fetchUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _destroyTimer() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
    }

    _getOAuthToken() {
        // First try settings (manual override)
        let settingsToken = this._settings.get_string('session-key');
        if (settingsToken && settingsToken.length > 0)
            return settingsToken;

        // Then try Claude Code credentials file
        try {
            let file = Gio.File.new_for_path(CREDENTIALS_PATH);
            let [ok, contents] = file.load_contents(null);
            if (ok) {
                let decoder = new TextDecoder();
                let json = JSON.parse(decoder.decode(contents));
                let token = json?.claudeAiOauth?.accessToken;
                if (token) return token;
            }
        } catch (e) {
            // File doesn't exist or isn't readable
        }

        return null;
    }

    _fetchUsage() {
        let token = this._getOAuthToken();
        if (!token) {
            this._setError('No token');
            return;
        }

        let message = Soup.Message.new('GET', USAGE_API);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    let bytes = session.send_and_read_finish(result);
                    let status = message.status_code;

                    if (status === 429) {
                        this._handleRateLimit(message);
                        return;
                    }

                    if (status !== 200) {
                        this._setError(`HTTP ${status}`);
                        return;
                    }

                    let decoder = new TextDecoder();
                    let text = decoder.decode(bytes.get_data());
                    let data = JSON.parse(text);
                    this._lastData = data;
                    this._updateDisplay(data);
                } catch (e) {
                    this._setError('Error');
                    log(`[Claude Usage] Fetch error: ${e.message}`);
                }
            }
        );
    }

    _handleRateLimit(message) {
        // Parse Retry-After header (seconds), default to 60s
        let retryAfter = 60;
        let retryHeader = message.response_headers.get_one('Retry-After');
        if (retryHeader) {
            let parsed = parseInt(retryHeader, 10);
            if (!isNaN(parsed) && parsed > 0)
                retryAfter = Math.min(parsed, 600);
        }

        // Pause the regular timer and schedule a one-shot retry
        this._destroyTimer();
        if (this._backoffTimeoutId) {
            GLib.source_remove(this._backoffTimeoutId);
            this._backoffTimeoutId = null;
        }
        this._backoffTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            retryAfter,
            () => {
                this._backoffTimeoutId = null;
                this._fetchUsage();
                this._initTimer();
                return GLib.SOURCE_REMOVE;
            }
        );

        // Show cached data if available, otherwise show error
        if (this._lastData) {
            this._updateDisplay(this._lastData);
        } else {
            this._setError('Rate limited');
        }
    }

    _updateDisplay(data) {
        let fiveHour = data.five_hour;
        let sevenDay = data.seven_day;
        let sonnet = data.seven_day_sonnet;

        // Top bar labels
        let fh = fiveHour ? Math.round(fiveHour.utilization) : 0;
        let sd = sevenDay ? Math.round(sevenDay.utilization) : 0;

        this._fiveHourLabel.set_text(`5h ${fh}%`);
        this._sevenDayLabel.set_text(`7d ${sd}%`);

        // Time remaining until 5h window resets
        if (fiveHour?.resets_at) {
            let resetTime = new Date(fiveHour.resets_at).getTime();
            let now = Date.now();
            let remaining = Math.max(0, resetTime - now);
            this._resetLabel.set_text(`↻ ${this._formatDuration(remaining)}`);
        } else {
            this._resetLabel.set_text('↻ --');
        }

        // Color coding based on usage
        this._updateColors(fh, sd);

        // Dropdown menu details
        this._menuFiveHour.label.set_text(`5h window: ${fh}% used`);
        this._menuSevenDay.label.set_text(`7d window: ${sd}% used`);

        if (sonnet?.utilization != null) {
            this._menuSonnet.label.set_text(`Sonnet 7d: ${Math.round(sonnet.utilization)}% used`);
            this._menuSonnet.actor.show();
        } else {
            this._menuSonnet.actor.hide();
        }

        if (fiveHour?.resets_at) {
            let resetDate = new Date(fiveHour.resets_at);
            let hours = resetDate.getHours().toString().padStart(2, '0');
            let minutes = resetDate.getMinutes().toString().padStart(2, '0');
            this._menuReset.label.set_text(`5h resets at ${hours}:${minutes}`);
        }
    }

    _updateColors(fiveHourPct, sevenDayPct) {
        this._colorLabel(this._fiveHourLabel, fiveHourPct);
        this._colorLabel(this._sevenDayLabel, sevenDayPct);
    }

    _colorLabel(label, pct) {
        label.remove_style_class_name('claude-usage-label-warning');
        label.remove_style_class_name('claude-usage-label-high');
        label.remove_style_class_name('claude-usage-label-critical');

        if (pct >= 90)
            label.add_style_class_name('claude-usage-label-critical');
        else if (pct >= 80)
            label.add_style_class_name('claude-usage-label-high');
        else if (pct >= 60)
            label.add_style_class_name('claude-usage-label-warning');
    }

    _formatDuration(ms) {
        let totalSeconds = Math.floor(ms / 1000);
        let hours = Math.floor(totalSeconds / 3600);
        let minutes = Math.floor((totalSeconds % 3600) / 60);

        if (hours > 0)
            return `${hours}h ${minutes}m`;
        else
            return `${minutes}m`;
    }

    _setError(msg) {
        this._fiveHourLabel.set_text('--');
        this._sevenDayLabel.set_text('--');
        this._resetLabel.set_text(msg);

        this._colorLabel(this._fiveHourLabel, 0);
        this._colorLabel(this._sevenDayLabel, 0);
    }

    destroy() {
        this._destroyTimer();

        if (this._backoffTimeoutId) {
            GLib.source_remove(this._backoffTimeoutId);
            this._backoffTimeoutId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._addButton();

        this._positionChangedId = this._settings.connect('changed::position-in-panel', () => {
            this._removeButton();
            this._addButton();
        });
    }

    _addButton() {
        claudeMenu = new ClaudeUsageButton(this);
        let position = this._settings.get_string('position-in-panel');
        let pos = position === 'left' ? -1 : (position === 'center' ? -1 : 0);
        let box = position === 'left' ? 'left' : (position === 'center' ? 'center' : 'right');
        Main.panel.addToStatusArea('claude-usage', claudeMenu, pos, box);
    }

    _removeButton() {
        if (claudeMenu) {
            claudeMenu.destroy();
            claudeMenu = null;
        }
    }

    disable() {
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        this._removeButton();
        this._settings = null;
    }
}
