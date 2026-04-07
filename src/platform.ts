import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig as HomebridgePlatformConfig,
  Service,
} from "homebridge";
import {
  buildCloudHeaders,
  buildManualDeviceConfig,
  CLOUD_LOGIN_URL,
  CLOUD_THINGS_URL,
  findOverrideForThing,
  getAuthType,
  mergeCloudThingWithOverride,
  normalizeOptionalString,
  requestJson,
} from "./bluestar.js";
import { BlueStarAcPlatformAccessory } from "./platformAccessory.js";
import { DEFAULT_PLATFORM_NAME, PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { AccessoryContext, CloudThing, DeviceConfig, PlatformConfig } from "./types.js";
import { UdpRegistry } from "./udpRegistry.js";

interface LoginPayload {
  session?: string;
}

interface ThingsPayload {
  things?: CloudThing[];
}

export class BlueStarAcPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory<AccessoryContext>> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];
  public readonly registry: UdpRegistry;
  public readonly config: PlatformConfig;

  private readonly authId: string;
  private readonly password: string;

  constructor(
    public readonly log: Logger,
    config: HomebridgePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as PlatformConfig;
    this.registry = new UdpRegistry(log);
    this.authId = this.config.authId?.trim() ?? "";
    this.password = this.config.password ?? "";

    this.log.debug("Finished initializing platform:", this.config.name ?? DEFAULT_PLATFORM_NAME);

    this.api.on("didFinishLaunching", () => {
      this.log.debug("Executed didFinishLaunching callback");
      void this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info("Loading accessory from cache:", accessory.displayName);
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  private mergeCachedDeviceState(device: DeviceConfig, cachedDevice?: DeviceConfig): DeviceConfig {
    const currentIp = normalizeOptionalString(device.ip);
    const cachedIp = cachedDevice?.thingId === device.thingId
      ? normalizeOptionalString(cachedDevice.ip)
      : undefined;

    if (!currentIp || currentIp === cachedIp) {
      return {
        ...device,
        ip: cachedIp ?? currentIp,
      };
    }

    return {
      ...device,
      ip: currentIp,
    };
  }

  async discoverDevices(): Promise<void> {
    this.discoveredCacheUUIDs.length = 0;

    try {
      const devices = await this.resolveDevices();

      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.thingId}`);
        this.discoveredCacheUUIDs.push(uuid);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
          const resolvedDevice = this.mergeCachedDeviceState(device, existingAccessory.context.device);
          this.log.info("Restoring existing accessory from cache:", existingAccessory.displayName);
          existingAccessory.context.device = resolvedDevice;
          this.api.updatePlatformAccessories([existingAccessory]);
          new BlueStarAcPlatformAccessory(this, existingAccessory, resolvedDevice);
          continue;
        }

        this.log.info("Adding new accessory:", device.name);
        const accessory = new this.api.platformAccessory<AccessoryContext>(device.name, uuid);
        accessory.context.device = device;
        new BlueStarAcPlatformAccessory(this, accessory, device);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      for (const [uuid, accessory] of this.accessories) {
        if (this.discoveredCacheUUIDs.includes(uuid)) {
          continue;
        }

        this.log.info("Removing existing accessory from cache:", accessory.displayName);
        this.registry.unregister(accessory.context.device.thingId);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Device discovery failed: ${message}`);
    }
  }

  private async resolveDevices(): Promise<DeviceConfig[]> {
    const overrides = this.config.devices ?? [];
    if (this.authId && this.password) {
      return this.resolveCloudDevices(overrides);
    }

    if (overrides.length === 0) {
      throw new Error("Configure cloud login or provide manual devices with thingId and uat");
    }

    return overrides.map((override) => buildManualDeviceConfig(override));
  }

  private async resolveCloudDevices(overrides: PlatformConfig["devices"] = []): Promise<DeviceConfig[]> {
    const loginPayload = await requestJson<LoginPayload>(CLOUD_LOGIN_URL, {
      method: "POST",
      headers: buildCloudHeaders(),
      body: JSON.stringify({
        auth_id: this.authId,
        auth_type: getAuthType(this.authId),
        password: this.password,
      }),
    });

    if (!loginPayload.session) {
      throw new Error("Login response did not include session");
    }

    const thingsPayload = await requestJson<ThingsPayload>(CLOUD_THINGS_URL, {
      method: "GET",
      headers: buildCloudHeaders(loginPayload.session),
    });

    const allThings = Array.isArray(thingsPayload.things) ? thingsPayload.things : [];
    if (allThings.length === 0) {
      throw new Error("No Blue Star devices were returned for this account");
    }

    const selectedThingIds = new Set((this.config.selectedThingIds ?? []).map((value) => value.trim()));
    const selectedThings = allThings.filter((thing) => {
      const thingId = String(thing.thing_id ?? "");
      if (selectedThingIds.has(thingId)) {
        return true;
      }

      return Boolean(findOverrideForThing(thing, overrides));
    });

    if (selectedThings.length === 0) {
      throw new Error("No Blue Star ACs are selected. Open the plugin settings and choose at least one device.");
    }

    return selectedThings.map((thing) => {
      const override = findOverrideForThing(thing, overrides);
      return mergeCloudThingWithOverride(thing, override);
    });
  }
}
