export type SupportedModeName = "cool" | "heat" | "auto" | "fan" | "dry";
export type SendMode = "app" | "standard";

export interface DeviceState {
  pow: number;
  mode: number;
  stemp: string;
  ctemp: string;
  fspd: number;
  hswing: number;
  vswing: number;
  display: number;
  displayunit: number;
  turbo: number;
  ai: number;
  esave: number;
  eco: number;
  health: number;
  m_buz: number;
  ifeel: number;
  climate: number;
  s_clean: number;
  df_clean: number;
  lastSeenAt: number;
  source: string;
  [key: string]: unknown;
}

export interface DeviceConfig {
  name: string;
  thingId: string;
  uat: string;
  ip?: string;
  deviceName?: string;
  sendMode: SendMode;
  supportedModes: SupportedModeName[];
}

export interface PlatformDeviceOverride {
  thingId?: string;
  deviceName?: string;
  name?: string;
  ip?: string;
  uat?: string;
  sendMode?: SendMode;
  supportedModes?: SupportedModeName[];
}

export interface PlatformConfig {
  platform: string;
  name?: string;
  authId?: string;
  password?: string;
  selectedThingIds?: string[];
  devices?: PlatformDeviceOverride[];
}

export interface CloudThing {
  thing_id?: string;
  user_config?: {
    uat?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UdpAccessoryBinding {
  readonly thingId: string;
  readonly ipAddress?: string;
  readonly sendMode: SendMode;
  readonly localKey: Buffer;
  handleLocalState(packet: Record<string, unknown>, sourceIp?: string): void;
}

export interface AccessoryContext {
  device: DeviceConfig;
}
