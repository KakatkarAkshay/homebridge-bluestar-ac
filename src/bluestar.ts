import crypto from "node:crypto";
import { PLUGIN_NAME } from "./settings.js";
import { BrokerInfo, CloudThing, DeviceConfig, DeviceState, PlatformDeviceOverride, SupportedModeName } from "./types.js";

export const UDP_PORT = 44542;
export const SOURCE_VALUE = "anlan";
export const CLOUD_BASE_URL = "https://n3on22cp53.execute-api.ap-south-1.amazonaws.com/prod";
export const CLOUD_LOGIN_URL = `${CLOUD_BASE_URL}/auth/login`;
export const CLOUD_THINGS_URL = `${CLOUD_BASE_URL}/things`;
export const CLOUD_REQUEST_TIMEOUT_MS = 15_000;

export const MODE_FAN = 0;
export const MODE_HEAT = 1;
export const MODE_COOL = 2;
export const MODE_DRY = 3;
export const MODE_AUTO = 4;

export const AUTO_FAN_SPEED = 7;
export const SWING_ON_VALUE = 0;
export const SWING_OFF_VALUE = 6;

export const MODE_NAME_TO_VALUE: Record<SupportedModeName, number> = {
  fan: MODE_FAN,
  heat: MODE_HEAT,
  cool: MODE_COOL,
  dry: MODE_DRY,
  auto: MODE_AUTO,
};

export const DEFAULT_SUPPORTED_MODES: SupportedModeName[] = ["cool", "auto"];

export function parseIntSafe(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFloatSafe(value: unknown, fallback = 0): number {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export function celsiusToFahrenheit(value: number): number {
  return (value * 9) / 5 + 32;
}

export function fahrenheitToCelsius(value: number): number {
  return ((value - 32) * 5) / 9;
}

export function toHomeKitTemperature(deviceValue: unknown, temperatureUnit: number): number {
  const numericValue = parseFloatSafe(deviceValue, 24);
  if (temperatureUnit === 1) {
    return roundToHalf(fahrenheitToCelsius(numericValue));
  }

  return roundToHalf(numericValue);
}

export function toDeviceTemperatureString(homeKitValue: number, temperatureUnit: number): string {
  if (temperatureUnit === 1) {
    return `${Math.round(celsiusToFahrenheit(homeKitValue))}.0`;
  }

  return roundToHalf(homeKitValue).toFixed(1);
}

export function fanSpeedToRotation(speed: unknown): number {
  switch (parseIntSafe(speed, AUTO_FAN_SPEED)) {
    case 2:
      return 25;
    case 3:
      return 50;
    case 4:
      return 75;
    case 5:
      return 90;
    case 6:
      return 100;
    case AUTO_FAN_SPEED:
    default:
      return 0;
  }
}

export function rotationToFanSpeed(rotation: number): number {
  if (rotation <= 0) {
    return AUTO_FAN_SPEED;
  }
  if (rotation <= 25) {
    return 2;
  }
  if (rotation <= 50) {
    return 3;
  }
  if (rotation <= 75) {
    return 4;
  }
  if (rotation <= 90) {
    return 5;
  }

  return 6;
}

export function isSwingEnabled(state: DeviceState): boolean {
  return parseIntSafe(state.hswing, SWING_OFF_VALUE) !== SWING_OFF_VALUE
    || parseIntSafe(state.vswing, SWING_OFF_VALUE) !== SWING_OFF_VALUE;
}

export function bufferFromAscii(text: string): Buffer {
  return Buffer.from(text, "ascii");
}

export function makeLocalKey(uat: string): Buffer {
  return bufferFromAscii(uat.slice(0, 16));
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function getAuthType(authId: string): number {
  const trimmed = authId.trim();
  if (/^\d{10}$/.test(trimmed)) {
    return 1;
  }
  if (isEmail(trimmed)) {
    return 0;
  }

  throw new Error("authId must be a 10-digit phone number or valid email address");
}

export function normalizeSupportedModes(rawValue?: SupportedModeName[]): SupportedModeName[] {
  const source = Array.isArray(rawValue) && rawValue.length > 0 ? rawValue : DEFAULT_SUPPORTED_MODES;
  const deduped = new Set<SupportedModeName>();

  for (const value of source) {
    if (MODE_NAME_TO_VALUE[value] !== undefined) {
      deduped.add(value);
    }
  }

  deduped.add("cool");
  return [...deduped];
}

export function decryptLocalPacket(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length <= 16) {
    throw new Error("UDP payload too short");
  }

  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString("ascii").replace(/\0+$/g, "").trim();
}

export function encryptForDeviceAppMode(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const body = Buffer.concat([iv, bufferFromAscii(text)]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return ciphertext.toString("base64");
}

export function encryptForDeviceStandardMode(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(bufferFromAscii(text)), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString("base64");
}

export function extractJsonText(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in packet");
  }

  return text.slice(start, end + 1);
}

export function buildCloudHeaders(sessionId = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-APP-VER": "vhomebridge-bluestar-ac-0.1.0",
    "X-OS-NAME": "Node.js",
    "X-OS-VER": process.version,
    "User-Agent": PLUGIN_NAME,
  };

  if (sessionId) {
    headers["X-APP-SESSION"] = sessionId;
  }

  return headers;
}

export async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      const code = payload && typeof payload === "object" && "code" in payload ? ` (${String(payload.code)})` : "";
      throw new Error(`Cloud API request failed with ${response.status}${code}`);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Cloud API returned non-JSON response");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function modeDefaultTemperature(mode: number, state: DeviceState): string {
  if (state.stemp) {
    return String(state.stemp);
  }

  if (mode === MODE_HEAT) {
    return "25.0";
  }

  if (mode === MODE_DRY) {
    return "24.0";
  }

  return "24.0";
}

function modeDefaultFanSpeed(state: DeviceState): number {
  return parseIntSafe(state.fspd, 3);
}

export function buildModePayload(mode: number, state: DeviceState, overrides: Partial<{ stemp: string; fspd: number }> = {}): Record<string, unknown> {
  return {
    mode: {
      value: mode,
      stemp: overrides.stemp ?? modeDefaultTemperature(mode, state),
      fspd: overrides.fspd ?? modeDefaultFanSpeed(state),
    },
    pow: 1,
  };
}

export function buildAiProPayload(enabled: boolean, state: DeviceState): Record<string, unknown> {
  if (enabled) {
    return {
      ai: {
        value: 1,
        mode: MODE_COOL,
        stemp: modeDefaultTemperature(MODE_COOL, state),
        fspd: AUTO_FAN_SPEED,
      },
      pow: 1,
    };
  }

  return {
    ai: {
      value: 0,
      fspd: modeDefaultFanSpeed(state),
    },
    pow: 1,
  };
}

export function buildEcoPayload(enabled: boolean, state: DeviceState): Record<string, unknown> {
  if (enabled) {
    return {
      eco: {
        value: 1,
      },
      pow: 1,
    };
  }

  return {
    eco: {
      value: 0,
      fspd: modeDefaultFanSpeed(state),
    },
    pow: 1,
  };
}

export function applyOptimisticDelta(state: DeviceState, delta: Record<string, unknown>): DeviceState {
  const nextState: DeviceState = { ...state };

  for (const [key, value] of Object.entries(delta)) {
    if (key === "mode" && value && typeof value === "object") {
      const modePayload = value as Record<string, unknown>;
      nextState.mode = parseIntSafe(modePayload.value, nextState.mode);
      nextState.stemp = String(modePayload.stemp ?? nextState.stemp);
      nextState.fspd = parseIntSafe(modePayload.fspd, nextState.fspd);
      continue;
    }

    if (key === "ai" && value && typeof value === "object") {
      const aiPayload = value as Record<string, unknown>;
      nextState.ai = parseIntSafe(aiPayload.value, nextState.ai);
      if (aiPayload.mode !== undefined) {
        nextState.mode = parseIntSafe(aiPayload.mode, nextState.mode);
      }
      if (aiPayload.stemp !== undefined) {
        nextState.stemp = String(aiPayload.stemp);
      }
      if (aiPayload.fspd !== undefined) {
        nextState.fspd = parseIntSafe(aiPayload.fspd, nextState.fspd);
      }
      continue;
    }

    if (key === "eco" && value && typeof value === "object") {
      const ecoPayload = value as Record<string, unknown>;
      nextState.eco = parseIntSafe(ecoPayload.value, nextState.eco);
      if (ecoPayload.fspd !== undefined) {
        nextState.fspd = parseIntSafe(ecoPayload.fspd, nextState.fspd);
      }
      continue;
    }

    if (key in nextState) {
      (nextState as Record<string, unknown>)[key] = value;
    }
  }

  return nextState;
}

export function buildDesiredEnvelope(uat: string, delta: Record<string, unknown>): string {
  return JSON.stringify({
    type: 1,
    uat,
    state: {
      desired: {
        ...delta,
        src: SOURCE_VALUE,
        ts: Date.now(),
      },
    },
  });
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf8").trim();
}

export function parseBrokerInfo(rawValue?: string): BrokerInfo | undefined {
  const normalized = normalizeOptionalString(rawValue);
  if (!normalized) {
    return undefined;
  }

  let decoded = normalized;
  try {
    const base64Decoded = decodeBase64Utf8(normalized);
    if (base64Decoded.includes("::")) {
      decoded = base64Decoded;
    }
  } catch {
    decoded = normalized;
  }

  const parts = decoded.split("::").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    throw new Error("Broker info is malformed");
  }

  const endpoint = parts[0];
  const accessKeyId = parts[1];
  const secretAccessKey = parts[2];
  const sessionToken = normalizeOptionalString(parts[3]);
  const regionMatch = endpoint.match(/\.iot\.([a-z0-9-]+)\.amazonaws\.com$/i);
  const region = regionMatch?.[1] ?? "ap-south-1";

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Broker info is incomplete");
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
  };
}

export function mergeCloudThingWithOverride(thing: CloudThing, override?: PlatformDeviceOverride): DeviceConfig {
  const thingId = override?.thingId ?? String(thing.thing_id ?? "");
  const uat = override?.uat ?? String(thing.user_config?.uat ?? "");
  const cloudName = String(thing.user_config?.name ?? "");
  const deviceName = override?.deviceName ?? cloudName;
  const name = override?.name ?? (cloudName || thingId);

  if (!thingId) {
    throw new Error("Cloud device is missing thing_id");
  }
  if (!uat) {
    throw new Error(`Cloud device '${name}' is missing user_config.uat`);
  }

  return {
    name,
    thingId,
    uat,
    ip: normalizeOptionalString(override?.ip),
    deviceName,
    sendMode: override?.sendMode ?? "app",
    supportedModes: normalizeSupportedModes(override?.supportedModes),
  };
}

export function buildManualDeviceConfig(override: PlatformDeviceOverride): DeviceConfig {
  const thingId = override.thingId?.trim() ?? "";
  const uat = override.uat?.trim() ?? "";
  const name = override.name?.trim() || override.deviceName?.trim() || thingId;

  if (!thingId || !uat) {
    throw new Error("Manual device entries require both thingId and uat");
  }

  return {
    name,
    thingId,
    uat,
    ip: normalizeOptionalString(override.ip),
    deviceName: normalizeOptionalString(override.deviceName),
    sendMode: override.sendMode ?? "app",
    supportedModes: normalizeSupportedModes(override.supportedModes),
  };
}

export function findOverrideForThing(thing: CloudThing, overrides: PlatformDeviceOverride[]): PlatformDeviceOverride | undefined {
  const thingId = String(thing.thing_id ?? "");
  const cloudName = normalizeName(String(thing.user_config?.name ?? ""));

  return overrides.find((override) => {
    if (override.thingId && override.thingId === thingId) {
      return true;
    }
    if (override.deviceName && normalizeName(override.deviceName) === cloudName) {
      return true;
    }
    return false;
  });
}
