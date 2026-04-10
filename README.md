# Blue Star AC

Homebridge platform plugin for Blue Star Smart AC devices using the local UDP protocol discovered from the Android app.

## Custom Picker

The plugin now includes a Homebridge Config UI X custom picker backed by your Blue Star account.

From the plugin settings page you can:

- enter account credentials
- discover ACs from the Blue Star account live
- pick the ACs Homebridge should import
- save the selected devices into the platform config

Advanced per-device overrides still live in the platform config for users who want to tune names, IPs, supported modes, or UDP framing.

## What This Plugin Supports

Verified against a live Blue Star AC over local UDP:

- Power on/off
- Cool / Heat / Auto modes
- Current temperature
- Target temperature
- Fan speed
- Swing on/off
- Temperature unit switching

State sync:

- subscribes to Blue Star MQTT reported-state and presence topics when cloud login is configured
- requests a refresh from the AC every 5 seconds via MQTT force-sync so Homebridge can recover if a push update is missed
- still listens for local UDP broadcasts and prefers those whenever the AC talks on the LAN

Not exposed because they are either unverified, risky, or a poor HomeKit fit:

- Fan mode
- Dry mode
- Display, Turbo, AI Pro+, E-Save, Eco, Health, and Mute toggles
- I Feel
- Cleaning cycles
- Filter reset
- Locks and temperature limits
- I-Rest
- Scheduler, sleep presets, trends, budget, BluProtect

## HomeKit Mapping

Native HomeKit HVAC:

- `HeaterCooler`: power, cool/heat/auto, current temperature, target temperature, fan speed, swing, display units

## Config

This plugin is now a Homebridge platform plugin.

```json
{
  "platform": "BlueStarAcPlatform",
  "name": "Blue Star AC",
  "authId": "your-login-id",
  "password": "your-password",
  "selectedThingIds": ["your-thing-id"],
  "devices": [
    {
      "thingId": "your-thing-id",
      "name": "Living Room AC",
      "ip": "192.168.1.25",
      "supportedModes": ["cool", "heat", "auto"]
    }
  ]
}
```

### Device Selection

- `selectedThingIds` contains the ACs selected in the custom picker
- `devices[]` can override names, IPs, supported modes, or UDP framing for specific ACs
- if cloud login is configured but no ACs are selected, the plugin refuses to import anything until at least one device is chosen

### Local-Only Setup

If you do not want cloud discovery, provide devices manually:

```json
{
  "platform": "BlueStarAcPlatform",
  "name": "Blue Star AC",
  "devices": [
    {
      "thingId": "your-thing-id",
      "uat": "your-device-uat",
      "name": "Bedroom AC",
      "ip": "192.168.1.40"
    }
  ]
}
```

## Notes

- `uat` is a device token, not your account password.
- If `ip` is omitted, the plugin can learn it from a UDP state packet, but commands will not work until the AC talks first on the LAN.
- Blue Star mode changes use a nested payload over local UDP. This plugin sends the app-style payload shape for mode switching.
- The periodic refresh loop uses Blue Star's MQTT `fpsh` control message. I have not found a documented local UDP "query state now" command in the decrypted app.
