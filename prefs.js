import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings();

        // --- Authentication Page ---
        let authPage = new Adw.PreferencesPage({
            title: 'Authentication',
            icon_name: 'dialog-password-symbolic',
        });
        window.add(authPage);

        let authGroup = new Adw.PreferencesGroup({
            title: 'OAuth Token',
            description: 'The extension auto-reads your token from ~/.claude/.credentials.json (Claude Code). Only set this manually if auto-detection fails.',
        });
        authPage.add(authGroup);

        // Auto-detect status
        let autoStatus = this._checkAutoDetect();
        let statusRow = new Adw.ActionRow({
            title: 'Auto-detect',
            subtitle: autoStatus.found
                ? `Found token (${autoStatus.prefix}…)`
                : 'No Claude Code credentials found',
        });
        let statusIcon = new Gtk.Image({
            icon_name: autoStatus.found ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        statusRow.add_suffix(statusIcon);
        authGroup.add(statusRow);

        // Manual token entry
        let tokenRow = new Adw.EntryRow({
            title: 'Manual token (optional)',
            show_apply_button: true,
        });
        tokenRow.set_text(settings.get_string('session-key'));
        tokenRow.connect('apply', () => {
            settings.set_string('session-key', tokenRow.get_text());
        });
        authGroup.add(tokenRow);

        // Instructions
        let helpGroup = new Adw.PreferencesGroup({
            title: 'How to get your token manually',
            description: '1. Open claude.ai in your browser\n2. Open DevTools (F12) → Application → Cookies\n3. Find the cookie named "sessionKey"\n4. Copy the value (starts with sk-ant-)\n5. Paste it in the field above\n\nOr install Claude Code and log in — the token will be detected automatically.',
        });
        authPage.add(helpGroup);

        // --- Settings Page ---
        let settingsPage = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(settingsPage);

        let displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
        });
        settingsPage.add(displayGroup);

        // Refresh interval
        let refreshRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'How often to fetch usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 600,
                step_increment: 30,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(refreshRow);

        // Position in panel
        let positionModel = new Gtk.StringList();
        positionModel.append('left');
        positionModel.append('center');
        positionModel.append('right');

        let positionRow = new Adw.ComboRow({
            title: 'Position in panel',
            subtitle: 'Where to show the indicator',
            model: positionModel,
        });

        let currentPos = settings.get_string('position-in-panel');
        positionRow.set_selected(currentPos === 'left' ? 0 : (currentPos === 'center' ? 1 : 2));
        positionRow.connect('notify::selected', () => {
            let positions = ['left', 'center', 'right'];
            settings.set_string('position-in-panel', positions[positionRow.get_selected()]);
        });
        displayGroup.add(positionRow);
    }

    _checkAutoDetect() {
        try {
            let path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
            let file = Gio.File.new_for_path(path);
            let [ok, contents] = file.load_contents(null);
            if (ok) {
                let decoder = new TextDecoder();
                let json = JSON.parse(decoder.decode(contents));
                let token = json?.claudeAiOauth?.accessToken;
                if (token) {
                    return { found: true, prefix: token.substring(0, 15) };
                }
            }
        } catch (e) {
            // File not found or not readable
        }
        return { found: false };
    }
}
