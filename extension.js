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

        // One block per metric: colored percentage + dim reset countdown
        this._fiveHour = this._createMetric();
        this._panelBox.add_child(this._fiveHour.box);

        this._separator1 = this._createSeparator();
        this._panelBox.add_child(this._separator1);

        this._sevenDay = this._createMetric();
        this._panelBox.add_child(this._sevenDay.box);

        // Separator + scoped-model block are shown only when the API returns
        // a per-model (weekly_scoped) limit, e.g. Fable / Opus / Sonnet.
        this._separator2 = this._createSeparator();
        this._panelBox.add_child(this._separator2);

        this._scoped = this._createMetric();
        this._panelBox.add_child(this._scoped.box);
        this._separator2.hide();
        this._scoped.box.hide();

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

    _createMetric() {
        let box = new St.BoxLayout({
            style_class: 'claude-usage-metric',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        let value = new St.Label({
            style_class: 'claude-usage-label',
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        let reset = new St.Label({
            style_class: 'claude-usage-label claude-usage-reset',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        box.add_child(value);
        box.add_child(reset);
        return { box, value, reset };
    }

    _createSeparator() {
        return new St.Label({
            style_class: 'claude-usage-separator',
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
    }

    _buildMenu() {
        // Usage percentages
        this._menuFiveHour = new PopupMenu.PopupMenuItem('5h window: …');
        this._menuFiveHour.setSensitive(false);
        this.menu.addMenuItem(this._menuFiveHour);

        this._menuSevenDay = new PopupMenu.PopupMenuItem('7d window: …');
        this._menuSevenDay.setSensitive(false);
        this.menu.addMenuItem(this._menuSevenDay);

        this._menuScoped = new PopupMenu.PopupMenuItem('');
        this._menuScoped.setSensitive(false);
        this._menuScoped.actor.hide();
        this.menu.addMenuItem(this._menuScoped);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Reset times (countdown + exact clock time)
        this._menuFiveHourReset = new PopupMenu.PopupMenuItem('5h resets: …');
        this._menuFiveHourReset.setSensitive(false);
        this.menu.addMenuItem(this._menuFiveHourReset);

        this._menuSevenDayReset = new PopupMenu.PopupMenuItem('7d resets: …');
        this._menuSevenDayReset.setSensitive(false);
        this.menu.addMenuItem(this._menuSevenDayReset);

        this._menuScopedReset = new PopupMenu.PopupMenuItem('');
        this._menuScopedReset.setSensitive(false);
        this._menuScopedReset.actor.hide();
        this.menu.addMenuItem(this._menuScopedReset);

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
        let scoped = this._findScopedLimit(data);

        let fh = fiveHour ? Math.round(fiveHour.utilization) : 0;
        let sd = sevenDay ? Math.round(sevenDay.utilization) : 0;

        // Panel blocks: 5h and 7d each with their own reset countdown
        this._setMetric(this._fiveHour, '5h', fh, fiveHour?.resets_at);
        this._setMetric(this._sevenDay, '7d', sd, sevenDay?.resets_at);

        let scopedName = null;
        if (scoped) {
            scopedName = scoped.scope?.model?.display_name || 'Model';
            this._setMetric(this._scoped, scopedName, Math.round(scoped.percent), scoped.resets_at);
            this._scoped.box.show();
            this._separator2.show();
        } else {
            this._scoped.box.hide();
            this._separator2.hide();
        }

        // Dropdown: usage percentages
        this._menuFiveHour.label.set_text(`5h window: ${fh}% used`);
        this._menuSevenDay.label.set_text(`7d window: ${sd}% used`);

        if (scoped) {
            this._menuScoped.label.set_text(`${scopedName} 7d: ${Math.round(scoped.percent)}% used`);
            this._menuScoped.actor.show();
        } else {
            this._menuScoped.actor.hide();
        }

        // Dropdown: reset times (countdown + exact clock time)
        this._menuFiveHourReset.label.set_text(this._formatResetLine('5h', fiveHour?.resets_at));
        this._menuSevenDayReset.label.set_text(this._formatResetLine('7d', sevenDay?.resets_at));

        if (scoped) {
            this._menuScopedReset.label.set_text(this._formatResetLine(scopedName, scoped.resets_at));
            this._menuScopedReset.actor.show();
        } else {
            this._menuScopedReset.actor.hide();
        }
    }

    _findScopedLimit(data) {
        let limits = Array.isArray(data.limits) ? data.limits : [];
        let scoped = limits.filter(
            l => l && l.kind === 'weekly_scoped' && l.resets_at != null
        );
        if (scoped.length === 0)
            return null;
        // If several per-model limits exist, surface the most critical one.
        return scoped.reduce((a, b) => (b.percent > a.percent ? b : a));
    }

    _setMetric(metric, prefix, pct, resetsAt) {
        metric.value.set_text(`${prefix} ${pct}%`);
        this._colorLabel(metric.value, pct);

        if (resetsAt) {
            let remaining = Math.max(0, new Date(resetsAt).getTime() - Date.now());
            metric.reset.set_text(`↻${this._formatDurationCompact(remaining)}`);
            metric.reset.show();
        } else {
            metric.reset.set_text('');
            metric.reset.hide();
        }
    }

    _formatResetLine(prefix, resetsAt) {
        if (!resetsAt)
            return `${prefix} resets: --`;
        let date = new Date(resetsAt);
        let remaining = Math.max(0, date.getTime() - Date.now());
        let hours = date.getHours().toString().padStart(2, '0');
        let minutes = date.getMinutes().toString().padStart(2, '0');
        return `${prefix} resets in ${this._formatDuration(remaining)} (${hours}:${minutes})`;
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

    _formatDurationCompact(ms) {
        let totalSeconds = Math.floor(ms / 1000);
        let hours = Math.floor(totalSeconds / 3600);
        let minutes = Math.floor((totalSeconds % 3600) / 60);

        if (hours > 0 && minutes > 0)
            return `${hours}h${minutes}m`;
        else if (hours > 0)
            return `${hours}h`;
        else
            return `${minutes}m`;
    }

    _setError(msg) {
        this._fiveHour.value.set_text('5h --');
        this._sevenDay.value.set_text('7d --');
        this._colorLabel(this._fiveHour.value, 0);
        this._colorLabel(this._sevenDay.value, 0);

        this._fiveHour.reset.set_text(msg);
        this._fiveHour.reset.show();
        this._sevenDay.reset.set_text('');
        this._sevenDay.reset.hide();

        this._scoped.box.hide();
        this._separator2.hide();
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
